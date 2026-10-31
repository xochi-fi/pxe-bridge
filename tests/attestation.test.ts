import { createServer, request, type RequestListener } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  ROOT_UPDATE_REFRESH_SECONDS,
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
      createRequire(import.meta.url).resolve("@xochi/spec/conformance/shielded-recipient.json"),
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
const CORRIDOR_ID = "0x" + "63".repeat(32);
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
    network: descriptor.network,
    corridor: {
      corridorId: CORRIDOR_ID,
      corridorRevision: 1,
      manifestDigest: MANIFEST,
    },
    recipientAuthorization: {
      digest: bindingVector.digest,
      signature: bindingVector.signature,
    },
    ...overrides,
  });
}

async function setup(
  recipients: readonly { address: string; index: number }[],
  now: () => number = () => NOW,
) {
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
      corridorId: CORRIDOR_ID,
      corridorRevision: 1,
      genesisOrNetworkDigest: descriptor.network.genesisOrNetworkDigest,
    },
    now,
  });
  return { tree, journal, signer, probe, producer };
}

const policyDomain: ReadinessDomainInputs = {
  sourceChainId: "84532",
  environment: "staging",
  network: descriptor.network,
  manifestDigest: MANIFEST,
};

function expectRefusal(result: unknown, reason: string): void {
  expect(result).toEqual({ status: "refused", reason });
  expect(result).not.toHaveProperty("record");
  expect(result).not.toHaveProperty("signature");
}

describe("readiness attestation producer", () => {
  it("signs authoritative membership and deployment through the exact SDK verifier", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    try {
      const membership = await ctx.producer.attestMembership(params());
      if ("status" in membership) throw new Error(membership.reason);
      expect(
        verifyReadinessRecord("Membership", membership, {
          domain: policyDomain,
          expectedSigner: ctx.signer.address,
          expected: { descriptorDigest, root: ctx.tree.root.toString() },
          now: NOW,
          maxAgeSeconds: 7_200,
          maxFutureSkewSeconds: 300,
          minBlock: "7",
        }).signer,
      ).toBe(ctx.signer.address);
      const trustedDomain = ctx.producer.domainFor(descriptor.network);
      expect(
        recoverReadinessSigner("Membership", membership, {
          ...trustedDomain,
          chainId: "1",
        }),
      ).not.toBe(ctx.signer.address);
      expect(() =>
        recoverReadinessSigner(
          "RecipientDeployment",
          membership as never,
          trustedDomain,
        ),
      ).toThrow();

      const deployment = await ctx.producer.attestRecipientDeployment(params());
      if ("status" in deployment) throw new Error(deployment.reason);
      expect(
        verifyReadinessRecord("RecipientDeployment", deployment, {
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
      expect(membership).toMatchObject({ member: false });
      if ("status" in membership) throw new Error(membership.reason);
      expect(
        recoverReadinessSigner(
          "Membership",
          membership,
          ctx.producer.domainFor(descriptor.network),
        ),
      ).toBe(ctx.signer.address);

      const deployment = await ctx.producer.attestRecipientDeployment(params());
      expect(deployment).toMatchObject({ deployed: false });
      if ("status" in deployment) throw new Error(deployment.reason);
      expect(
        recoverReadinessSigner(
          "RecipientDeployment",
          deployment,
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
      "request network",
      { network: { ...descriptor.network, l1ChainId: "1" } },
      "network_mismatch",
    ],
    [
      "request corridor",
      {
        corridor: {
          corridorId: CORRIDOR_ID,
          corridorRevision: 2,
          manifestDigest: MANIFEST,
        },
      },
      "corridor_mismatch",
    ],
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
        recipientAuthorization: {
          digest: "0x" + "07".repeat(32),
          signature: bindingVector.signature,
        },
      },
      "binding_authorization_invalid",
    ],
    [
      "binding signature",
      {
        recipientAuthorization: {
          digest: bindingVector.digest,
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

  it.each([
    ["stale", String(NOW - 7_201), "finalized_tip_stale"],
    ["future", String(NOW + 301), "finalized_tip_from_future"],
  ])("refuses a %s finalized observation without signing", async (_name, timestamp, reason) => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    try {
      const observation = known(descriptor.network, ctx.tree.root.toString());
      if (observation.state !== "known") throw new Error("unreachable");
      observation.value.finalized.timestamp = timestamp;
      ctx.probe.observation = observation;
      expectRefusal(await ctx.producer.attestMembership(params()), reason);
      expect(await ctx.producer.rootUpdate(observation.value)).toBeNull();
    } finally {
      ctx.journal.close();
    }
  });

  it.each([
    "account_address_mismatch",
    "account_class_mismatch",
    "account_not_initialized",
  ] as const)("preserves the solver %s refusal without a record", async (reason) => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    try {
      ctx.probe.observation = { state: "unknown", reason };
      expectRefusal(await ctx.producer.attestMembership(params()), reason);
    } finally {
      ctx.journal.close();
    }
  });

  it("refuses signing when the durable snapshot omits another tree mapping", async () => {
    const other = "0x0" + "9".repeat(63);
    const recipients = [
      { address: recipient, index: 137 },
      { address: other, index: 942 },
    ];
    const tree = await AllowlistTree.build(SEED, recipients);
    const journal = openBoundJournal();
    journal.recordAllowlistSnapshot(tree.root.toString(), [recipients[0]!]);
    const signer = new Secp256k1ReadinessSigner(SIGNER_KEY);
    const producer = new AttestationProducer({
      probe: new Probe(known(descriptor.network, tree.root.toString())),
      journal,
      allowlistTree: tree,
      signer,
      domain: {
        sourceChainId: "84532",
        environment: "staging",
        manifestDigest: MANIFEST,
        corridorId: CORRIDOR_ID,
        corridorRevision: 1,
        genesisOrNetworkDigest: descriptor.network.genesisOrNetworkDigest,
      },
      now: () => NOW,
    });
    try {
      expectRefusal(await producer.attestMembership(params()), "membership_uncertain");
    } finally {
      journal.close();
    }
  });

  it("returns a signed negative for authoritative uninitialized recipient state", async () => {
    const ctx = await setup([]);
    try {
      ctx.probe.observation = known(descriptor.network, ctx.tree.root.toString(), {
        state: "present",
        classId: descriptor.classId,
        initialized: false,
      });
      const deployment = await ctx.producer.attestRecipientDeployment(params());
      expect(deployment).toMatchObject({ deployed: false });
      expect(deployment).not.toHaveProperty("status");
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
        { method: "aztec_attestRecipientMembership", outcome: "signed" },
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
        `http://127.0.0.1:${address.port}/api/attestation`,
        { method: "POST" },
      );
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rate limits malformed attestation content", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const server = createApp(new FakeAztecClient(), {
      apiKey: "attest-invalid-rpc-key",
      attestationApiKey: "attest-invalid-key",
      attestation: ctx.producer,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/api/attestation`;
    try {
      for (let i = 0; i < 20; i++) {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: "Bearer attest-invalid-key" },
        });
        expect(response.status).toBe(415);
      }
      for (let i = 0; i < 20; i++) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: "Bearer attest-invalid-key",
            "content-type": "application/json",
          },
          body: "{",
        });
        expect(response.status).toBe(400);
      }
      for (let i = 0; i < 20; i++) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: "Bearer attest-invalid-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "aztec_attestRecipientMembership",
            params: {},
          }),
        });
        expect(response.status).toBe(200);
      }
      const rateLimited = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer attest-invalid-key" },
      });
      expect(rateLimited.status).toBe(429);

      const valid = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer attest-invalid-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "aztec_attestRecipientMembership",
          params: params(),
        }),
      });
      expect(valid.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("shares bounded body intake with the main RPC route", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const server = createApp(new FakeAztecClient(), {
      apiKey: "body-rpc-key",
      recoveryApiKey: "body-recovery-key",
      attestationApiKey: "body-attest-key",
      attestation: ctx.producer,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const held: ReturnType<typeof request>[] = [];
    try {
      for (let i = 0; i < 16; i++) {
        const req = request(`${baseUrl}/api/attestation`, {
          method: "POST",
          headers: {
            authorization: "Bearer body-attest-key",
            "content-type": "application/json",
          },
        });
        held.push(req);
        await new Promise<void>((resolve, reject) => {
          req.once("error", reject);
          req.once("socket", (socket) => {
            const sendPartialBody = (): void => {
              req.flushHeaders();
              req.write(Buffer.alloc(64 * 1024 + 1, "x"));
              resolve();
            };
            if (socket.connecting) socket.once("connect", sendPartialBody);
            else sendPartialBody();
          });
        });
        await new Promise((resolve) => setImmediate(resolve));
      }

      const rpc = await fetch(`${baseUrl}/api/rpc`, {
        method: "POST",
        headers: {
          authorization: "Bearer body-rpc-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aztec_getVersion", params: [] }),
      });
      expect(rpc.status).toBe(503);

      const recovery = await fetch(`${baseUrl}/api/recovery`, {
        method: "POST",
        headers: {
          authorization: "Bearer body-recovery-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "aztec_getSettlement",
          params: [{}],
        }),
      });
      expect(recovery.status).toBe(200);
    } finally {
      for (const req of held) req.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("shares the backend concurrency cap with the main RPC route", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    let releaseObservation!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    let started = 0;
    let allStarted!: () => void;
    const sixteenStarted = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    ctx.probe.observeAttestationChain = async () => {
      started += 1;
      if (started === 16) allStarted();
      await held;
      return ctx.probe.observation;
    };
    const server = createApp(new FakeAztecClient(), {
      apiKey: "rpc-cap-key",
      attestationApiKey: "attest-cap-key",
      attestation: ctx.producer,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/api/attestation`;
    const requestOptions = {
      method: "POST",
      headers: {
        authorization: "Bearer attest-cap-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "aztec_attestRecipientMembership",
        params: params(),
      }),
    };
    const pending = Array.from({ length: 16 }, () => fetch(url, requestOptions));
    try {
      await sixteenStarted;
      expect((await fetch(url, requestOptions)).status).toBe(503);
    } finally {
      releaseObservation();
      await Promise.all(pending);
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
      method: "aztec_attestRecipientMembership",
      params: params(),
    });
    try {
      const wrong = await fetch(`${url}/api/attestation`, {
        method: "POST",
        headers: {
          authorization: "Bearer rpc-key",
          "content-type": "application/json",
        },
        body: rpcBody,
      });
      expect(wrong.status).toBe(401);
      const adminWrong = await fetch(`${url}/api/attestation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-key",
          "content-type": "application/json",
        },
        body: rpcBody,
      });
      expect(adminWrong.status).toBe(401);

      const correct = await fetch(`${url}/api/attestation`, {
        method: "POST",
        headers: {
          authorization: "Bearer attest-key",
          "content-type": "application/json",
        },
        body: rpcBody,
      });
      expect(correct.status).toBe(200);
      expect(await correct.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          descriptorDigest,
          root: ctx.tree.root.toString(),
          member: true,
          rootBlock: "7",
          attestedAt: NOW,
          signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
        },
      });

      const deploymentResponse = await fetch(`${url}/api/attestation`, {
        method: "POST",
        headers: {
          authorization: "Bearer attest-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "aztec_attestRecipientDeployment",
          params: params(),
        }),
      });
      expect(deploymentResponse.status).toBe(200);
      expect(await deploymentResponse.json()).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {
          descriptorDigest,
          recipient,
          classId: descriptor.classId,
          deployed: true,
          finalBlock: "7",
          attestedAt: NOW,
          signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
        },
      });
      ctx.probe.observation = {
        state: "unknown",
        reason: "finalized_history_unavailable",
      };
      const refused = await fetch(`${url}/api/attestation`, {
        method: "POST",
        headers: {
          authorization: "Bearer attest-key",
          "content-type": "application/json",
        },
        body: rpcBody,
      });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32010,
          message: "Readiness attestation refused",
          data: { signed: false, refusal: "finalized_history_unavailable" },
        },
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
        { ...complete, SPENDING_LIMIT_ADMIN_KEY: SIGNER_KEY },
        [],
      ),
    ).toThrow(/must not reuse/);
    expect(() =>
      readAttestationEnvironment(
        { ...complete, PXE_BRIDGE_ATTESTATION_API_KEY: SIGNER_KEY },
        [],
      ),
    ).toThrow(/must not reuse/);
    expect(() =>
      readAttestationEnvironment(
        { ...complete, PXE_BRIDGE_ATTESTATION_RELAY_TOKEN: SIGNER_KEY },
        [],
      ),
    ).toThrow(/must not reuse/);
    expect(() => readAttestationEnvironment(complete, [SIGNER_KEY])).toThrow(
      /must not reuse/,
    );
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
        response.writeHead(fail ? 503 : 204).end();
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
      const recovered = new RootUpdatePublisher(
        ctx.producer,
        ctx.probe,
        ctx.journal,
        relayOptions,
      );
      await recovered.tick();
      expect(ctx.journal.pendingRootUpdates()).toHaveLength(0);
      expect(received[1]).toEqual(original);
      expect(original?.authorization).toBe("Bearer relay-token");
      const envelope = RootUpdateEnvelopeSchema.parse(original?.body);
      expect(envelope.corridor_id).toBe(CORRIDOR_ID);
      expect(envelope.corridor_revision).toBe(1);
      const rootUpdate = envelope.record;
      expect(
        verifyReadinessRecord("RootUpdate", rootUpdate, {
          domain: policyDomain,
          expectedSigner: ctx.signer.address,
          expected: { root: ctx.tree.root.toString() },
          now: NOW,
          maxAgeSeconds: 7_200,
          maxFutureSkewSeconds: 300,
          minBlock: "7",
        }).signer,
      ).toBe(ctx.signer.address);

      const recoveredId = ctx.journal.latestRootUpdate()?.id;
      const sameRootNextBlock = known(
        descriptor.network,
        ctx.tree.root.toString(),
      );
      if (sameRootNextBlock.state !== "known") throw new Error("unreachable");
      sameRootNextBlock.value.finalized.blockNumber = "8";
      ctx.probe.observation = sameRootNextBlock;
      await recovered.tick();
      expect(received).toHaveLength(3);
      expect(received[2]?.key).not.toBe(original?.key);
      expect(received[2]?.body).toMatchObject({
        record: { root: ctx.tree.root.toString(), rootBlock: "8" },
      });
      expect(ctx.journal.latestRootUpdate()?.id).not.toBe(recoveredId);

      await recovered.tick();
      expect(received).toHaveLength(3);

      const changedRoot = known(
        descriptor.network,
        "0x" + "44".repeat(32),
      );
      if (changedRoot.state !== "known") throw new Error("unreachable");
      changedRoot.value.finalized.blockNumber = "9";
      ctx.probe.observation = changedRoot;
      await recovered.tick();
      expect(received).toHaveLength(4);
      expect(received[3]?.body).toMatchObject({
        record: { root: "0x" + "44".repeat(32), rootBlock: "9" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        relay.close((error) => (error ? reject(error) : resolve())),
      );
      ctx.journal.close();
    }
  });

  it("records a returned root after a later different root despite an old pending entry", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const relay = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.writeHead(503).end());
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("relay did not bind");
    const relayOptions = {
      url: `http://127.0.0.1:${address.port}/root`,
      token: "relay-token",
    };
    const rootA = ctx.tree.root.toString();
    const rootB = "0x" + "44".repeat(32);
    try {
      const publisher = new RootUpdatePublisher(
        ctx.producer,
        ctx.probe,
        ctx.journal,
        relayOptions,
      );
      await publisher.tick();

      const observationB = known(descriptor.network, rootB);
      if (observationB.state !== "known") throw new Error("unreachable");
      observationB.value.finalized.blockNumber = "8";
      ctx.probe.observation = observationB;
      await publisher.tick();

      const returnedA = known(descriptor.network, rootA);
      if (returnedA.state !== "known") throw new Error("unreachable");
      returnedA.value.finalized.blockNumber = "9";
      ctx.probe.observation = returnedA;
      const recovered = new RootUpdatePublisher(
        ctx.producer,
        ctx.probe,
        ctx.journal,
        relayOptions,
      );
      await recovered.tick();

      const pending = ctx.journal.pendingRootUpdates();
      expect(pending).toHaveLength(3);
      const rootAUpdates = pending.filter((entry) => entry.root === rootA);
      expect(rootAUpdates.map((entry) => entry.rootBlock).sort()).toEqual(["7", "9"]);
      expect(pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ root: rootB, rootBlock: "8" }),
        ]),
      );
      expect(ctx.journal.latestRootUpdate()?.id).toBe(
        rootAUpdates.find((entry) => entry.rootBlock === "9")?.id,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        relay.close((error) => (error ? reject(error) : resolve())),
      );
      ctx.journal.close();
    }
  });

  it("keeps 200 and 202 relay responses pending and retries the exact envelope", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const statuses = [200, 202, 204];
    const received: { key: string | undefined; body: unknown }[] = [];
    const relay = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        received.push({
          key: request.headers["idempotency-key"] as string | undefined,
          body: JSON.parse(body) as unknown,
        });
        response.writeHead(statuses[received.length - 1] ?? 500).end();
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("relay did not bind");
    try {
      const publisher = new RootUpdatePublisher(
        ctx.producer,
        ctx.probe,
        ctx.journal,
        {
          url: `http://127.0.0.1:${address.port}/root`,
          token: "relay-token",
        },
      );
      await publisher.tick();
      expect(ctx.journal.pendingRootUpdates()).toMatchObject([
        { attempts: 1, lastError: "relay unavailable" },
      ]);

      await publisher.tick();
      expect(ctx.journal.pendingRootUpdates()).toMatchObject([
        { attempts: 2, lastError: "relay unavailable" },
      ]);
      expect(received[1]).toEqual(received[0]);

      await publisher.tick();
      expect(ctx.journal.pendingRootUpdates()).toEqual([]);
      expect(received[2]).toEqual(received[0]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        relay.close((error) => (error ? reject(error) : resolve())),
      );
      ctx.journal.close();
    }
  });

  async function listen(
    handler: RequestListener,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("relay did not bind");
    return {
      url: `http://127.0.0.1:${address.port}/root`,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  }

  function recordingRelay(status: () => number) {
    const received: { key: string | undefined; body: unknown }[] = [];
    const relay = listen((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        received.push({
          key: request.headers["idempotency-key"] as string | undefined,
          body: JSON.parse(body) as unknown,
        });
        response.writeHead(status()).end();
      });
    });
    return { received, relay };
  }

  it("re-signs an unchanged root before it ages out, under a new idempotency key", async () => {
    let clock = NOW;
    const ctx = await setup([{ address: recipient, index: 137 }], () => clock);
    const { received, relay } = recordingRelay(() => 204);
    const { url, close } = await relay;
    try {
      const publisher = new RootUpdatePublisher(ctx.producer, ctx.probe, ctx.journal, {
        url,
        token: "relay-token",
      });
      await publisher.tick();
      expect(received).toHaveLength(1);

      clock = NOW + ROOT_UPDATE_REFRESH_SECONDS - 1;
      await publisher.tick();
      expect(received).toHaveLength(1);

      // Same root, same finalized block: a quiet chain still gets fresh evidence.
      clock = NOW + ROOT_UPDATE_REFRESH_SECONDS;
      await publisher.tick();
      expect(received).toHaveLength(2);
      expect(received[1]?.key).not.toBe(received[0]?.key);
      const refreshed = RootUpdateEnvelopeSchema.parse(received[1]?.body).record;
      expect(refreshed).toMatchObject({
        root: ctx.tree.root.toString(),
        rootBlock: "7",
        attestedAt: clock,
      });
      expect(
        verifyReadinessRecord("RootUpdate", refreshed, {
          domain: policyDomain,
          expectedSigner: ctx.signer.address,
          expected: { root: ctx.tree.root.toString() },
          now: NOW + 7_200,
          maxAgeSeconds: 7_200,
          maxFutureSkewSeconds: 300,
          minBlock: "7",
        }).signer,
      ).toBe(ctx.signer.address);
      expect(ctx.journal.pendingRootUpdates()).toEqual([]);
    } finally {
      await close();
      ctx.journal.close();
    }
  });

  it("delivers durable envelopes when the chain observation fails", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    let status = 503;
    const { received, relay } = recordingRelay(() => status);
    const { url, close } = await relay;
    try {
      const publisher = new RootUpdatePublisher(ctx.producer, ctx.probe, ctx.journal, {
        url,
        token: "relay-token",
      });
      await publisher.tick();
      expect(ctx.journal.pendingRootUpdates()).toHaveLength(1);

      ctx.probe.observeAttestationChain = () => Promise.reject(new Error("node down"));
      status = 204;
      await publisher.tick();
      expect(ctx.journal.pendingRootUpdates()).toEqual([]);
      expect(received).toHaveLength(2);
      expect(received[1]).toEqual(received[0]);
    } finally {
      await close();
      ctx.journal.close();
    }
  });

  it("does not count a redirected 204 as durable acceptance", async () => {
    const ctx = await setup([{ address: recipient, index: 137 }]);
    const { received, relay: target } = recordingRelay(() => 204);
    const targetServer = await target;
    const redirector = await listen((request, response) => {
      request.resume();
      request.on("end", () =>
        response.writeHead(307, { location: targetServer.url }).end(),
      );
    });
    try {
      await new RootUpdatePublisher(ctx.producer, ctx.probe, ctx.journal, {
        url: redirector.url,
        token: "relay-token",
      }).tick();
      expect(received).toEqual([]);
      expect(ctx.journal.pendingRootUpdates()).toMatchObject([
        { attempts: 1, lastError: "relay unavailable" },
      ]);
    } finally {
      await redirector.close();
      await targetServer.close();
      ctx.journal.close();
    }
  });
});
