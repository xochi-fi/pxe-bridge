import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  recoverReadinessSigner,
  verifyReadinessRecord,
  type Hex,
  type ReadinessDomainInputs,
} from "@xochi/signer";
import {
  AttestationParamsSchema,
  AttestationProducer,
  RecipientDescriptorSchema,
  RootUpdateEnvelopeSchema,
  RootUpdatePublisher,
  type AccountAttestationObservation,
  type AttestationAuditEvent,
} from "../src/attestation.js";
import { Secp256k1ReadinessSigner } from "../src/attestation-secret.js";
import { known as knownFact, unknown as unknownFact, type ReadinessFact } from "../src/readiness.js";
import {
  OxideAllowlist,
  OxideAllowlistConfigError,
  oxideAllowlistFromEnv,
  planOxideAllowlistChange,
} from "../src/oxide/allowlist.js";
import { OxideAttestationProbe, type StandardAccountChainProbe } from "../src/oxide/attestation.js";
import { DAI } from "../src/oxide/caps.js";
import { EnclaveTrustRefused } from "../src/oxide/enclave.js";
import { OxideJournal } from "../src/oxide/journal.js";
import { oxideTerms, OxideSendRequestSchema } from "../src/oxide/operation.js";
import { OxidePinMismatch, OxidePinUnverified, OXIDE_V6_MAINNET } from "../src/oxide/pins.js";
import { OxideReadiness, type OxideReadinessOptions } from "../src/oxide/readiness.js";
import type { OxideFeeRunway } from "../src/oxide/sender.js";
import { createApp } from "../src/server.js";
import { CAPS, evidenceFor, FEE_LIMIT, request, SENDER, tempJournalPath } from "./oxide-fixtures.js";
import { CORRIDOR, FakeAztecClient, NETWORK, openBoundJournal } from "./settlement-fixtures.js";

// The conformance vectors Xochi's Worker and the SDK verify against: the real
// stock-Schnorr descriptor and its binding signature, never hand-made values.
const FixtureSchema = z.object({
  descriptor: z.object({
    vectors: z.array(
      z.object({ name: z.string(), descriptor: RecipientDescriptorSchema, descriptorDigest: z.string() }),
    ),
  }),
  recipientMessage: z.object({
    bindingMessages: z.array(z.object({ name: z.string(), digest: z.string(), signature: z.string() })),
  }),
});
const fixture = FixtureSchema.parse(
  JSON.parse(
    readFileSync(createRequire(import.meta.url).resolve("@xochi/spec/conformance/shielded-recipient.json"), "utf8"),
  ),
);
const descriptorVector = fixture.descriptor.vectors.find(({ name }) => name === "aztec-6.0.0-stock")!;
const bindingVector = fixture.recipientMessage.bindingMessages.find(
  ({ name }) => name === "aztec-6.0.0-stock binding",
)!;
const descriptor = descriptorVector.descriptor;
const descriptorDigest = descriptorVector.descriptorDigest.toLowerCase();
const recipient = descriptor.aztecAddress;

const SEED = "0x" + "12".repeat(32);
const OTHER_MEMBER = "0x" + "0c".repeat(32);
const MANIFEST = "0x" + "4d".repeat(32);
const CORRIDOR_ID = "0x" + "63".repeat(32);
const NOW = 1_800_000_000;
const SIGNER_KEY = "0x" + "31".repeat(32);

const policyDomain: ReadinessDomainInputs = {
  sourceChainId: "1",
  environment: "production",
  network: descriptor.network,
  manifestDigest: MANIFEST,
};

/** The standard account's chain half: what AztecClient.observeStandardAccountChain reports. */
class AccountChain implements StandardAccountChainProbe {
  block = "7";
  outcome: AccountAttestationObservation | undefined;
  async observeStandardAccountChain(): Promise<AccountAttestationObservation> {
    return (
      this.outcome ?? {
        state: "known",
        value: {
          network: descriptor.network,
          finalized: { blockNumber: this.block, blockHash: "0x" + "ab".repeat(32), timestamp: String(NOW - 10) },
          recipientDeployment: { state: "present", classId: descriptor.classId, initialized: true },
        },
      }
    );
  }
}

function params() {
  return AttestationParamsSchema.parse({
    descriptor,
    descriptorDigest,
    recipient,
    network: descriptor.network,
    corridor: { corridorId: CORRIDOR_ID, corridorRevision: 2, manifestDigest: MANIFEST },
    recipientAuthorization: { digest: bindingVector.digest, signature: bindingVector.signature },
  });
}

async function attestationSetup(members: { address: string; index: number }[]) {
  const allowlist = await OxideAllowlist.build(SEED, members);
  const journal = openBoundJournal();
  journal.recordAllowlistSnapshot(allowlist.root, allowlist.snapshot());
  const chain = new AccountChain();
  const probe = new OxideAttestationProbe(chain, allowlist);
  const signer = new Secp256k1ReadinessSigner(SIGNER_KEY);
  const audits: AttestationAuditEvent[] = [];
  const producer = new AttestationProducer({
    probe,
    journal,
    allowlistTree: allowlist.tree,
    signer,
    domain: {
      sourceChainId: "1",
      environment: "production",
      manifestDigest: MANIFEST,
      corridorId: CORRIDOR_ID,
      corridorRevision: 2,
      genesisOrNetworkDigest: descriptor.network.genesisOrNetworkDigest,
    },
    now: () => NOW,
    audit: (event) => audits.push(event),
  });
  return { allowlist, journal, chain, probe, signer, producer, audits };
}

const policy = (signer: Hex) => ({
  domain: policyDomain,
  expectedSigner: signer,
  now: NOW,
  maxAgeSeconds: 7_200,
  maxFutureSkewSeconds: 300,
  minBlock: "7",
});

afterEach(() => vi.restoreAllMocks());

// Each tree build hashes 2,048 leaves and nodes; slow under a loaded CI runner.
describe("Oxide private allowlist attestations", { timeout: 60_000 }, () => {
  it("signs Membership over the private root that the Worker's verifier accepts", async () => {
    const ctx = await attestationSetup([{ address: recipient, index: 611 }]);
    try {
      const membership = await ctx.producer.attestMembership(params());
      if ("status" in membership) throw new Error(membership.reason);
      expect(membership).toMatchObject({ member: true, root: ctx.allowlist.root, rootBlock: "7" });
      const verified = verifyReadinessRecord(
        "Membership",
        membership,
        { ...policy(ctx.signer.address), expected: { descriptorDigest, root: ctx.allowlist.root } },
      );
      expect(verified.signer).toBe(ctx.signer.address);
      expect(verified.attestation.member).toBe(true);

      const deployment = await ctx.producer.attestRecipientDeployment(params());
      if ("status" in deployment) throw new Error(deployment.reason);
      expect(
        verifyReadinessRecord(
          "RecipientDeployment",
          deployment,
          { ...policy(ctx.signer.address), expected: { descriptorDigest, recipient, classId: descriptor.classId } },
        ).attestation.deployed,
      ).toBe(true);
    } finally {
      ctx.journal.close();
    }
  });

  it("signs a verifiable negative Membership for a recipient outside the private set", async () => {
    const ctx = await attestationSetup([{ address: OTHER_MEMBER, index: 3 }]);
    try {
      const membership = await ctx.producer.attestMembership(params());
      if ("status" in membership) throw new Error(membership.reason);
      expect(membership).toMatchObject({ member: false, root: ctx.allowlist.root });
      // The SDK checks encoding, domain and signer before it reports the negative.
      expect(() =>
        verifyReadinessRecord(
          "Membership",
          membership,
          { ...policy(ctx.signer.address), expected: { descriptorDigest, root: ctx.allowlist.root } },
        ),
      ).toThrow(/negative_readiness/);
      expect(recoverReadinessSigner("Membership", membership, ctx.producer.domainFor(descriptor.network))).toBe(
        ctx.signer.address,
      );
    } finally {
      ctx.journal.close();
    }
  });

  it("refuses unsigned when the sending account is not the published stock Schnorr account", async () => {
    const ctx = await attestationSetup([{ address: recipient, index: 611 }]);
    try {
      ctx.chain.outcome = { state: "unknown", reason: "account_class_mismatch" };
      expect(await ctx.producer.attestMembership(params())).toEqual({
        status: "refused",
        reason: "account_class_mismatch",
      });
      ctx.chain.outcome = { state: "unknown", reason: "account_not_initialized" };
      expect(await ctx.producer.attestRecipientDeployment(params())).toEqual({
        status: "refused",
        reason: "account_not_initialized",
      });
    } finally {
      ctx.journal.close();
    }
  });

  it("publishes RootUpdate over the private root, and a changed root only from a later block", async () => {
    const ctx = await attestationSetup([{ address: OTHER_MEMBER, index: 3 }]);
    const received: unknown[] = [];
    const relay = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("relay did not bind");
    const relayOptions = { url: `http://127.0.0.1:${address.port}/root`, token: "relay-token" };
    try {
      await new RootUpdatePublisher(ctx.producer, ctx.probe, ctx.journal, relayOptions, (e) =>
        ctx.audits.push(e),
      ).tick();
      expect(received).toHaveLength(1);
      const first = RootUpdateEnvelopeSchema.parse(received[0]);
      expect(first.corridor_revision).toBe(2);
      expect(
        verifyReadinessRecord("RootUpdate", first.record, { ...policy(ctx.signer.address), expected: { root: ctx.allowlist.root } })
          .attestation.rootBlock,
      ).toBe(7n);

      // The operator approves the recipient; the bridge restarts on the new set
      // while the finalized tip has not moved.
      const approved = await OxideAllowlist.build(SEED, [
        { address: OTHER_MEMBER, index: 3 },
        { address: recipient, index: 611 },
      ]);
      expect(approved.root).not.toBe(ctx.allowlist.root);
      const probe = new OxideAttestationProbe(ctx.chain, approved);
      const producer = new AttestationProducer({
        probe,
        journal: ctx.journal,
        allowlistTree: approved.tree,
        signer: ctx.signer,
        domain: ctx.producer.domainConfig,
        now: () => NOW,
      });
      const restarted = new RootUpdatePublisher(producer, probe, ctx.journal, relayOptions, (e) =>
        ctx.audits.push(e),
      );
      await restarted.tick();
      // The Worker drops a different root at an equal rootBlock as superseded.
      expect(received).toHaveLength(1);
      expect(ctx.audits).toContainEqual({ method: "RootUpdate", outcome: "retry", reason: "finalized_tip_not_advanced" });

      ctx.chain.block = "8";
      await restarted.tick();
      expect(received).toHaveLength(2);
      const second = RootUpdateEnvelopeSchema.parse(received[1]);
      expect(second.record).toMatchObject({ root: approved.root, rootBlock: "8" });
      expect(
        verifyReadinessRecord("RootUpdate", second.record, {
          ...policy(ctx.signer.address),
          expected: { root: approved.root },
          minBlock: "8",
        }).signer,
      ).toBe(ctx.signer.address);

      // Outbox ids are logged when an attempt cannot be recorded: never a root.
      const ids = [ctx.journal.latestRootUpdate()?.id ?? "", ...ctx.journal.pendingRootUpdates().map((e) => e.id)];
      for (const id of ids) {
        expect(id).not.toContain(ctx.allowlist.root.slice(2));
        expect(id).not.toContain(approved.root.slice(2));
      }

      // Startup pruning keeps the current set and the newest delivered one only.
      ctx.journal.recordAllowlistSnapshot(approved.root, approved.snapshot());
      const stale = await OxideAllowlist.build(SEED, [{ address: OTHER_MEMBER, index: 4 }]);
      ctx.journal.recordAllowlistSnapshot(stale.root, stale.snapshot());
      expect(ctx.journal.pruneAllowlistSnapshots(approved.root)).toBe(2);
      expect(ctx.journal.allowlistSnapshot(approved.root)).toBeDefined();
      expect(ctx.journal.allowlistSnapshot(ctx.allowlist.root)).toBeUndefined();
      expect(ctx.journal.allowlistSnapshot(stale.root)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => relay.close((error) => (error ? reject(error) : resolve())));
      ctx.journal.close();
    }
  });
});

describe("Oxide allowlist configuration", { timeout: 60_000 }, () => {
  it("never names a member in a configuration error", async () => {
    const member = "0x" + "07".repeat(32);
    const cases: unknown[] = [
      [
        { address: member, index: 1 },
        { address: member, index: 2 },
      ],
      [
        { address: member, index: 1 },
        { address: "0x" + "08".repeat(32), index: 1 },
      ],
      [{ address: "0x" + "ff".repeat(32), index: 1 }],
      [{ address: "0x" + "00".repeat(32), index: 1 }],
      [{ address: member, index: 1024 }],
    ];
    for (const recipients of cases) {
      const error = await OxideAllowlist.build(SEED, recipients).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(OxideAllowlistConfigError);
      expect(String((error as Error).message)).not.toMatch(/07070707|08080808|ffffffff/);
    }
  });

  it("requires both variables and refuses the spending-limit seed", async () => {
    await expect(oxideAllowlistFromEnv({})).rejects.toThrow(/PXE_BRIDGE_OXIDE_ALLOWLIST_SEED is required/);
    await expect(oxideAllowlistFromEnv({ PXE_BRIDGE_OXIDE_ALLOWLIST_SEED: SEED })).rejects.toThrow(
      /PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS is required/,
    );
    await expect(
      oxideAllowlistFromEnv({
        PXE_BRIDGE_OXIDE_ALLOWLIST_SEED: SEED,
        PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS: "[]",
        PXE_BRIDGE_ALLOWLIST_SEED: SEED.toUpperCase().replace("0X", "0x"),
      }),
    ).rejects.toThrow(/must differ/);
    const empty = await oxideAllowlistFromEnv({
      PXE_BRIDGE_OXIDE_ALLOWLIST_SEED: SEED,
      PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS: "[]",
    });
    expect(empty.admits(recipient)).toBe(false);
  });

  it("plans one add or revoke with update-allowlist's checks", () => {
    const current = [{ address: OTHER_MEMBER, index: 3 }];
    expect(planOxideAllowlistChange(current, { mode: "add", address: recipient, index: 611 })).toEqual([
      { address: OTHER_MEMBER, index: 3 },
      { address: recipient.toLowerCase(), index: 611 },
    ]);
    expect(() => planOxideAllowlistChange(current, { mode: "add", address: recipient, index: 3 })).toThrow(
      /position 3 is already occupied/,
    );
    expect(() => planOxideAllowlistChange(current, { mode: "add", address: OTHER_MEMBER, index: 9 })).toThrow(
      /already in the set/,
    );
    expect(() => planOxideAllowlistChange(current, { mode: "add", address: SENDER, index: 9 }, SENDER)).toThrow(
      /sending account/,
    );
    expect(() => planOxideAllowlistChange(current, { mode: "revoke", address: recipient })).toThrow(/not in the current set/);
    expect(planOxideAllowlistChange(current, { mode: "revoke", address: OTHER_MEMBER.toUpperCase().replace("0X", "0x") })).toEqual([]);
  });
});

const RUNWAY: OxideFeeRunway = { observed: 10n ** 20n, committed: 0n, committedSends: 0, perSendFeeLimit: 10n ** 18n };

let readinessAllowlist: Promise<OxideAllowlist> | undefined;

async function readinessSetup(
  overrides: Partial<OxideReadinessOptions> | ((journal: OxideJournal) => Partial<OxideReadinessOptions>) = {},
) {
  readinessAllowlist ??= OxideAllowlist.build(SEED, [{ address: recipient, index: 611 }]);
  const allowlist = await readinessAllowlist;
  const journal = OxideJournal.open(tempJournalPath());
  const options: OxideReadinessOptions = {
    allowlist,
    account: SENDER,
    token: OXIDE_V6_MAINNET.bridge.l2Token,
    caps: CAPS,
    journal,
    balance: { privateBalance: async () => ({ observed: 500n * DAI, syncedBlock: 100 }) },
    feeRunway: async () => knownFact(RUNWAY),
    manifestPins: { assertPinned: async () => {} },
    l1Pins: { assertPinned: async () => {}, portalFrozen: async () => false },
    enclave: { attestEnclave: async () => {} },
    node: { isReady: async () => true },
    network: { networkIdentity: async () => NETWORK },
    corridor: CORRIDOR,
    attestationConfigured: true,
    now: () => NOW * 1_000,
    ...(typeof overrides === "function" ? overrides(journal) : overrides),
  };
  return { allowlist, journal, readiness: new OxideReadiness(options) };
}

describe("Oxide readiness", { timeout: 60_000 }, () => {
  it("is ready on known facts and reports the private balance net of in-flight principal", async () => {
    const { readiness, journal } = await readinessSetup();
    const terms = oxideTerms(
      OxideSendRequestSchema.parse(request({ recipient, amount: (120n * DAI).toString(), validUntil: NOW + 600 })),
      OXIDE_V6_MAINNET.bridge.l2Token,
    );
    journal.claim("op-1", terms);
    journal.recordPrepared("op-1", {
      txHash: "0x" + "01".padStart(64, "0"),
      txBytes: Buffer.from("tx-1"),
      expirationTimestamp: BigInt(NOW + 3_600),
      evidence: evidenceFor({ recipient, amount: 120n * DAI }),
    });
    const projection = await readiness.observe();
    expect(projection).toMatchObject({
      ready: true,
      reasons: [],
      admission: { freshSend: true, reasons: [] },
      sendMode: "oxide",
      accountMode: "standard",
      oxide: {
        corridor: {
          state: "known",
          corridorId: CORRIDOR.corridorId.toLowerCase(),
          corridorRevision: CORRIDOR.corridorRevision,
          manifestDigest: CORRIDOR.manifestDigest.toLowerCase(),
        },
        network: {
          state: "known",
          aztecChainId: NETWORK.aztecChainId,
          protocolVersion: NETWORK.protocolVersion,
          rollupAddress: NETWORK.rollupAddress.toLowerCase(),
          l1ChainId: NETWORK.l1ChainId,
          genesisOrNetworkDigest: CORRIDOR.genesisOrNetworkDigest.toLowerCase(),
        },
        attestation: { configured: true },
        privateBalance: {
          state: "known",
          observed: (500n * DAI).toString(),
          syncedBlock: "100",
          committed: (120n * DAI).toString(),
          committedSends: 1,
          available: (380n * DAI).toString(),
        },
        feeRunway: { state: "known", perSendFeeLimit: (10n ** 18n).toString() },
        caps: { state: "known", windowSpent: "0", windowHeadroom: CAPS.dailyLimit.toString() },
        pins: { manifest: { state: "known", pinned: true }, l1: { state: "known", pinned: true, portalFrozen: false } },
        enclave: { state: "known", attested: true },
        node: { state: "known", acceptingTransactions: true },
        journal: { writable: true },
      },
    });
    expect(await readiness.admit({ recipient, amount: (380n * DAI).toString() })).toEqual({ kind: "admitted" });
    expect(await readiness.admit({ recipient, amount: (380n * DAI + 1n).toString() })).toEqual({
      kind: "not_ready",
      reasons: ["private_balance_insufficient"],
    });
  });

  it("counts a mined attempt only while the balance read has not seen its block", async () => {
    const journal = OxideJournal.open(tempJournalPath());
    const terms = oxideTerms(
      OxideSendRequestSchema.parse(request({ recipient, amount: (50n * DAI).toString(), validUntil: NOW + 600 })),
      OXIDE_V6_MAINNET.bridge.l2Token,
    );
    journal.claim("op-1", terms);
    const attempt = journal.recordPrepared("op-1", {
      txHash: "0x" + "01".padStart(64, "0"),
      txBytes: Buffer.from("tx-1"),
      expirationTimestamp: BigInt(NOW + 3_600),
      evidence: evidenceFor({ recipient, amount: 50n * DAI }),
    });
    journal.markMayBroadcast("op-1", attempt, terms.amount, CAPS);
    expect(journal.committedPrincipal(NOW, 100)).toEqual({ total: 50n * DAI, sends: 1 });
    journal.recordObservation("op-1", {
      state: "included",
      txHash: "0x" + "01".padStart(64, "0"),
      expirationTimestamp: String(NOW + 3_600),
      executionResult: "success",
      blockHash: "0x" + "cd".repeat(32),
      blockNumber: "101",
      receiptStatus: "proposed",
      observedAt: NOW,
      effects: { state: "available", noteHashes: [], nullifiers: [] },
    });
    expect(journal.committedPrincipal(NOW, 100)).toEqual({ total: 50n * DAI, sends: 1 });
    expect(journal.committedPrincipal(NOW, 101)).toEqual({ total: 0n, sends: 0 });
    // Observed mined above the read counts even past its expiry: it landed.
    expect(journal.committedPrincipal(NOW + 3_600, 0)).toEqual({ total: 50n * DAI, sends: 1 });
    journal.close();
  });

  it.each([
    [
      "the private balance is unread",
      { balance: { privateBalance: () => Promise.reject(new Error("pxe down")) } },
      "private_balance_unknown",
      { privateBalance: { state: "unknown", reason: "private_balance_unknown" } },
    ],
    [
      "the private balance is spent",
      { balance: { privateBalance: async () => ({ observed: 0n, syncedBlock: 100 }) } },
      "private_balance_insufficient",
      { privateBalance: { state: "known", available: "0" } },
    ],
    [
      "the fee runway is unread",
      { feeRunway: async (): Promise<ReadinessFact<OxideFeeRunway>> => unknownFact("fee_runway_unknown") },
      "fee_runway_unknown",
      { feeRunway: { state: "unknown", reason: "fee_runway_unknown" } },
    ],
    [
      "the fee runway is short of one more send",
      {
        feeRunway: async (): Promise<ReadinessFact<OxideFeeRunway>> =>
          knownFact({ ...RUNWAY, observed: 10n ** 18n, committed: 1n }),
      },
      "fee_runway_insufficient",
      { feeRunway: { state: "known", observed: (10n ** 18n).toString(), committed: "1" } },
    ],
  ] as const)("stays ready but refuses a fresh send when %s", async (_name, override, reason, fact) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { readiness } = await readinessSetup(override as Partial<OxideReadinessOptions>);
    const projection = await readiness.observe();
    // Capacity never touches serving health: already-admitted orders keep paying.
    expect(projection.ready).toBe(true);
    expect(projection.reasons).toEqual([]);
    expect(projection.admission).toEqual({ freshSend: false, reasons: [reason] });
    expect(projection.oxide).toMatchObject(fact);
    expect(await readiness.admit({ recipient, amount: "1" })).toEqual({ kind: "not_ready", reasons: [reason] });
  });

  it.each([
    [
      "the manifest moved",
      { manifestPins: { assertPinned: () => Promise.reject(new OxidePinMismatch("manifest", ["gitSha"])) } },
      "oxide_pin_mismatch",
      { pins: { manifest: { state: "known", pinned: false } } },
    ],
    [
      "the manifest is unreadable",
      { manifestPins: { assertPinned: () => Promise.reject(new OxidePinUnverified("timeout")) } },
      "oxide_pins_unknown",
      { pins: { manifest: { state: "unknown", reason: "oxide_pins_unknown" } } },
    ],
    [
      "the portal is frozen",
      {
        l1Pins: {
          assertPinned: () => Promise.reject(new EnclaveTrustRefused("portal_frozen", "frozen")),
          portalFrozen: async (): Promise<boolean> => true,
        },
      },
      "oxide_portal_frozen",
      { pins: { l1: { state: "known", pinned: true, portalFrozen: true } } },
    ],
    [
      "L1 is not the pinned deployment",
      {
        l1Pins: {
          assertPinned: () => Promise.reject(new EnclaveTrustRefused("l1_not_pinned", "PCR0_HASH")),
          portalFrozen: async (): Promise<boolean> => false,
        },
      },
      "oxide_l1_not_pinned",
      { pins: { l1: { state: "known", pinned: false, portalFrozen: false } } },
    ],
    [
      "the enclave is unreachable",
      { enclave: { attestEnclave: () => Promise.reject(new Error("ECONNREFUSED")) } },
      "enclave_unreachable",
      { enclave: { state: "unknown", reason: "enclave_unreachable" } },
    ],
    [
      "the enclave attestation is refused",
      { enclave: { attestEnclave: () => Promise.reject(new EnclaveTrustRefused("pcr0_not_pinned", "image")) } },
      "enclave_attestation_refused",
      { enclave: { state: "known", attested: false } },
    ],
    [
      "the node is not accepting transactions",
      { node: { isReady: async () => false } },
      "node_not_ready",
      { node: { state: "known", acceptingTransactions: false } },
    ],
    [
      "the network identity is unread",
      { network: { networkIdentity: () => Promise.reject(new Error("node down")) } },
      "network_identity_unknown",
      { network: { state: "unknown", reason: "network_identity_unknown" } },
    ],
    [
      "no corridor is configured",
      { corridor: undefined },
      "corridor_unconfigured",
      { corridor: { state: "unknown", reason: "corridor_unconfigured" } },
    ],
    [
      "attestations are not configured",
      { attestationConfigured: false },
      "attestation_unconfigured",
      { attestation: { configured: false } },
    ],
  ] as const)("is not ready when %s", async (_name, override, reason, fact) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { readiness } = await readinessSetup(override as Partial<OxideReadinessOptions>);
    const projection = await readiness.observe();
    expect(projection.ready).toBe(false);
    expect(projection.reasons).toEqual([reason]);
    expect(projection.admission).toEqual({ freshSend: false, reasons: [] });
    expect(projection.oxide).toMatchObject(fact);
    expect(await readiness.admit({ recipient, amount: "1" })).toEqual({ kind: "not_ready", reasons: [reason] });
  });

  it("stays ready after one order prepares against exactly the whole balance and one send's fee", async () => {
    // F1: the ready/admission deadlock. The bridge holds B and the fee for one
    // send; one order of exactly B is prepared. Serving health must stay true
    // (Riddler pays already-admitted orders on it); only a NEW order is refused.
    const balance = 100n * DAI;
    const { readiness, journal } = await readinessSetup((journal) => ({
      balance: { privateBalance: async () => ({ observed: balance, syncedBlock: 100 }) },
      feeRunway: async () => {
        const committed = journal.committedFees(NOW, "");
        return knownFact({
          observed: FEE_LIMIT,
          committed: committed.total,
          committedSends: committed.sends,
          perSendFeeLimit: FEE_LIMIT,
        });
      },
    }));
    const before = await readiness.observe();
    expect(before).toMatchObject({ ready: true, admission: { freshSend: true, reasons: [] } });
    expect(await readiness.admit({ recipient, amount: balance.toString() })).toEqual({ kind: "admitted" });

    const terms = oxideTerms(
      OxideSendRequestSchema.parse(request({ recipient, amount: balance.toString(), validUntil: NOW + 600 })),
      OXIDE_V6_MAINNET.bridge.l2Token,
    );
    journal.claim("op-1", terms);
    journal.recordPrepared("op-1", {
      txHash: "0x" + "01".padStart(64, "0"),
      txBytes: Buffer.from("tx-1"),
      expirationTimestamp: BigInt(NOW + 3_600),
      evidence: evidenceFor({ recipient, amount: balance }),
    });

    const after = await readiness.observe();
    expect(after.ready).toBe(true);
    expect(after.reasons).toEqual([]);
    expect(after.admission).toEqual({
      freshSend: false,
      reasons: ["private_balance_insufficient", "fee_runway_insufficient"],
    });
    expect(after.oxide.privateBalance).toMatchObject({ committed: balance.toString(), available: "0" });
  });

  it("serves the last balance snapshot while the PXE is busy, recomputing what is in flight", async () => {
    // F2: balance_of queues behind proveTx in the PXE. Readiness must not.
    let at = NOW * 1_000;
    let reads = 0;
    const { readiness, journal } = await readinessSetup({
      now: () => at,
      balanceWaitMs: 10,
      balanceMaxAgeMs: 600_000,
      balance: {
        privateBalance: () => {
          reads += 1;
          return reads === 1
            ? Promise.resolve({ observed: 500n * DAI, syncedBlock: 100 })
            : new Promise<never>(() => {});
        },
      },
    });
    expect((await readiness.observe()).oxide.privateBalance).toMatchObject({
      state: "known",
      available: (500n * DAI).toString(),
      readAt: NOW,
    });

    at += 120_000;
    const terms = oxideTerms(
      OxideSendRequestSchema.parse(request({ recipient, amount: (70n * DAI).toString(), validUntil: NOW + 600 })),
      OXIDE_V6_MAINNET.bridge.l2Token,
    );
    journal.claim("op-1", terms);
    journal.recordPrepared("op-1", {
      txHash: "0x" + "01".padStart(64, "0"),
      txBytes: Buffer.from("tx-1"),
      expirationTimestamp: BigInt(NOW + 3_600),
      evidence: evidenceFor({ recipient, amount: 70n * DAI }),
    });
    const busy = await readiness.observe();
    expect(busy.ready).toBe(true);
    expect(busy.oxide.privateBalance).toMatchObject({
      state: "known",
      readAt: NOW,
      committed: (70n * DAI).toString(),
      available: (430n * DAI).toString(),
    });

    at += 600_000;
    const stale = await readiness.observe();
    expect(stale.ready).toBe(true);
    expect(stale.oxide.privateBalance).toEqual({ state: "unknown", reason: "private_balance_unknown" });
    expect(stale.admission.reasons).toEqual(["private_balance_unknown"]);
    expect(reads).toBe(2);
  });

  it("re-reads L1 and the portal for every admission, whatever /ready cached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let frozen = false;
    const { readiness } = await readinessSetup({
      l1Pins: {
        assertPinned: async () => {
          if (frozen) throw new EnclaveTrustRefused("portal_frozen", "frozen");
        },
        portalFrozen: async () => frozen,
      },
    });
    expect((await readiness.observe()).ready).toBe(true);
    frozen = true;
    // Within the documented 60 s bound /ready may still serve the cached pin...
    expect((await readiness.observe()).ready).toBe(true);
    // ...but a fresh send never relies on it.
    expect(await readiness.admit({ recipient, amount: "1" })).toEqual({
      kind: "not_ready",
      reasons: ["oxide_portal_frozen"],
    });
  });

  it("applies the per-amount cap, window and balance checks to one admission", async () => {
    const caps = { ...CAPS, maxPerTx: 1_000n * DAI, dailyLimit: 1_000n * DAI };
    const { readiness, journal } = await readinessSetup({
      caps,
      // The journal stamps the spend with the real clock; the window reads it with this one.
      now: Date.now,
      balance: { privateBalance: async () => ({ observed: 2_000n * DAI, syncedBlock: 100 }) },
    });
    const terms = oxideTerms(
      OxideSendRequestSchema.parse(request({ recipient, amount: (600n * DAI).toString(), validUntil: NOW + 600 })),
      OXIDE_V6_MAINNET.bridge.l2Token,
    );
    journal.claim("op-1", terms);
    const attempt = journal.recordPrepared("op-1", {
      txHash: "0x" + "01".padStart(64, "0"),
      txBytes: Buffer.from("tx-1"),
      expirationTimestamp: BigInt(NOW + 3_600),
      evidence: evidenceFor({ recipient, amount: 600n * DAI }),
    });
    journal.markMayBroadcast("op-1", attempt, terms.amount, caps);
    expect(await readiness.admit({ recipient, amount: (1_000n * DAI + 1n).toString() })).toEqual({
      kind: "refused",
      reason: "amount_over_per_tx_cap",
      retryable: false,
    });
    expect(await readiness.admit({ recipient, amount: "0" })).toEqual({
      kind: "refused",
      reason: "amount_invalid",
      retryable: false,
    });
    expect(await readiness.admit({ recipient, amount: (401n * DAI).toString() })).toEqual({
      kind: "not_ready",
      reasons: ["spend_window_exhausted"],
    });
    expect(await readiness.admit({ recipient, amount: (400n * DAI).toString() })).toEqual({ kind: "admitted" });
  });

  it("never reports an unread balance or runway as zero", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { readiness } = await readinessSetup({
      balance: { privateBalance: () => Promise.reject(new Error("pxe down")) },
      feeRunway: () => Promise.reject(new Error("node down")),
    });
    const { oxide } = await readiness.observe();
    expect(oxide.privateBalance).toEqual({ state: "unknown", reason: "private_balance_unknown" });
    expect(oxide.feeRunway).toEqual({ state: "unknown", reason: "fee_runway_unknown" });
  });

  it("refuses a recipient outside the private set permanently, before any read", async () => {
    const reads = { balance: 0 };
    const { readiness } = await readinessSetup({
      balance: {
        privateBalance: async () => {
          reads.balance += 1;
          return { observed: 500n * DAI, syncedBlock: 100 };
        },
      },
    });
    expect(await readiness.admit({ recipient: OTHER_MEMBER, amount: "1" })).toEqual({
      kind: "refused",
      reason: "recipient_not_allowlisted",
      retryable: false,
    });
    expect(reads.balance).toBe(0);
  });

  it("reuses a successful external check but re-reads a failed one", async () => {
    let at = NOW * 1_000;
    const calls = { enclave: 0 };
    let fail = true;
    const { readiness } = await readinessSetup({
      now: () => at,
      enclave: {
        attestEnclave: async () => {
          calls.enclave += 1;
          if (fail) throw new Error("ECONNRESET");
        },
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await readiness.observe()).reasons).toEqual(["enclave_unreachable"]);
    fail = false;
    expect((await readiness.observe()).ready).toBe(true);
    expect((await readiness.observe()).ready).toBe(true);
    expect(calls.enclave).toBe(2);
    at += 60_000;
    await readiness.observe();
    expect(calls.enclave).toBe(3);
  });

  it("keeps the allowlist, its root and its members out of /ready, refusals and logs", async () => {
    const logged: string[] = [];
    for (const level of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const { readiness, allowlist } = await readinessSetup({
      balance: { privateBalance: () => Promise.reject(new Error("pxe down")) },
    });
    const projection = await readiness.observe();
    const refusal = await readiness.admit({ recipient: OTHER_MEMBER, amount: "1" });
    const app = createApp(new FakeAztecClient(), { apiKey: "ready-key", oxideReadiness: readiness });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/ready`, {
        headers: { authorization: "Bearer ready-key" },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({
        ready: true,
        sendMode: "oxide",
        admission: { freshSend: false, reasons: ["private_balance_unknown"] },
      });
      const surfaces = [JSON.stringify(projection), JSON.stringify(refusal), body, ...logged].join("\n").toLowerCase();
      expect(surfaces).not.toContain(recipient.toLowerCase().slice(2));
      expect(surfaces).not.toContain(allowlist.root.slice(2));
    } finally {
      await new Promise<void>((resolve, reject) => app.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("serves 200 when ready and refuses a second readiness source", async () => {
    const { readiness } = await readinessSetup();
    const app = createApp(new FakeAztecClient(), { apiKey: "ready-key", oxideReadiness: readiness });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/ready`, {
        headers: { authorization: "Bearer ready-key" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ready: true, accountAddress: SENDER, token: OXIDE_V6_MAINNET.bridge.l2Token });
    } finally {
      await new Promise<void>((resolve, reject) => app.close((error) => (error ? reject(error) : resolve())));
    }
    expect(() =>
      createApp(new FakeAztecClient(), {
        apiKey: "ready-key",
        oxideReadiness: readiness,
        readiness: { observe: () => Promise.reject(new Error("unused")) },
      }),
    ).toThrow(/one readiness source/);
  });
});
