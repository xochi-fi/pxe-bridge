import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  recoverReadinessSigner,
  verifyReadinessRecord,
  type Hex,
  type NetworkIdentity,
  type ReadinessDomainInputs,
} from "@xochi/signer";
import { AllowlistTree } from "../src/allowlist-tree.js";
import {
  AttestationParamsSchema,
  AttestationProducer,
  RecipientDescriptorSchema,
  RootUpdateEnvelopeSchema,
  RootUpdatePublisher,
  readAttestationEnvironment,
  type AttestationChainProbe,
  type AttestationObservation,
  type FinalizedAttestationObservation,
} from "../src/attestation.js";
import {
  Secp256k1ReadinessSigner,
  type ReadinessSigner,
} from "../src/attestation-secret.js";
import { openBoundJournal } from "./settlement-fixtures.js";

import { createApp } from "../src/server.js";
import { FakeAztecClient } from "./settlement-fixtures.js";
const FixtureSchema = z.object({
  descriptor: z.object({
    vectors: z.array(
      z.object({
        name: z.string(),
        descriptor: RecipientDescriptorSchema,
        descriptorDigest: z.string(),
      }),
    ),
  }),
  recipientMessage: z.object({
    bindingMessages: z.array(
      z.object({
        name: z.string(),
        digest: z.string(),
        signature: z.string(),
      }),
    ),
  }),
});

const fixture = FixtureSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../vendor/xochi-sdk/6626f545eade7e6a4226cb7be69f6196fd98f105/shielded-recipient.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const descriptorVector = fixture.descriptor.vectors.find(
  ({ name }) => name === "aztec-6.0.0-stock",
)!;
const bindingVector = fixture.recipientMessage.bindingMessages.find(
  ({ name }) => name === "aztec-6.0.0-stock binding",
)!;
const descriptor = descriptorVector.descriptor;
const descriptorDigest = descriptorVector.descriptorDigest.toLowerCase();
const recipient = descriptor.aztecAddress;
const MANIFEST = "0x" + "4d".repeat(32);
const SEED = "0x" + "12".repeat(32);
const NOW = 1_800_000_000;
const SIGNER_KEY = "0x" + "31".repeat(32);

class Probe implements AttestationChainProbe {
  calls = 0;
  constructor(public observation: AttestationObservation) {}

  async observeAttestationChain(
    _recipient: string | undefined,
    _genesisOrNetworkDigest: string,
  ): Promise<AttestationObservation> {
    this.calls += 1;
    return this.observation;
  }
}

function known(
  network: NetworkIdentity,
  root: string,
  deployment: FinalizedAttestationObservation["recipientDeployment"] = {
    state: "present",
    classId: descriptor.classId,
    initialized: true,
  },
): AttestationObservation {
  return {
    state: "known",
    value: {
      network,
      finalized: {
        blockNumber: "7",
        blockHash: "0x" + "ab".repeat(32),
        timestamp: String(NOW - 10),
      },
      allowlistRoot: root,
      ...(deployment ? { recipientDeployment: deployment } : {}),
    },
  };
}

function params(overrides: Record<string, unknown> = {}) {
  return AttestationParamsSchema.parse({
    descriptor,
    descriptorDigest,
    recipient,
    bindingAuthorization: {
      bindingDigest: bindingVector.digest,
      signature: bindingVector.signature,
    },
    ...overrides,
  });
}

async function setup(recipients: readonly { address: string; index: number }[]) {
  const tree = await AllowlistTree.build(SEED, recipients);
  const journal = openBoundJournal();
  journal.recordAllowlistSnapshot(tree.root.toString(), recipients);
  const signer = new Secp256k1ReadinessSigner(SIGNER_KEY);
  const probe = new Probe(known(descriptor.network, tree.root.toString()));
  const producer = new AttestationProducer({
    probe,
    journal,
    allowlistTree: tree,
    signer,
    domain: {
      sourceChainId: "84532",
      environment: "staging",
      manifestDigest: MANIFEST,
      genesisOrNetworkDigest: descriptor.network.genesisOrNetworkDigest,
    },
    now: () => NOW,
  });
  return { tree, journal, signer, probe, producer };
}

const policyDomain: ReadinessDomainInputs = {
  sourceChainId: "84532",
  environment: "staging",
  network: descriptor.network,
  manifestDigest: MANIFEST,
};

function expectRefusal(result: { status: string; reason?: string }, reason: string): void {
  expect(result).toEqual({ status: "refused", reason });
  expect(result).not.toHaveProperty("record");
  expect(result).not.toHaveProperty("signature");
}

describe("readiness attestation producer", () => {
  it("signs authoritative membership and deployment through the exact SDK verifier", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    try {
      const membership = await ctx.producer.attestMembership(params());
      expect(membership.status).toBe("signed");
      if (membership.status !== "signed") throw new Error("membership refused");
      expect(
        verifyReadinessRecord("Membership", membership.record, {
          domain: policyDomain,
          expectedSigner: ctx.signer.address,
          expected: { descriptorDigest },
          now: NOW,
          maxAgeSeconds: 7_200,
          maxFutureSkewSeconds: 300,
          minBlock: "7",
        }).signer,
      ).toBe(ctx.signer.address);
      const trustedDomain = ctx.producer.domainFor(descriptor.network);
      expect(
        recoverReadinessSigner("Membership", membership.record, {
          ...trustedDomain,
          chainId: "1",
        }),
      ).not.toBe(ctx.signer.address);
      expect(() =>
        recoverReadinessSigner(
          "RecipientDeployment",
          membership.record as never,
          trustedDomain,
        ),
      ).toThrow();

      const deployment = await ctx.producer.attestRecipientDeployment(params());
      expect(deployment.status).toBe("signed");
      if (deployment.status !== "signed") throw new Error("deployment refused");
      expect(
        verifyReadinessRecord("RecipientDeployment", deployment.record, {
          domain: policyDomain,
          expectedSigner: ctx.signer.address,
          expected: { descriptorDigest, recipient, classId: descriptor.classId },
          now: NOW,
          maxAgeSeconds: 7_200,
          maxFutureSkewSeconds: 300,
          minBlock: "7",
        }).signer,
      ).toBe(ctx.signer.address);
    } finally {
      ctx.journal.close();
    }
  });

  it("signs negative observations only after authoritative absence", async () => {
    const ctx = await setup([]);
    try {
      ctx.probe.observation = known(descriptor.network, ctx.tree.root.toString(), {
        state: "absent",
      });
      const membership = await ctx.producer.attestMembership(params());
      expect(membership).toMatchObject({ status: "signed", record: { member: false } });
      if (membership.status !== "signed") throw new Error("membership refused");
      expect(
        recoverReadinessSigner(
          "Membership",
          membership.record,
          ctx.producer.domainFor(descriptor.network),
        ),
      ).toBe(ctx.signer.address);

      const deployment = await ctx.producer.attestRecipientDeployment(params());
      expect(deployment).toMatchObject({ status: "signed", record: { deployed: false } });
      if (deployment.status !== "signed") throw new Error("deployment refused");
      expect(
        recoverReadinessSigner(
          "RecipientDeployment",
          deployment.record,
          ctx.producer.domainFor(descriptor.network),
        ),
      ).toBe(ctx.signer.address);
    } finally {
      ctx.journal.close();
    }
  });

  it.each([
    ["descriptor digest", { descriptorDigest: "0x" + "01".repeat(32) }, "descriptor_digest_mismatch"],
    ["recipient", { recipient: "0x" + "02".repeat(32) }, "recipient_mismatch"],
    [
      "descriptor class",
      { descriptor: { ...descriptor, classId: "0x" + "05".repeat(32) } },
      "class_mismatch",
    ],
    [
      "descriptor derivation",
      { descriptor: { ...descriptor, salt: "0x" + "06".repeat(32) } },
      "invalid_descriptor",
    ],
    [
      "binding digest",
      {
        bindingAuthorization: {
          bindingDigest: "0x" + "07".repeat(32),
          signature: bindingVector.signature,
        },
      },
      "binding_authorization_invalid",
    ],
    [
      "binding signature",
      {
        bindingAuthorization: {
          bindingDigest: bindingVector.digest,
          signature: "0x" + "00".repeat(64),
        },
      },
      "binding_authorization_invalid",
    ],
  ])("refuses wrong %s before observation", async (_name, override, reason) => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    try {
      const result = await ctx.producer.attestMembership(params(override));
      expectRefusal(result, reason);
      expect(ctx.probe.calls).toBe(0);
    } finally {
      ctx.journal.close();
    }
  });

  it("returns typed unsigned refusals for history, root, network and class uncertainty", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    try {
      ctx.probe.observation = {
        state: "unknown",
        reason: "finalized_history_unavailable",
      };
      expectRefusal(
        await ctx.producer.attestMembership(params()),
        "finalized_history_unavailable",
      );

      ctx.probe.observation = known(descriptor.network, "0x" + "03".repeat(32));
      expectRefusal(await ctx.producer.attestMembership(params()), "allowlist_root_mismatch");

      ctx.probe.observation = known(
        { ...descriptor.network, l1ChainId: "1" },

        ctx.tree.root.toString(),
      );
      expectRefusal(await ctx.producer.attestMembership(params()), "network_mismatch");

      ctx.probe.observation = known(descriptor.network, ctx.tree.root.toString(), {
        state: "present",
        classId: "0x" + "04".repeat(32),
        initialized: true,
      });
      expectRefusal(
        await ctx.producer.attestRecipientDeployment(params()),
        "class_mismatch",
      );
    } finally {
      ctx.journal.close();
    }
  });

  it("returns a signed negative for authoritative uninitialized state", async () => {
    const ctx = await setup([]);
    try {
      ctx.probe.observation = known(descriptor.network, ctx.tree.root.toString(), {
        state: "present",
        classId: descriptor.classId,
        initialized: false,
      });
      const deployment = await ctx.producer.attestRecipientDeployment(params());
      expect(deployment).toMatchObject({
        status: "signed",
        record: { deployed: false },
      });
    } finally {
      ctx.journal.close();
    }
  });

  it("returns an unsigned refusal when the signer is unavailable", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const unavailable: ReadinessSigner = {
      address: ctx.signer.address,
      async signDigest(_digest: Hex): Promise<Hex> {
        throw new Error("signing service unavailable");
      },
    };
    const producer = new AttestationProducer({
      probe: ctx.probe,
      journal: ctx.journal,
      allowlistTree: ctx.tree,
      signer: unavailable,
      domain: ctx.producer.domainConfig,
      now: () => NOW,
    });
    try {
      expectRefusal(await producer.attestMembership(params()), "signer_failed");
    } finally {
      ctx.journal.close();
    }
  });

  it("emits only privacy-safe audit fields", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const events: unknown[] = [];
    const producer = new AttestationProducer({
      probe: ctx.probe,
      journal: ctx.journal,
      allowlistTree: ctx.tree,
      signer: ctx.signer,
      domain: ctx.producer.domainConfig,
      now: () => NOW,
      audit: (event) => events.push(event),
    });
    try {
      await producer.attestMembership(params());
      const encoded = JSON.stringify(events);
      expect(events).toEqual([
        { method: "aztec_attestMembership", outcome: "signed" },
      ]);
      for (const sensitive of [
        recipient,
        descriptorDigest,
        bindingVector.signature,
        ctx.tree.root.toString(),
      ]) {
        expect(encoded).not.toContain(sensitive);
      }
    } finally {
      ctx.journal.close();
    }
  });

  it("rejects malformed and unknown descriptor fields at the stable schema", () => {
    expect(
      RecipientDescriptorSchema.safeParse({
        ...descriptor,
        signingPublicKeyX: "0x01",
      }).success,
    ).toBe(false);
    expect(
      RecipientDescriptorSchema.safeParse({
        ...descriptor,
        sourceWallet: "0x" + "01".repeat(20),
      }).success,
    ).toBe(false);
  });

  it("strictly excludes source, block and witness selectors", () => {
    for (const field of [
      "sourceWallet",
      "sourceChainId",
      "bindingId",
      "blockNumber",
      "blockHash",
      "finalBlock",
      "rootBlock",
      "witness",
      "recipientWitness",
      "siblingPath",
      "salt",
      "leafSalt",
      "index",
      "leafIndex",
      "unknown",
    ]) {
      expect(AttestationParamsSchema.safeParse({ ...params(), [field]: "forbidden" }).success).toBe(
        false,
      );
    }
  });
  it("keeps the dedicated route hidden when the feature is absent", async () => {
    const server = createApp(new FakeAztecClient());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/attest/rpc`,
        { method: "POST" },
      );
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("isolates the attestation route and credential from RPC and admin", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const server = createApp(new FakeAztecClient(), {
      apiKey: "rpc-key",
      adminKey: "admin-key",
      attestationApiKey: "attest-key",
      attestation: ctx.producer,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "aztec_attestMembership",
      params: params(),
    });
    try {
      const wrong = await fetch(`${url}/attest/rpc`, {
        method: "POST",
        headers: {
          authorization: "Bearer rpc-key",
          "content-type": "application/json",
        },
        body: rpcBody,
      });
      expect(wrong.status).toBe(401);
      const adminWrong = await fetch(`${url}/attest/rpc`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-key",
          "content-type": "application/json",
        },
        body: rpcBody,
      });
      expect(adminWrong.status).toBe(401);

      const correct = await fetch(`${url}/attest/rpc`, {
        method: "POST",
        headers: {
          authorization: "Bearer attest-key",
          "content-type": "application/json",
        },
        body: rpcBody,
      });
      expect(correct.status).toBe(200);
      expect(await correct.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "signed", primaryType: "Membership" },
      });

      const main = await fetch(`${url}/api/rpc`, {
        method: "POST",
        headers: {
          authorization: "Bearer attest-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "aztec_getVersion" }),
      });
      expect(main.status).toBe(401);

      const admin = await fetch(`${url}/admin/resume`, {
        method: "POST",
        headers: {
          authorization: "Bearer attest-key",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(admin.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      ctx.journal.close();
    }
  });
});

describe("attestation configuration and root outbox", () => {
  it("keeps the feature absent and rejects partial or confused credentials", () => {
    expect(readAttestationEnvironment({}, [])).toBeUndefined();
    expect(() =>
      readAttestationEnvironment({ PXE_BRIDGE_ATTESTATION_API_KEY: "only" }, []),
    ).toThrow(/partial/);
    const complete = {
      PXE_BRIDGE_ATTESTATION_API_KEY: "attest",
      PXE_BRIDGE_ATTESTATION_SECRET_KEY: SIGNER_KEY,
      PXE_BRIDGE_ATTESTATION_SOURCE_CHAIN_ID: "84532",
      PXE_BRIDGE_ATTESTATION_ENVIRONMENT: "staging",
      PXE_BRIDGE_ATTESTATION_RELAY_URL: "http://127.0.0.1:9999/root",
      PXE_BRIDGE_ATTESTATION_RELAY_TOKEN: "relay",
    };
    expect(readAttestationEnvironment(complete, ["rpc", "admin"])).toMatchObject({
      apiKey: "attest",
    });
    expect(() => readAttestationEnvironment(complete, ["attest"])).toThrow(/must all differ/);
    expect(() =>
      readAttestationEnvironment(
        { ...complete, PXE_BRIDGE_ALLOWLIST_SEED: SIGNER_KEY },
        [],
      ),
    ).toThrow(/must not reuse/);
    expect(() =>
      readAttestationEnvironment(
        {
          ...complete,
          PXE_BRIDGE_ATTESTATION_SECRET_ARN: "arn:aws:secretsmanager:test",
        },
        [],
      ),
    ).toThrow(/partial/);
    expect(() =>
      readAttestationEnvironment(
        {
          ...complete,
          PXE_BRIDGE_ATTESTATION_RELAY_URL: "http://relay.example/root",
        },
        [],
      ),
    ).toThrow(/HTTPS or loopback/);
    expect(() =>
      readAttestationEnvironment(
        {
          ...complete,
          PXE_BRIDGE_ATTESTATION_RELAY_TOKEN: "outbound",
        },
        ["outbound"],
      ),
    ).toThrow(/must all differ/);
  });

  it("persists before send, retries one payload, and republishes current root after restart", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const received: {
      key: string | undefined;
      authorization: string | undefined;
      body: unknown;
    }[] = [];
    let fail = true;
    const relay = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        received.push({
          key: request.headers["idempotency-key"] as string | undefined,
          authorization: request.headers["authorization"],
          body: JSON.parse(body) as unknown,
        });
        response.writeHead(fail ? 503 : 200).end();
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("relay did not bind");
    const relayOptions = {
      url: `http://127.0.0.1:${address.port}/root`,
      token: "relay-token",
    };
    try {
      const first = new RootUpdatePublisher(
        ctx.producer,
        ctx.probe,
        ctx.journal,
        relayOptions,
      );
      await first.tick();
      expect(ctx.journal.pendingRootUpdates()).toHaveLength(1);
      const original = received[0];
      fail = false;
      await first.tick();
      expect(ctx.journal.pendingRootUpdates()).toHaveLength(0);
      expect(received[1]).toEqual(original);
      expect(original?.authorization).toBe("Bearer relay-token");
      const rootUpdate = RootUpdateEnvelopeSchema.parse(original?.body);
      expect(
        verifyReadinessRecord("RootUpdate", rootUpdate.record, {
          domain: policyDomain,
          expectedSigner: ctx.signer.address,
          expected: { root: ctx.tree.root.toString() },
          now: NOW,
          maxAgeSeconds: 7_200,
          maxFutureSkewSeconds: 300,
          minBlock: "7",
        }).signer,
      ).toBe(ctx.signer.address);

      const restarted = new RootUpdatePublisher(
        ctx.producer,
        ctx.probe,
        ctx.journal,
        relayOptions,
      );
      await restarted.tick();
      expect(received).toHaveLength(3);
      expect(received[2]?.key).toBe(original?.key);
      expect(received[2]?.body).toEqual(original?.body);

      const sameRootNextBlock = known(
        descriptor.network,
        ctx.tree.root.toString(),
      );
      if (sameRootNextBlock.state !== "known") throw new Error("unreachable");
      sameRootNextBlock.value.finalized.blockNumber = "8";
      ctx.probe.observation = sameRootNextBlock;
      await restarted.tick();
      expect(received).toHaveLength(3);

      ctx.probe.observation = known(
        descriptor.network,
        "0x" + "44".repeat(32),
      );
      await restarted.tick();
      expect(received).toHaveLength(4);
      expect(received[3]?.body).toMatchObject({
        primaryType: "RootUpdate",
        record: { root: "0x" + "44".repeat(32) },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        relay.close((error) => (error ? reject(error) : resolve())),
      );
      ctx.journal.close();
    }
  });
});
