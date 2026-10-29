import type { SettlementJournal } from "./journal.js";
import type { TransactionLimits, LimitsWindowStatus } from "./limits.js";
import type { CorridorConfig } from "./settlement.js";

export const FINALIZED_MAX_AGE_SECONDS = 7_200;
export const FINALIZED_MAX_FUTURE_SKEW_SECONDS = 300;

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
  | "readiness_observation_failed";

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
}

export interface ReadinessChainProbe {
  observeReadinessChain(): Promise<ChainReadinessFacts>;
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
  inventory: { observed: string | null; required: string | null };
  rollingWindow: {
    committed: string | null;
    reserved: string | null;
    headroom: string | null;
    inFlightTransfers: number | null;
  };
  feeRunway: {
    observed: string | null;
    required: string | null;
    perTransferFeeLimit: string | null;
  };
  journal: {
    writable: boolean;
    writerFenceHeld: boolean;
    reason?: string;
  };
}

export interface ReadinessObserver {
  observe(): Promise<OperationalReadiness>;
}

export interface ReadinessObserverOptions {
  journal?: SettlementJournal | undefined;
  limits?: TransactionLimits | undefined;
  mayBroadcastConfigured: boolean;
  corridor?: CorridorConfig | undefined;
  now?: (() => number) | undefined;
}


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
    if (
      !Number.isSafeInteger(finalizedAgeSeconds) ||
      finalizedAgeSeconds < -FINALIZED_MAX_FUTURE_SKEW_SECONDS
    ) {
      reasons.add("finalized_tip_from_future");
    } else if (finalizedAgeSeconds > FINALIZED_MAX_AGE_SECONDS) {
      reasons.add("finalized_tip_stale");
    }
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

  const inventory = addUnknown(reasons, facts.inventory);
  const requiredInventory =
    window?.remaining !== undefined ? window.reserved + window.remaining : null;
  if (inventory !== null && requiredInventory !== null && inventory < requiredInventory) {
    reasons.add("inventory_insufficient");
  }

  const fee = addUnknown(reasons, facts.feeRunway);
  if (fee !== null && fee.perTransferFeeLimit <= 0n) reasons.add("fee_runway_unknown");
  let requiredFee: bigint | null = null;
  if (
    fee !== null &&
    fee.perTransferFeeLimit > 0n &&
    window?.remaining !== undefined &&
    window.maxAmount !== undefined &&
    window.maxAmount > 0n
  ) {
    const transferCount = BigInt(window.inFlightTransfers) + transfersFor(window.remaining, window.maxAmount);
    requiredFee = transferCount * fee.perTransferFeeLimit;
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
      required: requiredInventory?.toString() ?? null,
    },
    rollingWindow: {
      committed: window?.committed.toString() ?? null,
      reserved: window?.reserved.toString() ?? null,
      headroom: window?.remaining?.toString() ?? null,
      inFlightTransfers: window?.inFlightTransfers ?? null,
    },
    feeRunway: {
      observed: fee?.observed.toString() ?? null,
      required: requiredFee?.toString() ?? null,
      perTransferFeeLimit: fee?.perTransferFeeLimit.toString() ?? null,
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
    async observe(): Promise<OperationalReadiness> {
      const facts = await probe.observeReadinessChain();
      return evaluateReadiness(
        facts,
        options.limits?.windowStatus() ?? null,
        options,
        (options.now ?? Date.now)(),
      );
    },
  };
}

export function known<T>(value: T): ReadinessFact<T> {
  return { state: "known", value };
}

export function unknown<T>(reason: ReadinessReason): ReadinessFact<T> {
  return { state: "unknown", reason };
}
