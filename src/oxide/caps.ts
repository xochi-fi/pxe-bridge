import { OXIDE_V6_MAINNET } from "./pins.js";

/**
 * Off-chain caps on what the Oxide sender pays (decided for the OXDAI corridor:
 * 1,000 DAI per tx, 10,000 DAI per rolling 24h). They sit in front of the
 * token's own 5,166 DAI per-note ceiling, which is a hard protocol limit and
 * is checked here too so a refusal happens before anything is simulated.
 *
 * The caps are not the contract's -- the standard account has none -- so they
 * are only as good as the place they are enforced. Two places:
 *
 * 1. Admission (`OxideCaps.admit`), against durable spends in the window plus
 *    this process's in-flight reservations, so concurrent sends cannot each
 *    read a stale total.
 * 2. The may-broadcast mark (`OxideJournal.markMayBroadcast`), inside the same
 *    SQLite transaction that writes the spend row, against durable spends
 *    alone. Nothing is sent without a mark, so this bound survives a restart
 *    (in-flight reservations do not) and cannot be raced.
 *
 * There is no circuit breaker latch: a full window refuses until spends age out.
 */
export const DAI = 10n ** 18n;
export const DEFAULT_MAX_PER_TX = 1_000n * DAI;
export const DEFAULT_DAILY_LIMIT = 10_000n * DAI;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OxideCapsConfig {
  maxPerTx: bigint;
  dailyLimit: bigint;
  /** The token's per-note ceiling; never above the pinned `maxNoteAmount`. */
  maxNoteAmount: bigint;
}

export type CapRefusal =
  | "amount_not_positive"
  | "amount_over_note_max"
  | "amount_over_per_tx_cap"
  | "daily_cap_exhausted";

export class CapExceeded extends Error {
  constructor(
    readonly reason: CapRefusal,
    detail: string,
  ) {
    super(`Oxide cap refused (${reason}): ${detail}`);
    this.name = "CapExceeded";
  }
}

/** Reads `PXE_BRIDGE_OXIDE_MAX_PER_TX` / `PXE_BRIDGE_OXIDE_DAILY_LIMIT` (base units); defaults to the decided caps. */
export function capsFromEnv(env: NodeJS.ProcessEnv): OxideCapsConfig {
  const read = (name: string, fallback: bigint): bigint => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive decimal integer (base units)`);
    return BigInt(raw);
  };
  return validateCaps({
    maxPerTx: read("PXE_BRIDGE_OXIDE_MAX_PER_TX", DEFAULT_MAX_PER_TX),
    dailyLimit: read("PXE_BRIDGE_OXIDE_DAILY_LIMIT", DEFAULT_DAILY_LIMIT),
    maxNoteAmount: OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount,
  });
}

/** Refuses a configuration that could admit what the token or the window cannot take. */
export function validateCaps(config: OxideCapsConfig): OxideCapsConfig {
  if (config.maxPerTx <= 0n || config.dailyLimit <= 0n || config.maxNoteAmount <= 0n) {
    throw new Error("Oxide caps must be positive");
  }
  if (config.maxNoteAmount > OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount) {
    throw new Error("Oxide maxNoteAmount cannot exceed the token's pinned maxNoteAmount");
  }
  if (config.maxPerTx > config.maxNoteAmount) {
    throw new Error("PXE_BRIDGE_OXIDE_MAX_PER_TX cannot exceed the token's maxNoteAmount");
  }
  if (config.maxPerTx > config.dailyLimit) {
    throw new Error("PXE_BRIDGE_OXIDE_MAX_PER_TX cannot exceed PXE_BRIDGE_OXIDE_DAILY_LIMIT");
  }
  return config;
}

/**
 * The per-amount checks, shared by admission and the mark. `spent` is what the
 * window already holds (durable spends, plus reservations at admission).
 */
export function capRefusal(
  config: OxideCapsConfig,
  amount: bigint,
  spent: bigint,
): { reason: CapRefusal; detail: string } | undefined {
  if (amount <= 0n) return { reason: "amount_not_positive", detail: `amount ${amount}` };
  if (amount > config.maxNoteAmount) {
    return { reason: "amount_over_note_max", detail: `${amount} > note max ${config.maxNoteAmount}` };
  }
  if (amount > config.maxPerTx) {
    return { reason: "amount_over_per_tx_cap", detail: `${amount} > per-tx cap ${config.maxPerTx}` };
  }
  if (spent + amount > config.dailyLimit) {
    const left = config.dailyLimit - spent;
    return {
      reason: "daily_cap_exhausted",
      detail: `${amount} > remaining 24h budget ${left > 0n ? left : 0n}`,
    };
  }
  return undefined;
}

/** Admission-side caps: durable window from the journal, in-flight reservations in memory. */
export class OxideCaps {
  private readonly reservations = new Map<string, bigint>();

  constructor(
    readonly config: OxideCapsConfig,
    private readonly spentSince: (sinceMs: number) => bigint,
    private readonly now: () => number = Date.now,
  ) {
    validateCaps(config);
  }

  /** Reserves `amount` for `operationId`, or throws `CapExceeded`. Idempotent per operation. */
  admit(operationId: string, amount: bigint): void {
    this.reservations.delete(operationId);
    let reserved = 0n;
    for (const value of this.reservations.values()) reserved += value;
    const refusal = capRefusal(this.config, amount, this.spentSince(this.now() - WINDOW_MS) + reserved);
    if (refusal) throw new CapExceeded(refusal.reason, refusal.detail);
    this.reservations.set(operationId, amount);
  }

  /** Drops a reservation: the operation was marked (its spend row now counts) or will not be. */
  release(operationId: string): void {
    this.reservations.delete(operationId);
  }
}
