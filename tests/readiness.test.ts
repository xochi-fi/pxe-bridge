import { afterEach, describe, expect, it, vi } from "vitest";
import { TransactionLimits } from "../src/limits.js";
import type { SettlementJournal } from "../src/journal.js";
import {
  admissionCapacityReasons,
  effectiveRollingSpent,
  evaluateReadiness,
  known,
  preparedCapacityReasons,
  unknown,
  SPEND_BUCKET_COUNT,
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

const NO_SPEND = { buckets: Array<bigint>(SPEND_BUCKET_COUNT).fill(0n), lastBucket: 0n };

/** Claims, prepares and marks one operation of `amount` expiring at `expiration`. */
function mark(journal: SettlementJournal, operationId: string, amount: string, expiration = 1_900_000_000n): void {
  const terms = termsFrom(CreateNoteV1Schema.parse(v1Params({ operationId, amount })));
  journal.claim(operationId, fingerprintTerms(terms), terms);
  const attempt = journal.recordPrepared(operationId, {
    txHash: "0x" + Buffer.from(operationId).toString("hex").padStart(64, "0"),
    txBytes: Buffer.from(operationId),
    expirationTimestamp: expiration,
  });
  journal.markMayBroadcast(operationId, attempt, terms.amount);
}
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
    spendWindow: known(NO_SPEND),
  };
}

function projection(
  facts: ChainReadinessFacts,
  limits = new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n }),
  journal = openBoundJournal(),
  nowMs = NOW,
) {
  try {
    return evaluateReadiness(
      facts,
      limits.windowStatus(),
      {
        journal,
        mayBroadcastConfigured: true,
        corridor: CORRIDOR,
      },
      nowMs,
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
    expect(result.inventory).toEqual({
      observed: "10000",
      required: "10000",
      mayBroadcastPrincipal: "0",
    });
    expect(result.rollingWindow).toEqual({
      committed: "0",
      reserved: "0",
      headroom: "10000",
      localHeadroom: "10000",
      onChainSpent: "0",
      onChainHeadroom: "10000",
      inFlightTransfers: 0,
    });
    expect(result.feeRunway).toEqual({
      observed: "1000",
      required: "1000",
      perTransferFeeLimit: "100",
      mayBroadcastTransfers: 0,
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
    ["unknown spend window", (facts) => (facts.spendWindow = unknown("spend_window_unknown")), "spend_window_unknown"],
    ["spend window ahead of finalized", (facts) => (facts.spendWindow = known({ ...NO_SPEND, lastBucket: 1n << 40n })), "spend_window_inconsistent"],
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
    mark(journal, "marked", "1000");
    limits.recordSpend(1_000n);
    const facts = healthyFacts();
    facts.feeRunway = known({ observed: 999n, perTransferFeeLimit: 100n });
    const result = projection(facts, limits, journal);
    // One marked plus ceil(9000 / 1000) future transfers.
    expect(result.feeRunway.required).toBe("1000");
    expect(result.feeRunway.mayBroadcastTransfers).toBe(1);
    expect(result.reasons).toContain("fee_runway_insufficient");
  });

  it("owes marked, unfinalized principal from inventory: committed 6000 against 7000 is refused", () => {
    const journal = openBoundJournal();
    const limits = new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n });
    for (let i = 0; i < 6; i++) {
      mark(journal, `marked-${i}`, "1000");
      limits.recordSpend(1_000n);
    }
    const facts = healthyFacts();
    facts.inventory = known(7_000n);
    facts.feeRunway = known({ observed: 100_000n, perTransferFeeLimit: 100n });
    const result = projection(facts, limits, journal);

    // 4000 still admissible, and 6000 the finalized balance has not paid yet.
    expect(result.inventory).toEqual({
      observed: "7000",
      required: "10000",
      mayBroadcastPrincipal: "6000",
    });
    expect(result.reasons).toEqual(["inventory_insufficient"]);
    expect(result.ready).toBe(false);
  });

  it("stops owing a marked operation once finalized is past its protocol expiration", () => {
    const journal = openBoundJournal();
    const finalizedAt = BigInt(Math.floor(NOW / 1_000) - 60);
    mark(journal, "expired", "1000", finalizedAt - 1n);
    mark(journal, "includable", "1000", finalizedAt);
    const result = projection(healthyFacts(), undefined, journal);

    expect(result.inventory.mayBroadcastPrincipal).toBe("1000");
    expect(result.feeRunway.mayBroadcastTransfers).toBe(1);
    expect(result.rollingWindow.onChainHeadroom).toBe("9000");
  });

  describe("contract spend window", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("mirrors advance_window (pinned in main.nr advance_window_matches_typescript)", () => {
      const buckets = Array.from({ length: SPEND_BUCKET_COUNT }, (_, i) => BigInt(i + 1) * 1_000n);
      // The last second of each bucket: the bucket, not the second, decides.
      const at = (bucket: bigint): bigint => bucket * 3_600n + 3_599n;
      expect(effectiveRollingSpent(buckets, 100n, at(100n))).toBe(325_000n);
      expect(effectiveRollingSpent(buckets, 100n, at(101n))).toBe(323_000n);
      expect(effectiveRollingSpent(buckets, 100n, at(124n))).toBe(1_000n);
      expect(effectiveRollingSpent(buckets, 100n, at(125n))).toBe(0n);
      expect(effectiveRollingSpent(buckets, 100n, at(126n))).toBe(0n);
      expect(effectiveRollingSpent(buckets, 123n, at(126n))).toBe(297_000n);
      // advance_window asserts "Block timestamp went backwards".
      expect(effectiveRollingSpent(buckets, 100n, at(99n))).toBeNull();
    });

    it("refuses at an hour boundary where the local window has dropped a spend the contract still counts", () => {
      const spentBucket = 490_000n;
      const spentAtMs = Number(spentBucket * 3_600n + 3_540n) * 1_000;
      vi.useFakeTimers({ now: spentAtMs, toFake: ["Date"] });
      const limits = new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n });
      limits.recordSpend(10_000n);
      const buckets = [...NO_SPEND.buckets];
      buckets[Number(spentBucket % BigInt(SPEND_BUCKET_COUNT))] = 10_000n;
      const factsAt = (nowMs: number): ChainReadinessFacts => {
        const facts = healthyFacts();
        facts.finalized = known({
          number: 7,
          hash: "0x" + "b".repeat(64),
          timestamp: BigInt(Math.floor(nowMs / 1_000) - 10),
        });
        facts.spendWindow = known({ buckets, lastBucket: spentBucket });
        return facts;
      };

      // 24h and 30s after the spend: past the local 24h window, still inside
      // the contract's 25th hourly bucket.
      const boundaryMs = spentAtMs + 86_400_000 + 30_000;
      vi.setSystemTime(boundaryMs);
      const atBoundary = projection(factsAt(boundaryMs), limits, openBoundJournal(), boundaryMs);
      expect(atBoundary.rollingWindow).toMatchObject({
        localHeadroom: "10000",
        onChainSpent: "10000",
        onChainHeadroom: "0",
        headroom: "0",
      });
      expect(atBoundary.reasons).toEqual(["spend_window_exhausted"]);

      // Once the finalized tip is in the next bucket the contract drops it too.
      const nextBucketMs = boundaryMs + 3_600_000;
      vi.setSystemTime(nextBucketMs);
      const afterBucket = projection(factsAt(nextBucketMs), limits, openBoundJournal(), nextBucketMs);
      expect(afterBucket.rollingWindow.onChainSpent).toBe("0");
      expect(afterBucket.ready).toBe(true);
    });

    it("admits only what the contract window can still take", () => {
      const journal = openBoundJournal();
      const limits = new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n });
      const facts = healthyFacts();
      const finalized = facts.finalized.state === "known" ? facts.finalized.value.timestamp : 0n;
      const current = finalized / 3_600n;
      const buckets = [...NO_SPEND.buckets];
      buckets[Number(current % BigInt(SPEND_BUCKET_COUNT))] = 9_500n;
      facts.spendWindow = known({ buckets, lastBucket: current });
      try {
        const result = evaluateReadiness(
          facts,
          limits.windowStatus(),
          { journal, mayBroadcastConfigured: true, corridor: CORRIDOR },
          NOW,
        );
        expect(result.ready).toBe(true);
        expect(result.rollingWindow).toMatchObject({ localHeadroom: "10000", onChainHeadroom: "500" });
        // The local window would take 1000; the contract would revert it.
        expect(admissionCapacityReasons(result, limits.windowStatus(), journal, 1_000n)).toEqual([
          "spend_window_insufficient",
        ]);
        expect(admissionCapacityReasons(result, limits.windowStatus(), journal, 500n)).toEqual([]);
      } finally {
        journal.close();
      }
    });
  });

  it("holds a prepared operation that marked operations leave uncovered", () => {
    const journal = openBoundJournal();
    const limits = new TransactionLimits({ maxAmount: 1_000n, dailyLimit: 10_000n });
    for (let i = 0; i < 6; i++) mark(journal, `marked-${i}`, "1000");
    const facts = healthyFacts();
    const finalized = facts.finalized.state === "known" ? facts.finalized.value.timestamp : 0n;
    const current = finalized / 3_600n;
    const buckets = [...NO_SPEND.buckets];
    buckets[Number(current % BigInt(SPEND_BUCKET_COUNT))] = 3_500n;
    facts.spendWindow = known({ buckets, lastBucket: current });
    facts.inventory = known(6_999n);
    facts.feeRunway = known({ observed: 699n, perTransferFeeLimit: 100n });
    try {
      const result = evaluateReadiness(
        facts,
        limits.windowStatus(),
        { journal, mayBroadcastConfigured: true, corridor: CORRIDOR },
        NOW,
      );
      // 6000 marked + 1000 for this one; 7 fees; 3500 + 7000 against 10000.
      expect(preparedCapacityReasons(result, limits.windowStatus(), journal, 1_000n)).toEqual([
        "operation_inventory_insufficient",
        "operation_fee_runway_insufficient",
        "operation_spend_window_insufficient",
      ]);
      expect(preparedCapacityReasons(result, limits.windowStatus(), journal, 1n)).toEqual([
        "operation_fee_runway_insufficient",
      ]);
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
