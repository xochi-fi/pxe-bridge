import { describe, expect, it } from "vitest";
import { TransactionLimits } from "../src/limits.js";
import {
  evaluateReadiness,
  known,
  unknown,
  type ChainReadinessFacts,
  type ReadinessReason,
} from "../src/readiness.js";
import { CreateNoteV1Schema, fingerprintTerms, termsFrom } from "../src/settlement.js";
import {
  ACCOUNT,
  CORRIDOR,
  NETWORK,
  TOKEN,
  openBoundJournal,
  v1Params,
} from "./settlement-fixtures.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const CLASS_ID = "0x" + "a".repeat(64);
const TOKEN_CLASS_ID = "0x" + "d".repeat(64);
const ROOT = "0x" + "c".repeat(64);

function healthyFacts(): ChainReadinessFacts {
  return {
    observedAt: Math.floor(NOW / 1_000),
    accountMode: "spending_limit",
    deploymentRecordPresent: true,
    derivedAccountAddress: ACCOUNT,
    configuredAccountAddress: ACCOUNT,
    expectedAccountClassId: CLASS_ID,
    configuredToken: TOKEN,
    configuredAllowlistRoot: ROOT,
    configuredMaxAmount: 1_000n,
    configuredDailyLimit: 10_000n,
    network: known({
      nodeVersion: "6.0.0",
      aztecChainId: NETWORK.aztecChainId,
      protocolVersion: NETWORK.protocolVersion,
      rollupContract: NETWORK.rollupAddress,
      l1ChainId: NETWORK.l1ChainId,
      rollupVersion: NETWORK.protocolVersion,
    }),
    nodeAcceptingTransactions: known(true),
    worldState: known({
      latestBlockNumber: 10,
      finalizedBlockNumber: 7,
      oldestHistoricBlockNumber: 1,
      treesAreSynched: true,
    }),
    finalized: known({
      number: 7,
      hash: "0x" + "b".repeat(64),
      timestamp: BigInt(Math.floor(NOW / 1_000) - 60),
    }),
    accountContractClassId: known(CLASS_ID),
    accountState: known({
      initialized: true,
      paused: false,
      maxAmount: 1_000n,
      dailyLimit: 10_000n,
      allowlistRoot: ROOT,
      permittedToken: TOKEN,
    }),
    expectedTokenClassId: TOKEN_CLASS_ID,
    tokenContractClassId: known(TOKEN_CLASS_ID),
    inventory: known(10_000n),
    feeRunway: known({ observed: 1_000n, perTransferFeeLimit: 100n }),
  };
}

function projection(
  facts: ChainReadinessFacts,
  limits = new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n }),
) {
  const journal = openBoundJournal();
  try {
    return evaluateReadiness(
      facts,
      limits.windowStatus(),
      {
        journal,
        mayBroadcastConfigured: true,
        corridor: CORRIDOR,
      },
      NOW,
    );
  } finally {
    journal.close();
  }
}

describe("authoritative readiness predicate", () => {
  it("reports the exact finalized reference, inventory requirement, and computed fee runway", () => {
    const result = projection(healthyFacts());

    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.finalized).toEqual({
      blockNumber: "7",
      blockHash: "0x" + "b".repeat(64),
      timestamp: String(Math.floor(NOW / 1_000) - 60),
      ageSeconds: 60,
      maxAgeSeconds: 7_200,
    });
    expect(result.inventory).toEqual({ observed: "10000", required: "10000" });
    expect(result.feeRunway).toEqual({
      observed: "1000",
      required: "1000",
      perTransferFeeLimit: "100",
    });
  });

  it.each<[string, (facts: ChainReadinessFacts) => void, ReadinessReason]>([
    [
      "pause",
      (facts) => {
        if (facts.accountState.state === "known") {
          facts.accountState = known({ ...facts.accountState.value, paused: true });
        }
      },
      "account_paused",
    ],
    ["root drift", (facts) => (facts.configuredAllowlistRoot = "0x" + "e".repeat(64)), "allowlist_root_mismatch"],
    ["inventory", (facts) => (facts.inventory = known(9_999n)), "inventory_insufficient"],
    ["fee runway", (facts) => (facts.feeRunway = known({ observed: 999n, perTransferFeeLimit: 100n })), "fee_runway_insufficient"],
    ["history", (facts) => (facts.worldState = known({ latestBlockNumber: 10, finalizedBlockNumber: 6, oldestHistoricBlockNumber: 1, treesAreSynched: true })), "finalized_history_unavailable"],
    ["unknown inventory", (facts) => (facts.inventory = unknown("inventory_unknown")), "inventory_unknown"],
    ["standard mode", (facts) => (facts.accountMode = "standard"), "account_mode_not_spending_limit"],
    ["missing deployment record", (facts) => (facts.deploymentRecordPresent = false), "deployment_record_missing"],
  ])("fails closed on %s", (_name, mutate, reason) => {
    const facts = healthyFacts();
    mutate(facts);
    const result = projection(facts);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("does not fall back when finalized is unknown or zero", () => {
    const unknownFacts = healthyFacts();
    unknownFacts.finalized = unknown("finalized_tip_unknown");
    expect(projection(unknownFacts).reasons).toContain("finalized_tip_unknown");

    const zeroFacts = healthyFacts();
    zeroFacts.finalized = known({ number: 0, hash: "0x" + "0".repeat(64), timestamp: 0n });
    expect(projection(zeroFacts).reasons).toContain("finalized_tip_zero");
  });

  it("enforces the provisional 7,200-second finalized age bound", () => {
    const atBound = healthyFacts();
    atBound.finalized = known({
      number: 7,
      hash: "0x" + "b".repeat(64),
      timestamp: BigInt(Math.floor(NOW / 1_000) - 7_200),
    });
    expect(projection(atBound).reasons).not.toContain("finalized_tip_stale");

    const stale = healthyFacts();
    stale.finalized = known({
      number: 7,
      hash: "0x" + "b".repeat(64),
      timestamp: BigInt(Math.floor(NOW / 1_000) - 7_201),
    });
    expect(projection(stale).reasons).toContain("finalized_tip_stale");
  });

  it("allows 300 seconds of clock skew and rejects a later finalized timestamp", () => {
    const atBound = healthyFacts();
    atBound.finalized = known({
      number: 7,
      hash: "0x" + "b".repeat(64),
      timestamp: BigInt(Math.floor(NOW / 1_000) + 300),
    });
    expect(projection(atBound).reasons).not.toContain("finalized_tip_from_future");

    const future = healthyFacts();
    future.finalized = known({
      number: 7,
      hash: "0x" + "b".repeat(64),
      timestamp: BigInt(Math.floor(NOW / 1_000) + 301),
    });
    expect(projection(future).reasons).toContain("finalized_tip_from_future");
  });

  it("counts in-flight transfers and only the remaining rolling headroom", () => {
    const limits = new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n });
    expect(limits.reserve(500n).allowed).toBe(true);
    const result = projection(healthyFacts(), limits);

    expect(result.rollingWindow).toMatchObject({
      reserved: "500",
      headroom: "9500",
      inFlightTransfers: 1,
    });
    // One in-flight plus ceil(9500 / 1000) future transfers.
    expect(result.feeRunway.required).toBe("1100");
    // Inventory must cover the reservation and all remaining admissible volume.
    expect(result.inventory.required).toBe("10000");
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("fee_runway_insufficient");
  });

  it("keeps fee runway for every durable may-broadcast operation", () => {
    const journal = openBoundJournal();
    const limits = new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n });
    const terms = termsFrom(CreateNoteV1Schema.parse(v1Params()));
    const fingerprint = fingerprintTerms(terms);
    journal.claim("marked", fingerprint, terms);
    const attempt = journal.recordPrepared("marked", {
      txHash: "0x" + "1".repeat(64),
      txBytes: Buffer.from("marked"),
      expirationTimestamp: 1_900_000_000n,
    });
    journal.markMayBroadcast("marked", attempt, terms.amount);
    limits.recordSpend(1_000n);
    const facts = healthyFacts();
    facts.feeRunway = known({ observed: 999n, perTransferFeeLimit: 100n });
    try {
      const result = evaluateReadiness(
        facts,
        limits.windowStatus(),
        { journal, mayBroadcastConfigured: true, corridor: CORRIDOR },
        NOW,
      );
      expect(result.feeRunway.required).toBe("1000");
      expect(result.reasons).toContain("fee_runway_insufficient");
    } finally {
      journal.close();
    }
  });

  it("detects a released exclusive writer fence independently of durable health", () => {
    const journal = openBoundJournal();
    journal.close();
    const result = evaluateReadiness(
      healthyFacts(),
      new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n }).windowStatus(),
      { journal, mayBroadcastConfigured: true, corridor: CORRIDOR },
      NOW,
    );
    expect(result.journal).toMatchObject({ writable: true, writerFenceHeld: false });
    expect(result.reasons).toContain("writer_fence_lost");
  });

  it("reserves the nested address key for the checker account alias", () => {
    const result = projection(healthyFacts()) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(result)) {
      if (key === "account" || typeof value !== "object" || value === null) continue;
      expect(value).not.toHaveProperty("address");
    }
  });
});
