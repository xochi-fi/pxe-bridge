export interface LimitsConfig {
  maxAmount?: bigint;
  dailyLimit?: bigint;
  cooldownThreshold?: bigint;
  cooldownDelayMs?: number;
}

export type LimitsCheckResult =
  | { allowed: true; cooldownMs?: number }
  | { allowed: false; reason: string };

export type LimitsReservation =
  | { allowed: true; reservationId: number; cooldownMs?: number }
  | { allowed: false; reason: string };

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute
// The window counts as drained once committed volume leaves less than
// 1/DRAINED_RESIDUAL_DIVISOR of the daily limit. See check() for why the
// breaker needs a threshold at all, and why this one.
const DRAINED_RESIDUAL_DIVISOR = 100n;

function drained(volume: bigint, dailyLimit: bigint): boolean {
  return volume >= dailyLimit || (dailyLimit - volume) * DRAINED_RESIDUAL_DIVISOR < dailyLimit;
}

export class TransactionLimits {
  private spendLog: { amount: bigint; timestamp: number }[] = [];
  private pending = new Map<number, { amount: bigint; timestamp: number }>();
  private nextReservationId = 1;
  private paused = false;
  private pausedAt = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: LimitsConfig) {
    if (config.dailyLimit !== undefined) {
      this.cleanupTimer = setInterval(() => this.pruneSpendLog(), CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();
    }
  }

  /**
   * Atomically evaluate limits and reserve `amount` against the rolling window.
   * The reservation counts toward the daily budget immediately -- before the
   * (awaited) transaction is sent -- so concurrent in-flight requests cannot
   * each read a stale total and collectively exceed the cap (TOCTOU race).
   * It does not count toward the breaker, which trips on committed volume only.
   * Call commit() on success or release() on failure/rejection downstream.
   */
  reserve(amount: bigint): LimitsReservation {
    const result = this.check(amount);
    if (!result.allowed) {
      return result;
    }
    const reservationId = this.nextReservationId++;
    this.pending.set(reservationId, { amount, timestamp: Date.now() });
    return result.cooldownMs !== undefined
      ? { allowed: true, reservationId, cooldownMs: result.cooldownMs }
      : { allowed: true, reservationId };
  }

  /** Convert a reservation into a permanent recorded spend. */
  commit(reservationId: number): void {
    const reservation = this.pending.get(reservationId);
    if (reservation === undefined) {
      return;
    }
    this.pending.delete(reservationId);
    this.spendLog.push({ amount: reservation.amount, timestamp: Date.now() });
  }

  /** Discard a reservation without recording a spend (tx failed or rejected). */
  release(reservationId: number): void {
    this.pending.delete(reservationId);
  }

  check(amount: bigint): LimitsCheckResult {
    if (this.paused) {
      // Auto-resume once the full window has elapsed since pause
      if (Date.now() - this.pausedAt >= WINDOW_MS) {
        this.paused = false;
        this.pausedAt = 0;
        this.pruneSpendLog();
        console.log("[pxe-bridge] Bridge auto-resumed after window elapsed");
      } else {
        return {
          allowed: false,
          reason: "Bridge paused: daily volume limit exceeded",
        };
      }
    }

    if (this.config.maxAmount !== undefined && amount > this.config.maxAmount) {
      return {
        allowed: false,
        reason: `Amount ${amount} exceeds per-transaction maximum ${this.config.maxAmount}`,
      };
    }

    if (this.config.dailyLimit !== undefined) {
      const committed = this.committedTotal();

      // Committed volume drained the window. This is the drain signal the
      // breaker exists for, so it stops everything until an operator resumes
      // or the window elapses. There are three ways out, not one: the operator
      // endpoint, the auto-resume above, and a restart, and none of them hands
      // budget back -- the window is rebuilt from the audit log either way.
      //
      // Drained is not only "reached exactly". Admission keeps committed at or
      // below the limit, so a drain in amounts that do not divide it stops
      // short -- 4999 of 5000 -- and the breaker never fired, though the
      // window was as spent as it gets. It also trips when committed volume
      // alone leaves less than this request needs AND less than 1% of the
      // limit. The 1% floor is what keeps a single oversized request from
      // tripping it with no prior volume, and a busy legitimate day at 80%
      // from pausing over one transfer too large for what is left. The cost
      // is that a residual under 1% of the limit is unspendable until a
      // resume or the window elapses.
      //
      // In-flight reservations are excluded from both conditions: a
      // reservation that later releases moved no tokens, and must not pause
      // the bridge for a full window. It is not "moved nothing": a send that
      // reverts on chain still burns its fee, but the daily limit counts token
      // volume, not fees.
      const dailyLimit = this.config.dailyLimit;
      if (
        committed >= dailyLimit ||
        (committed + amount > dailyLimit && drained(committed, dailyLimit))
      ) {
        const left = dailyLimit - committed;
        this.paused = true;
        this.pausedAt = Date.now();
        console.error(
          `[pxe-bridge] CIRCUIT BREAKER: 24h committed volume ${committed} drained the daily ` +
            `limit ${dailyLimit} (${left > 0n ? left : 0n} left). Bridge paused.`,
        );
        return {
          allowed: false,
          reason: "Bridge paused: daily volume limit exceeded",
        };
      }

      // Budget counts reservations too, so concurrent requests cannot each
      // read a stale total and collectively exceed the cap. Rejected alone,
      // without tripping: an oversized request, or one blocked only by
      // in-flight volume, is not evidence of a drain.
      const budgetUsed = committed + this.reservedTotal();
      if (budgetUsed + amount > this.config.dailyLimit) {
        const remaining = this.config.dailyLimit - budgetUsed;
        return {
          allowed: false,
          reason:
            `Amount ${amount} exceeds the remaining daily budget ` +
            `${remaining > 0n ? remaining : 0n}`,
        };
      }
    }

    const cooldownMs = this.cooldownFor(amount);
    if (cooldownMs > 0) {
      return { allowed: true, cooldownMs };
    }
    return { allowed: true };
  }

  recordSpend(amount: bigint): void {
    this.spendLog.push({ amount, timestamp: Date.now() });
  }

  /**
   * Manual re-enable after the circuit breaker trips.
   *
   * Clears `pausedAt` too. Leaving it set meant a later pause inherited the
   * first one's timestamp and could auto-resume immediately.
   */
  resume(): void {
    this.paused = false;
    this.pausedAt = 0;
    console.log("[pxe-bridge] Bridge resumed by operator");
  }

  /**
   * What the breaker will see on the next check.
   *
   * `resume()` clears the latch and not the window, which is the correct
   * semantics: volume genuinely consumed the budget, and resuming must not
   * hand it back. The consequence is that a resume issued while the window is
   * still full is undone by the very next request. The endpoint used to answer
   * `paused: false` and stop there, which reads as "service restored" during
   * exactly the incident where it is not, so an operator could believe they
   * had recovered the bridge and walk away. The deciding number is reported
   * now instead of being left for them to infer. `total` is committed volume,
   * the breaker's input; `reserved` is in flight, and `remaining` is what a new
   * request can still spend after both.
   */
  windowStatus(): {
    total: bigint;
    reserved: bigint;
    remaining: bigint | undefined;
    dailyLimit: bigint | undefined;
    willTripAgain: boolean;
  } {
    const total = this.committedTotal();
    const reserved = this.reservedTotal();
    const dailyLimit = this.config.dailyLimit;
    let remaining: bigint | undefined;
    if (dailyLimit !== undefined) {
      const left = dailyLimit - total - reserved;
      remaining = left > 0n ? left : 0n;
    }
    return {
      total,
      reserved,
      remaining,
      dailyLimit,
      willTripAgain: dailyLimit !== undefined && total >= dailyLimit,
    };
  }

  /**
   * Seed the rolling window with spends recorded before this process started.
   *
   * The window is in-memory, so without this a restart -- including the
   * restart that used to be the only way to clear a tripped breaker -- reset
   * the 24h total to zero and handed back the full daily budget. Entries
   * outside the window are dropped rather than trusted.
   */
  restore(entries: { amount: bigint; timestamp: number }[]): number {
    const cutoff = Date.now() - WINDOW_MS;
    const live = entries.filter((e) => e.timestamp >= cutoff);
    this.spendLog.push(...live);
    return live.length;
  }

  isPaused(): boolean {
    return this.paused;
  }

  private committedTotal(): bigint {
    const cutoff = Date.now() - WINDOW_MS;
    let total = 0n;
    for (const entry of this.spendLog) {
      if (entry.timestamp >= cutoff) {
        total += entry.amount;
      }
    }
    return total;
  }

  private reservedTotal(): bigint {
    const cutoff = Date.now() - WINDOW_MS;
    let total = 0n;
    for (const reservation of this.pending.values()) {
      if (reservation.timestamp >= cutoff) {
        total += reservation.amount;
      }
    }
    return total;
  }

  private cooldownFor(amount: bigint): number {
    if (
      this.config.cooldownThreshold !== undefined &&
      this.config.cooldownDelayMs !== undefined &&
      amount >= this.config.cooldownThreshold
    ) {
      return this.config.cooldownDelayMs;
    }
    return 0;
  }

  private pruneSpendLog(): void {
    const cutoff = Date.now() - WINDOW_MS;
    this.spendLog = this.spendLog.filter((e) => e.timestamp >= cutoff);
    // Drop stale reservations whose tx never committed or released (safety
    // net for a hung request); the window has fully elapsed for these.
    for (const [id, reservation] of this.pending) {
      if (reservation.timestamp < cutoff) {
        this.pending.delete(id);
      }
    }
  }
}
