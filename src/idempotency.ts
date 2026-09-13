import type { CreateNoteResult } from "./types.js";

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

/**
 * What a key produced, minus the JSON-RPC envelope.
 *
 * Stored without the envelope on purpose: a replay has to answer the CURRENT
 * request, whose `id` is its own. Keeping the original response whole would
 * have replayed the first caller's id back to the second one.
 */
export type IdempotentOutcome =
  | { kind: "result"; result: CreateNoteResult }
  | { kind: "error"; code: number; message: string; data?: unknown };

/**
 * What `begin()` found for a key.
 *
 * `fresh` is the only one that permits execution. The other two are answers in
 * their own right, which is the point: a duplicate must never reach the
 * transfer.
 */
export type IdempotencyLookup =
  | { state: "fresh" }
  | { state: "in-flight" }
  | { state: "settled"; outcome: IdempotentOutcome };

interface StoredRecord {
  /** Absent while the request is still running. */
  outcome?: IdempotentOutcome;
  timestamp: number;
}

/**
 * Remembers what each `Idempotency-Key` produced, so a retry replays rather
 * than transfers again.
 *
 * The failure this exists for: `createNote` can fail after the transfer is
 * already on chain -- the 120s send deadline is the obvious way -- and the
 * caller cannot tell that from a clean rejection. Without a key, the natural
 * response to that error is a retry, and the retry moves funds a second time.
 *
 * Records are held for 24h, matching `TransactionLimits`' window, and seeded
 * from the audit log at startup so a restart does not forget them.
 */
export class IdempotencyStore {
  private records = new Map<string, StoredRecord>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.prune(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /**
   * Claims `key` for execution, or reports what it already produced.
   *
   * Claiming is synchronous and unconditional on the `fresh` path, so two
   * concurrent requests carrying the same key cannot both be told to proceed.
   */
  begin(key: string): IdempotencyLookup {
    const existing = this.records.get(key);
    if (existing) {
      return existing.outcome === undefined
        ? { state: "in-flight" }
        : { state: "settled", outcome: existing.outcome };
    }
    this.records.set(key, { timestamp: Date.now() });
    return { state: "fresh" };
  }

  /** Record the outcome a later duplicate should replay. */
  settle(key: string, outcome: IdempotentOutcome): void {
    this.records.set(key, { outcome, timestamp: Date.now() });
  }

  /**
   * Release a key whose request definitively moved nothing.
   *
   * Deliberately not Stripe's semantics, which replay a recorded error
   * forever. A key here guards against repeating a TRANSFER, and a request
   * stopped by the limits or by a simulation revert has no transfer to repeat.
   * Recording those would strand the caller: every retry would replay the
   * failure and the trade could never settle, with nothing gained, since the
   * danger runs the other way.
   *
   * Only settled keys are durable. Anything abandoned is something the audit
   * log records as `rejected` or `error`, and the reader skips both.
   */
  abandon(key: string): void {
    this.records.delete(key);
  }

  /**
   * Seed from records recovered elsewhere, without overwriting anything this
   * process has already claimed.
   *
   * Called once at startup with what the audit log yields. Returns how many
   * were taken.
   */
  restore(entries: { key: string; outcome: IdempotentOutcome; timestamp: number }[]): number {
    const cutoff = Date.now() - WINDOW_MS;
    let restored = 0;
    for (const entry of entries) {
      if (entry.timestamp < cutoff || this.records.has(entry.key)) continue;
      this.records.set(entry.key, { outcome: entry.outcome, timestamp: entry.timestamp });
      restored++;
    }
    return restored;
  }

  size(): number {
    return this.records.size;
  }

  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, record] of this.records) {
      // In-flight records are pruned on the same schedule. A request still
      // running after 24h is not one whose result anyone is waiting for, and
      // the alternative is a key that wedges forever when a caller disconnects
      // mid-flight.
      if (record.timestamp < cutoff) {
        this.records.delete(key);
      }
    }
  }
}
