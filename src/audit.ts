import { appendFile, open, readFile } from "node:fs/promises";
import { RPC_ERRORS, SUBMITTED_UNKNOWN_MESSAGE } from "./types.js";
import type { IdempotentOutcome } from "./idempotency.js";

/**
 * How a `createNote` call ended.
 *
 * `submitting` is written BEFORE the send and is an intent record, not an
 * outcome. It exists so a crash between submitting and recording the result is
 * recoverable: on restart a key left at `submitting` is known to have been
 * attempted and unknown to have landed, which is exactly `unknown`. Without it
 * the dangerous window -- crash mid-send -- is the one case durable
 * idempotency would not cover.
 *
 * `unknown` is distinct from `error` on purpose. "We do not know whether this
 * moved funds" and "this moved nothing" call for opposite responses, and
 * collapsing them meant a post-submission failure was replayed from the log as
 * though nothing had happened.
 */
export type AuditStatus = "submitting" | "success" | "rejected" | "error" | "unknown";

export interface AuditEntry {
  timestamp: string;
  method: string;
  recipient: string;
  token: string;
  amount: string;
  chainId: number;
  tradeId?: string | undefined;
  subTradeIndex?: number | undefined;
  /** Present when the caller sent an `Idempotency-Key` header. */
  idempotencyKey?: string | undefined;
  clientIp: string;
  status: AuditStatus;
  txHash?: string | undefined;
  /**
   * The note hashes and nullifiers a successful transfer emitted. Recorded so
   * a duplicate can be replayed verbatim after a restart, and so an entry can
   * be reconciled against chain state on its own.
   */
  noteHashes?: string[] | undefined;
  nullifiers?: string[] | undefined;
  error?: string | undefined;
}

const AUDIT_PREFIX = "[audit] ";

export interface RecordedSpend {
  amount: bigint;
  timestamp: number;
}

export interface RecordedKey {
  key: string;
  outcome: IdempotentOutcome;
  timestamp: number;
}

export interface AuditReplay {
  /** Feeds `TransactionLimits.restore()`. */
  spends: RecordedSpend[];
  /** Feeds `IdempotencyStore.restore()`. */
  keys: RecordedKey[];
}

/** Statuses under which the amount is counted as having left the account. */
const SPENT: ReadonlySet<AuditStatus> = new Set<AuditStatus>(["success", "unknown"]);

/**
 * Rebuilds both pieces of durable state from the JSON-lines audit log.
 *
 * The log is already the authoritative record of what the bridge moved, so
 * rehydrating from it needs a reader rather than a second store that could
 * disagree with it. One pass produces both, because reading a large log twice
 * to answer two questions about the same lines is wasteful and lets the two
 * answers diverge.
 *
 * Tolerant by design: a truncated final line (killed mid-append) or an entry
 * from an older schema is skipped, not fatal. Refusing to boot over a corrupt
 * log would turn an observability problem into an outage.
 */
export async function replayAuditLog(logPath: string, sinceMs: number): Promise<AuditReplay> {
  let contents: string;
  try {
    contents = await readFile(logPath, "utf8");
  } catch (err) {
    // A missing log is the normal first-boot case.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { spends: [], keys: [] };
    throw err;
  }

  const spends: RecordedSpend[] = [];
  // Last write wins: a key is normally written twice, `submitting` then its
  // outcome, and only the final state is meaningful.
  const latestByKey = new Map<string, { entry: Partial<AuditEntry>; timestamp: number }>();
  let skipped = 0;

  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;

    let entry: Partial<AuditEntry>;
    try {
      entry = JSON.parse(line) as Partial<AuditEntry>;
    } catch {
      skipped++;
      continue;
    }

    const timestamp = Date.parse(entry.timestamp ?? "");
    if (Number.isNaN(timestamp) || timestamp < sinceMs) continue;

    if (entry.status !== undefined && SPENT.has(entry.status) && typeof entry.amount === "string") {
      try {
        spends.push({ amount: BigInt(entry.amount), timestamp });
      } catch {
        skipped++;
      }
    }

    if (typeof entry.idempotencyKey === "string") {
      latestByKey.set(entry.idempotencyKey, { entry, timestamp });
    }
  }

  const keys: RecordedKey[] = [];
  for (const [key, { entry, timestamp }] of latestByKey) {
    const outcome = outcomeFor(entry);
    if (outcome) keys.push({ key, outcome, timestamp });
  }

  if (skipped > 0) {
    console.warn(`[pxe-bridge] Audit log: skipped ${skipped} unparseable line(s)`);
  }
  return { spends, keys };
}

/**
 * The response a duplicate of this entry should replay, or null to let it
 * through.
 *
 * `rejected` and `error` return null deliberately: nothing moved, so a retry
 * is legitimate and the key is free. See `IdempotencyStore.abandon`.
 */
function outcomeFor(entry: Partial<AuditEntry>): IdempotentOutcome | null {
  if (entry.status === "success") {
    // A success without its effects predates them being recorded, and cannot
    // be replayed faithfully. Downgrade rather than invent: the caller is told
    // to reconcile, which is true and safe, instead of being handed empty
    // arrays that read as a transfer having emitted nothing.
    if (!entry.noteHashes?.length || !entry.nullifiers?.length || !entry.txHash) {
      return unknownOutcome(entry.txHash);
    }
    const [noteCommitment] = entry.noteHashes;
    const [nullifierHash] = entry.nullifiers;
    return {
      kind: "result",
      result: {
        noteHashes: entry.noteHashes,
        nullifiers: entry.nullifiers,
        l2TxHash: entry.txHash,
        noteCommitment: noteCommitment!,
        nullifierHash: nullifierHash!,
      },
    };
  }

  // `submitting` with no later outcome is a crash between the send and the
  // record of what it did. That is precisely "unknown", and treating it as
  // anything else reopens the window this status exists to close.
  if (entry.status === "unknown" || entry.status === "submitting") {
    return unknownOutcome(entry.txHash);
  }

  return null;
}

function unknownOutcome(txHash?: string): IdempotentOutcome {
  return {
    kind: "error",
    code: RPC_ERRORS.INTERNAL_ERROR,
    message: SUBMITTED_UNKNOWN_MESSAGE,
    ...(txHash !== undefined ? { data: { txHash } } : {}),
  };
}

export class AuditLogger {
  private fileInitialized = false;

  constructor(private readonly logPath?: string) {}

  async log(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry);

    if (this.logPath) {
      if (!this.fileInitialized) {
        const fh = await open(this.logPath, "a", 0o600);
        await fh.close();
        this.fileInitialized = true;
      }
      await appendFile(this.logPath, line + "\n");
    } else {
      process.stdout.write(AUDIT_PREFIX + line + "\n");
    }
  }
}
