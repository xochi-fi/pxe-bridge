export interface LimitsConfig {
  maxAmount?: bigint;
  dailyLimit?: bigint;
  cooldownThreshold?: bigint;
  cooldownDelayMs?: number;
}

export type LimitsCheckResult =
  | { allowed: true; cooldownMs?: number }
  | { allowed: false; reason: string };

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

export class TransactionLimits {
  private spendLog: { amount: bigint; timestamp: number }[] = [];
  private paused = false;
  private pausedAt = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: LimitsConfig) {
    if (config.dailyLimit !== undefined) {
      this.cleanupTimer = setInterval(() => this.pruneSpendLog(), CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();
    }
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
      const windowTotal = this.rollingTotal();
      if (windowTotal + amount > this.config.dailyLimit) {
        this.paused = true;
        this.pausedAt = Date.now();
        console.error(
          `[pxe-bridge] CIRCUIT BREAKER: daily limit ${this.config.dailyLimit} would be exceeded ` +
            `(current: ${windowTotal}, requested: ${amount}). Bridge paused.`,
        );
        return {
          allowed: false,
          reason: "Bridge paused: daily volume limit exceeded",
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

  /** Manual re-enable after circuit breaker trips. */
  resume(): void {
    this.paused = false;
    console.log("[pxe-bridge] Bridge resumed by operator");
  }

  isPaused(): boolean {
    return this.paused;
  }

  private rollingTotal(): bigint {
    const cutoff = Date.now() - WINDOW_MS;
    let total = 0n;
    for (const entry of this.spendLog) {
      if (entry.timestamp >= cutoff) {
        total += entry.amount;
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
  }
}
