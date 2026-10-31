import type { SettlementJournal } from "./journal.js";
import type { TransactionLimits, LimitsWindowStatus } from "./limits.js";
import type { CorridorConfig } from "./settlement.js";

export const FINALIZED_MAX_AGE_SECONDS = 7_200;
export const FINALIZED_MAX_FUTURE_SKEW_SECONDS = 300;

export type FinalizedTimeReason =
  | "finalized_tip_from_future"
  | "finalized_tip_stale";

/** Shared age policy for readiness and every signed finalized observation. */
export function finalizedTimeReason(
  timestamp: bigint,
  nowSeconds: number,
): FinalizedTimeReason | undefined {
  const ageSeconds = nowSeconds - Number(timestamp);
  if (
    !Number.isSafeInteger(ageSeconds) ||
    ageSeconds < -FINALIZED_MAX_FUTURE_SKEW_SECONDS
  ) {
    return "finalized_tip_from_future";
  }
  return ageSeconds > FINALIZED_MAX_AGE_SECONDS
    ? "finalized_tip_stale"
    : undefined;
}

export type ReadinessReason =
  | "account_mode_not_spending_limit"
  | "deployment_record_missing"
  | "account_address_unknown"
  | "account_address_mismatch"
  | "account_class_unknown"
  | "account_class_mismatch"
  | "account_state_unknown"
  | "account_not_initialized"
  | "account_paused"
  | "token_unknown"
  | "token_mismatch"
  | "token_class_unknown"
  | "token_class_mismatch"
  | "allowlist_root_unknown"
  | "allowlist_root_mismatch"
  | "max_amount_unknown"
  | "max_amount_mismatch"
  | "daily_limit_unknown"
  | "daily_limit_mismatch"
  | "inventory_unknown"
  | "inventory_insufficient"
  | "fee_runway_unknown"
  | "fee_runway_insufficient"
  | "spend_window_unknown"
  | "spend_window_inconsistent"
  | "spend_window_exhausted"
  | "spend_window_insufficient"
  | "operation_inventory_insufficient"
  | "operation_fee_runway_insufficient"
  | "operation_spend_window_insufficient"
  | "limits_unconfigured"
  | "rolling_window_paused"
  | "rolling_window_exhausted"
  | "journal_unconfigured"
  | "journal_unwritable"
  | "writer_fence_lost"
  | "may_broadcast_unconfigured"
  | "corridor_unconfigured"
  | "network_identity_unknown"
  | "network_identity_incomplete"
  | "network_identity_mismatch"
  | "node_readiness_unknown"
  | "node_not_ready"
  | "world_state_unknown"
  | "world_state_not_synced"
  | "finalized_history_unavailable"
  | "finalized_tip_unknown"
  | "finalized_tip_zero"
  | "finalized_tip_mismatch"
  | "finalized_tip_from_future"
  | "finalized_tip_stale"
  | "readiness_observation_failed"
  | "backend_capacity_exhausted";

export type ReadinessFact<T> =
  | { state: "known"; value: T }
  | { state: "unknown"; reason: ReadinessReason };

export interface FinalizedTipObservation {
  number: number;
  hash: string;
  timestamp: bigint;
}

export interface NetworkObservation {
  nodeVersion: string;
  aztecChainId: string;
  protocolVersion: string;
  rollupContract: string;
  l1ChainId: string;
  rollupVersion: string;
}

export interface WorldStateObservation {
  latestBlockNumber: number;
  finalizedBlockNumber: number;
  oldestHistoricBlockNumber: number;
  treesAreSynched: boolean;
}

export interface AccountStateObservation {
  initialized: boolean;
  paused: boolean;
  maxAmount: bigint;
  dailyLimit: bigint;
  allowlistRoot: string;
  permittedToken: string;
}

/** The account's stored daily-window ring, as `check_spending_public` reads it. */
export interface SpendWindowObservation {
  /** `spend_buckets[0..BUCKET_COUNT)`, each u128. */
  buckets: readonly bigint[];
  /** `spend_bucket`: the absolute bucket of the last transfer, u64. */
  lastBucket: bigint;
}

/** Mirrors `BUCKET_COUNT` and `BUCKET_SECONDS` in contracts/spending_limit_account/src/main.nr. */
export const SPEND_BUCKET_COUNT = 25;
export const SPEND_BUCKET_SECONDS = 3_600n;

/**
 * The contract's rolling spend at `timestamp`: `advance_window` in main.nr
 * with a zero amount, i.e. the ring advanced to the bucket of `timestamp`
 * and summed. The contract clears aged slots lazily on the next transfer,
 * so summing the stored slots would keep volume that has already left the
 * window. Null where the contract asserts ("Block timestamp went
 * backwards"): `timestamp`'s bucket precedes the stored one.
 */
export function effectiveRollingSpent(
  buckets: readonly bigint[],
  lastBucket: bigint,
  timestamp: bigint,
): bigint | null {
  if (buckets.length !== SPEND_BUCKET_COUNT) {
    throw new Error(`expected ${SPEND_BUCKET_COUNT} spend buckets, got ${buckets.length}`);
  }
  const currentBucket = timestamp / SPEND_BUCKET_SECONDS;
  if (currentBucket < lastBucket) return null;
  const count = BigInt(SPEND_BUCKET_COUNT);
  const elapsed = currentBucket - lastBucket;
  const clearCount = elapsed >= count ? count : elapsed;
  const updated = [...buckets];
  for (let k = 1n; k <= clearCount; k++) {
    updated[Number((lastBucket + k) % count)] = 0n;
  }
  return updated.reduce((total, value) => total + value, 0n);
}

/** Facts observed by AztecClient. Every contract/storage fact is from `finalized`. */
export interface ChainReadinessFacts {
  observedAt: number;
  accountMode: "spending_limit" | "standard";
  deploymentRecordPresent: boolean;
  derivedAccountAddress: string | null;
  configuredAccountAddress: string | null;
  expectedAccountClassId: string | null;
  configuredToken: string | null;
  configuredAllowlistRoot: string | null;
  configuredMaxAmount: bigint | null;
  configuredDailyLimit: bigint | null;
  network: ReadinessFact<NetworkObservation>;
  nodeAcceptingTransactions: ReadinessFact<boolean>;
  worldState: ReadinessFact<WorldStateObservation>;
  finalized: ReadinessFact<FinalizedTipObservation>;
  accountContractClassId: ReadinessFact<string>;
  accountState: ReadinessFact<AccountStateObservation>;
  expectedTokenClassId: string | null;
  tokenContractClassId: ReadinessFact<string>;
  inventory: ReadinessFact<bigint>;
  feeRunway: ReadinessFact<{ observed: bigint; perTransferFeeLimit: bigint }>;
  spendWindow: ReadinessFact<SpendWindowObservation>;
}

export interface ReadinessChainProbe {
  observeReadinessChain(signal?: AbortSignal): Promise<ChainReadinessFacts>;
}

export interface OperationalReadiness {
  ready: boolean;
  reasons: ReadinessReason[];
  observedAt: number;
  nodeVersion: string | null;
  l1ChainId: string | null;
  rollupVersion: string | null;
  accountMode: "spending_limit" | "standard" | null;
  account: { address: string | null; classId: string | null };
  token: string | null;
  maxAmount: string | null;
  dailyLimit: string | null;
  network: {
    aztecChainId: string | null;
    protocolVersion: string | null;
    rollupContract: string | null;
    genesisOrNetworkDigest: string | null;
  };
  node: {
    acceptingTransactions: boolean | null;
    worldStateSynced: boolean | null;
    finalizedHistoryAvailable: boolean | null;
  };
  finalized: {
    blockNumber: string | null;
    blockHash: string | null;
    timestamp: string | null;
    ageSeconds: number | null;
    maxAgeSeconds: number;
  };
  policy: {
    initialized: boolean | null;
    paused: boolean | null;
    allowlistRoot: string | null;
    configuredAllowlistRoot: string | null;
  };
  inventory: {
    observed: string | null;
    required: string | null;
    /** Principal of marked operations that may still land after `finalized`. */
    mayBroadcastPrincipal: string | null;
  };
  rollingWindow: {
    committed: string | null;
    reserved: string | null;
    /** Admissible volume: the smaller of `localHeadroom` and `onChainHeadroom`. */
    headroom: string | null;
    /** The bridge's own 24h window. */
    localHeadroom: string | null;
    /** The contract's window at `finalized`, simulated forward to its timestamp. */
    onChainSpent: string | null;
    /** Daily limit less `onChainSpent`, marked principal and reservations. */
    onChainHeadroom: string | null;
    inFlightTransfers: number | null;
  };
  feeRunway: {
    observed: string | null;
    required: string | null;
    perTransferFeeLimit: string | null;
    /** Marked operations that may still land after `finalized`. */
    mayBroadcastTransfers: number | null;
  };
  journal: {
    writable: boolean;
    writerFenceHeld: boolean;
    reason?: string;
  };
}

export interface ReadinessObserver {
  observe(signal?: AbortSignal): Promise<OperationalReadiness>;
}

export interface ReadinessObserverOptions {
  journal?: SettlementJournal | undefined;
  limits?: TransactionLimits | undefined;
  mayBroadcastConfigured: boolean;
  corridor?: CorridorConfig | undefined;
  now?: (() => number) | undefined;
  /**
   * Runs after the chain observation, before evaluation: resolves marked
   * operations the finalized state may already show (`rpc.ts`
   * `createLandedReconciler`), so they stop counting as marked exposure
   * without waiting for a caller. Bounded by `RECONCILE_BUDGET_MS`; a failure
   * or overrun is logged and the operations stay counted.
   */
  reconcile?: ((finalized: FinalizedTipObservation, signal?: AbortSignal) => Promise<void>) | undefined;
}

/**
 * Most one readiness observation spends reconciling marked operations.
 * Reconciliation only removes exposure the finalized state already shows, so
 * running out of time is not a readiness failure: the observation evaluates
 * with the operations still counted. It runs after the chain probe, inside
 * the server's 20-second readiness deadline, and a single node read may take
 * up to `NODE_RPC_TIMEOUT_MS` (10 seconds); without its own bound one slow
 * receipt read would fail readiness for a probe that succeeded.
 */
export const RECONCILE_BUDGET_MS = 5_000;


function addUnknown<T>(reasons: Set<ReadinessReason>, fact: ReadinessFact<T>): T | null {
  if (fact.state === "unknown") {
    reasons.add(fact.reason);
    return null;
  }
  return fact.value;
}

function nonzero(value: string): boolean {
  try {
    return BigInt(value) !== 0n;
  } catch {
    return false;
  }
}

function transfersFor(headroom: bigint, maxAmount: bigint): bigint {
  if (headroom === 0n) return 0n;
  return (headroom + maxAmount - 1n) / maxAmount;
}

/** What marked, unresolved operations may still take from finalized state. */
export interface MayBroadcastExposure {
  transfers: number;
  principal: bigint;
}

interface Capacity {
  onChainHeadroom: bigint;
  headroom: bigint;
  requiredInventory: bigint;
}

/**
 * The rolling volume still admissible, and the token inventory that honours
 * it. Finalized state does not yet show marked operations that may still
 * land, nor reservations, so both come off the contract's headroom and both
 * are owed from the finalized balance. Reserving moves volume from headroom
 * to `reserved` and marking from `reserved` to exposure, so neither changes
 * `requiredInventory`.
 */
function capacityOf(
  dailyLimit: bigint,
  onChainSpent: bigint,
  window: { reserved: bigint; remaining: bigint },
  exposure: MayBroadcastExposure,
): Capacity {
  const used = onChainSpent + exposure.principal + window.reserved;
  const onChainHeadroom = dailyLimit > used ? dailyLimit - used : 0n;
  const headroom = onChainHeadroom < window.remaining ? onChainHeadroom : window.remaining;
  return {
    onChainHeadroom,
    headroom,
    requiredInventory: window.reserved + headroom + exposure.principal,
  };
}

/** Fees for every in-flight and marked transfer plus the headroom in max-size transfers. */
function requiredFeeOf(
  headroom: bigint,
  maxAmount: bigint,
  inFlightTransfers: number,
  exposure: MayBroadcastExposure,
  perTransferFeeLimit: bigint,
): bigint {
  return (
    (BigInt(inFlightTransfers + exposure.transfers) + transfersFor(headroom, maxAmount)) *
    perTransferFeeLimit
  );
}

/**
 * The one readiness predicate. Both `/ready` and createNote admission call an
 * observer backed by this projection; neither reimplements any prerequisite.
 */
export function evaluateReadiness(
  facts: ChainReadinessFacts,
  window: LimitsWindowStatus | null,
  options: Pick<ReadinessObserverOptions, "journal" | "mayBroadcastConfigured" | "corridor">,
  nowMs: number,
): OperationalReadiness {
  const reasons = new Set<ReadinessReason>();

  if (facts.accountMode !== "spending_limit") reasons.add("account_mode_not_spending_limit");
  if (!facts.deploymentRecordPresent) reasons.add("deployment_record_missing");
  if (facts.derivedAccountAddress === null || facts.configuredAccountAddress === null) {
    reasons.add("account_address_unknown");
  } else if (facts.derivedAccountAddress.toLowerCase() !== facts.configuredAccountAddress.toLowerCase()) {
    reasons.add("account_address_mismatch");
  }

  const network = addUnknown(reasons, facts.network);
  if (
    network !== null &&
    (!network.nodeVersion ||
      network.nodeVersion === "unknown" ||
      !nonzero(network.aztecChainId) ||
      !nonzero(network.protocolVersion) ||
      !nonzero(network.l1ChainId) ||
      !nonzero(network.rollupVersion) ||
      !/^0x[0-9a-f]{40}$/i.test(network.rollupContract) ||
      !nonzero(network.rollupContract))
  ) {
    reasons.add("network_identity_incomplete");
  }

  const nodeAcceptingTransactions = addUnknown(reasons, facts.nodeAcceptingTransactions);
  if (nodeAcceptingTransactions === false) reasons.add("node_not_ready");

  const finalized = addUnknown(reasons, facts.finalized);
  let finalizedAgeSeconds: number | null = null;
  if (finalized !== null) {
    if (finalized.number <= 0 || !nonzero(finalized.hash)) {
      reasons.add("finalized_tip_zero");
    }
    finalizedAgeSeconds = Math.floor(nowMs / 1_000) - Number(finalized.timestamp);
    const timeReason = finalizedTimeReason(
      finalized.timestamp,
      Math.floor(nowMs / 1_000),
    );
    if (timeReason !== undefined) reasons.add(timeReason);
  }

  const worldState = addUnknown(reasons, facts.worldState);
  let finalizedHistoryAvailable: boolean | null = null;
  if (worldState !== null && finalized !== null) {
    if (!worldState.treesAreSynched || worldState.latestBlockNumber < finalized.number) {
      reasons.add("world_state_not_synced");
    }
    finalizedHistoryAvailable =
      worldState.finalizedBlockNumber >= finalized.number &&
      worldState.oldestHistoricBlockNumber <= finalized.number;
    if (!finalizedHistoryAvailable) reasons.add("finalized_history_unavailable");
  }

  const accountClassId = addUnknown(reasons, facts.accountContractClassId);
  if (facts.expectedAccountClassId === null) {
    reasons.add("account_class_unknown");
  } else if (
    accountClassId !== null &&
    accountClassId.toLowerCase() !== facts.expectedAccountClassId.toLowerCase()
  ) {
    reasons.add("account_class_mismatch");
  }

  const accountState = addUnknown(reasons, facts.accountState);
  if (facts.configuredToken === null) reasons.add("token_unknown");
  if (facts.configuredAllowlistRoot === null) reasons.add("allowlist_root_unknown");
  if (facts.configuredMaxAmount === null) reasons.add("max_amount_unknown");
  if (facts.configuredDailyLimit === null) reasons.add("daily_limit_unknown");
  if (accountState !== null) {
    if (!accountState.initialized) reasons.add("account_not_initialized");
    if (accountState.paused) reasons.add("account_paused");
    if (
      facts.configuredToken !== null &&
      accountState.permittedToken.toLowerCase() !== facts.configuredToken.toLowerCase()
    ) {
      reasons.add("token_mismatch");
    }
    if (
      facts.configuredAllowlistRoot !== null &&
      accountState.allowlistRoot.toLowerCase() !== facts.configuredAllowlistRoot.toLowerCase()
    ) {
      reasons.add("allowlist_root_mismatch");
    }
    if (
      facts.configuredMaxAmount !== null &&
      accountState.maxAmount !== facts.configuredMaxAmount
    ) {
      reasons.add("max_amount_mismatch");
    }
    if (
      facts.configuredDailyLimit !== null &&
      accountState.dailyLimit !== facts.configuredDailyLimit
    ) {
      reasons.add("daily_limit_mismatch");
    }
  }

  const tokenClassId = addUnknown(reasons, facts.tokenContractClassId);
  if (facts.expectedTokenClassId === null) reasons.add("token_class_unknown");
  else if (
    tokenClassId !== null &&
    tokenClassId.toLowerCase() !== facts.expectedTokenClassId.toLowerCase()
  ) {
    reasons.add("token_class_mismatch");
  }

  if (window === null) {
    reasons.add("limits_unconfigured");
  } else {
    if (window.paused) reasons.add("rolling_window_paused");
    if (window.remaining === undefined || window.dailyLimit === undefined || window.maxAmount === undefined) {
      reasons.add("limits_unconfigured");
    } else {
      if (window.remaining === 0n) reasons.add("rolling_window_exhausted");
      if (facts.configuredMaxAmount !== null && window.maxAmount !== facts.configuredMaxAmount) {
        reasons.add("max_amount_mismatch");
      }
      if (facts.configuredDailyLimit !== null && window.dailyLimit !== facts.configuredDailyLimit) {
        reasons.add("daily_limit_mismatch");
      }
    }
  }

  // The contract's window, at the same finalized reference as every other
  // storage fact. Its timestamp is the earliest a transfer can be included,
  // and a later inclusion only ages more volume out, so this bounds the
  // spend `check_spending_public` will see from above.
  const spendWindow = addUnknown(reasons, facts.spendWindow);
  let onChainSpent: bigint | null = null;
  if (spendWindow !== null && finalized !== null && accountState !== null) {
    onChainSpent = effectiveRollingSpent(
      spendWindow.buckets,
      spendWindow.lastBucket,
      finalized.timestamp,
    );
    if (onChainSpent === null) reasons.add("spend_window_inconsistent");
  }

  // Exposure is relative to one finalized reference; without one it is not
  // computed, and the missing finalized tip is already a reason.
  let exposure: MayBroadcastExposure | null = null;
  if (options.journal !== undefined && finalized !== null) {
    try {
      exposure = options.journal.mayBroadcastExposure(finalized);
    } catch {
      reasons.add("journal_unwritable");
    }
  }

  let capacity: Capacity | null = null;
  if (
    accountState !== null &&
    onChainSpent !== null &&
    exposure !== null &&
    window?.remaining !== undefined
  ) {
    capacity = capacityOf(
      accountState.dailyLimit,
      onChainSpent,
      { reserved: window.reserved, remaining: window.remaining },
      exposure,
    );
    if (capacity.onChainHeadroom === 0n) reasons.add("spend_window_exhausted");
  }

  const inventory = addUnknown(reasons, facts.inventory);
  if (inventory !== null && capacity !== null && inventory < capacity.requiredInventory) {
    reasons.add("inventory_insufficient");
  }

  const fee = addUnknown(reasons, facts.feeRunway);
  if (fee !== null && fee.perTransferFeeLimit <= 0n) reasons.add("fee_runway_unknown");
  let requiredFee: bigint | null = null;
  if (
    fee !== null &&
    fee.perTransferFeeLimit > 0n &&
    capacity !== null &&
    exposure !== null &&
    window?.maxAmount !== undefined &&
    window.maxAmount > 0n
  ) {
    requiredFee = requiredFeeOf(
      capacity.headroom,
      window.maxAmount,
      window.inFlightTransfers,
      exposure,
      fee.perTransferFeeLimit,
    );
    if (fee.observed < requiredFee) reasons.add("fee_runway_insufficient");
  } else if (fee !== null) {
    reasons.add("fee_runway_unknown");
  }

  const journalHealth = options.journal?.health();
  const writerFenceHeld = options.journal?.writerFenceHeld() ?? false;
  if (journalHealth === undefined) reasons.add("journal_unconfigured");
  else if (!journalHealth.writable) reasons.add("journal_unwritable");
  if (!writerFenceHeld) reasons.add("writer_fence_lost");
  if (!options.mayBroadcastConfigured) reasons.add("may_broadcast_unconfigured");
  if (options.corridor === undefined) reasons.add("corridor_unconfigured");

  return {
    ready: reasons.size === 0,
    reasons: [...reasons],
    observedAt: facts.observedAt,
    nodeVersion: network?.nodeVersion ?? null,
    l1ChainId: network?.l1ChainId ?? null,
    rollupVersion: network?.rollupVersion ?? null,
    accountMode: facts.accountMode,
    account: { address: facts.derivedAccountAddress, classId: accountClassId },
    token: accountState?.permittedToken ?? facts.configuredToken,
    maxAmount: accountState?.maxAmount.toString() ?? facts.configuredMaxAmount?.toString() ?? null,
    dailyLimit: accountState?.dailyLimit.toString() ?? facts.configuredDailyLimit?.toString() ?? null,
    network: {
      aztecChainId: network?.aztecChainId ?? null,
      protocolVersion: network?.protocolVersion ?? null,
      rollupContract: network?.rollupContract ?? null,
      genesisOrNetworkDigest: options.corridor?.genesisOrNetworkDigest.toLowerCase() ?? null,
    },
    node: {
      acceptingTransactions: nodeAcceptingTransactions,
      worldStateSynced:
        worldState === null
          ? null
          : worldState.treesAreSynched &&
            (finalized === null || worldState.latestBlockNumber >= finalized.number),
      finalizedHistoryAvailable,
    },
    finalized: {
      blockNumber: finalized?.number.toString() ?? null,
      blockHash: finalized?.hash ?? null,
      timestamp: finalized?.timestamp.toString() ?? null,
      ageSeconds: finalizedAgeSeconds,
      maxAgeSeconds: FINALIZED_MAX_AGE_SECONDS,
    },
    policy: {
      initialized: accountState?.initialized ?? null,
      paused: accountState?.paused ?? null,
      allowlistRoot: accountState?.allowlistRoot ?? null,
      configuredAllowlistRoot: facts.configuredAllowlistRoot,
    },
    inventory: {
      observed: inventory?.toString() ?? null,
      required: capacity?.requiredInventory.toString() ?? null,
      mayBroadcastPrincipal: exposure?.principal.toString() ?? null,
    },
    rollingWindow: {
      committed: window?.committed.toString() ?? null,
      reserved: window?.reserved.toString() ?? null,
      headroom: capacity?.headroom.toString() ?? null,
      localHeadroom: window?.remaining?.toString() ?? null,
      onChainSpent: onChainSpent?.toString() ?? null,
      onChainHeadroom: capacity?.onChainHeadroom.toString() ?? null,
      inFlightTransfers: window?.inFlightTransfers ?? null,
    },
    feeRunway: {
      observed: fee?.observed.toString() ?? null,
      required: requiredFee?.toString() ?? null,
      perTransferFeeLimit: fee?.perTransferFeeLimit.toString() ?? null,
      mayBroadcastTransfers: exposure?.transfers ?? null,
    },
    journal: {
      writable: journalHealth?.writable ?? false,
      writerFenceHeld,
      ...(journalHealth !== undefined && !journalHealth.writable
        ? { reason: journalHealth.reason }
        : {}),
    },
  };
}

export function createReadinessObserver(
  probe: ReadinessChainProbe,
  options: ReadinessObserverOptions,
): ReadinessObserver {
  return {
    async observe(signal?: AbortSignal): Promise<OperationalReadiness> {
      const facts = await probe.observeReadinessChain(signal);
      if (options.reconcile !== undefined && facts.finalized.state === "known") {
        signal?.throwIfAborted();
        const budget = new AbortController();
        const timer = setTimeout(
          () => budget.abort(new Error(`reconciliation exceeded ${RECONCILE_BUDGET_MS} ms`)),
          RECONCILE_BUDGET_MS,
        );
        const forwardAbort = (): void => budget.abort(signal?.reason);
        signal?.addEventListener("abort", forwardAbort, { once: true });
        // Raced, so evaluation does not wait on a reconciliation that ignores
        // its signal. Neither timer nor caller can abort `budget` once the
        // finally below has run, so the losing promise never rejects.
        const overrun = new Promise<never>((_, reject) => {
          budget.signal.addEventListener("abort", () => reject(budget.signal.reason), { once: true });
        });
        try {
          await Promise.race([options.reconcile(facts.finalized.value, budget.signal), overrun]);
        } catch (cause) {
          if (signal?.aborted) signal.throwIfAborted();
          // Unreconciled operations stay counted as marked exposure, which
          // only overstates what is owed.
          console.error("[pxe-bridge] Readiness reconciliation of marked operations failed:", cause);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", forwardAbort);
        }
      }
      return evaluateReadiness(
        facts,
        options.limits?.windowStatus() ?? null,
        options,
        (options.now ?? Date.now)(),
      );
    },
  };
}

/** The finalized-state inputs a projection carries, parsed back. */
interface ProjectedChain {
  finalized: { number: number; timestamp: bigint } | null;
  dailyLimit: bigint | null;
  maxAmount: bigint | null;
  onChainSpent: bigint | null;
  inventory: bigint | null;
  fee: { observed: bigint; perTransferFeeLimit: bigint } | null;
}

function projectedChain(readiness: OperationalReadiness): ProjectedChain {
  const parse = (value: string | null): bigint | null => (value === null ? null : BigInt(value));
  const observed = parse(readiness.feeRunway.observed);
  const perTransferFeeLimit = parse(readiness.feeRunway.perTransferFeeLimit);
  const finalizedTimestamp = parse(readiness.finalized.timestamp);
  return {
    finalized:
      readiness.finalized.blockNumber !== null && finalizedTimestamp !== null
        ? { number: Number(readiness.finalized.blockNumber), timestamp: finalizedTimestamp }
        : null,
    dailyLimit: parse(readiness.dailyLimit),
    maxAmount: parse(readiness.maxAmount),
    onChainSpent: parse(readiness.rollingWindow.onChainSpent),
    inventory: parse(readiness.inventory.observed),
    fee:
      observed !== null && perTransferFeeLimit !== null && perTransferFeeLimit > 0n
        ? { observed, perTransferFeeLimit }
        : null,
  };
}

/**
 * The capacity part of readiness for one new admission of `amount`,
 * re-evaluated against the live local window and journal.
 *
 * Synchronous, so the caller reserves in the same turn: concurrent admissions
 * share one chain observation (the server single-flights it), and without
 * this each would be judged against the window as it stood before any of
 * them reserved. `readiness` must be a ready projection.
 */
export function admissionCapacityReasons(
  readiness: OperationalReadiness,
  window: LimitsWindowStatus | null,
  journal: Pick<SettlementJournal, "mayBroadcastExposure">,
  amount: bigint,
): ReadinessReason[] {
  if (window?.remaining === undefined || window.maxAmount === undefined || window.maxAmount <= 0n) {
    return ["limits_unconfigured"];
  }
  const chain = projectedChain(readiness);
  if (
    chain.finalized === null ||
    chain.dailyLimit === null ||
    chain.onChainSpent === null ||
    chain.inventory === null ||
    chain.fee === null
  ) {
    return ["readiness_observation_failed"];
  }
  let exposure: MayBroadcastExposure;
  try {
    exposure = journal.mayBroadcastExposure(chain.finalized);
  } catch {
    return ["journal_unwritable"];
  }
  const capacity = capacityOf(
    chain.dailyLimit,
    chain.onChainSpent,
    { reserved: window.reserved, remaining: window.remaining },
    exposure,
  );
  const reasons: ReadinessReason[] = [];
  // Over the local window is the reservation's own refusal.
  if (capacity.onChainHeadroom === 0n) reasons.push("spend_window_exhausted");
  else if (amount > capacity.onChainHeadroom) reasons.push("spend_window_insufficient");
  if (chain.inventory < capacity.requiredInventory) reasons.push("inventory_insufficient");
  const requiredFee = requiredFeeOf(
    capacity.headroom,
    window.maxAmount,
    window.inFlightTransfers,
    exposure,
    chain.fee.perTransferFeeLimit,
  );
  if (chain.fee.observed < requiredFee) reasons.push("fee_runway_insufficient");
  return reasons;
}

/**
 * Why an already admitted, unmarked operation of `amount` would not be paid
 * for or would revert if sent now: the finalized inventory, fee juice or
 * contract window cannot cover it on top of every marked operation that may
 * still land and every other reservation. Synchronous for the same reason as
 * `admissionCapacityReasons`. Unlike admission it does not require the
 * bridge's full runway. An unread fee juice balance is not a hold: the node
 * refuses an underfunded fee payer without charging it. An unread inventory
 * or contract window is, since a shortfall in either reverts in public after
 * the fee is paid.
 */
export function preparedCapacityReasons(
  readiness: OperationalReadiness,
  window: LimitsWindowStatus | null,
  journal: Pick<SettlementJournal, "mayBroadcastExposure">,
  amount: bigint,
): ReadinessReason[] {
  const chain = projectedChain(readiness);
  // The contract window is computed at the finalized reference, so without
  // one it is unread and the operation is held for that alone.
  if (chain.finalized === null) return ["spend_window_unknown"];
  let exposure: MayBroadcastExposure;
  try {
    exposure = journal.mayBroadcastExposure(chain.finalized);
  } catch {
    return ["journal_unwritable"];
  }
  const reserved = window?.reserved ?? 0n;
  const owed = exposure.principal + reserved + amount;
  const reasons: ReadinessReason[] = [];
  if (chain.inventory === null) reasons.push("inventory_unknown");
  else if (chain.inventory < owed) reasons.push("operation_inventory_insufficient");
  if (
    chain.fee !== null &&
    chain.fee.observed <
      BigInt(exposure.transfers + (window?.inFlightTransfers ?? 0) + 1) *
        chain.fee.perTransferFeeLimit
  ) {
    reasons.push("operation_fee_runway_insufficient");
  }
  if (chain.onChainSpent === null || chain.dailyLimit === null) {
    reasons.push(
      readiness.reasons.includes("spend_window_inconsistent")
        ? "spend_window_inconsistent"
        : "spend_window_unknown",
    );
  } else if (chain.onChainSpent + owed > chain.dailyLimit) {
    reasons.push("operation_spend_window_insufficient");
  }
  return reasons;
}

export function known<T>(value: T): ReadinessFact<T> {
  return { state: "known", value };
}

export function unknown<T>(reason: ReadinessReason): ReadinessFact<T> {
  return { state: "unknown", reason };
}
