import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Observation, SettlementTerms } from "./settlement.js";

/**
 * The durable settlement journal (xochi-fi/pxe-bridge#45; decided 2026-10-25).
 *
 * One SQLite file holds every operation, the exact prepared transaction bytes
 * and hash, the may-broadcast mark and the rolling-spend window. It replaces
 * the JSONL audit-log replay and the 24h in-memory idempotency cache as the
 * recovery authority; the audit log is now an output log only.
 *
 * Durability: `synchronous=FULL` and a rollback journal, so a committed write
 * transaction is on stable storage before `commit` returns -- an OS append
 * acknowledgement is not a flush. Every state change is one transaction.
 *
 * Fencing: `locking_mode=EXCLUSIVE`, and the lock is taken by a write at open.
 * The kernel releases it when the process dies, so a crashed writer never
 * wedges the journal, and a second process opening it while the first lives
 * fails at open (`JournalLockedError`) instead of writing beside it.
 *
 * Retention: operations and their attempts are never pruned (the tracer keeps
 * everything, plaintext on an owner-only volume; the §12 envelope encryption
 * and minimization are production gates). Spend rows are a separate table so
 * pruning the 24h window can never touch a tombstone.
 *
 * Writes can be disabled while reads continue: a corrupt file, a rollback
 * (generation below the high-water mark), a fresh journal next to an account
 * that already existed, an account that is not the journal's, an operation
 * that may have broadcast without a recorded transaction hash, an unknown
 * schema version, or a write that failed at runtime. None of these is cleared
 * by the process; see docs/settlement-operations.md for the operator response.
 */

export const JOURNAL_SCHEMA_VERSION = 1;

export type WriteDisabledReason =
  | "corrupt"
  | "rollback_detected"
  | "empty_journal_for_existing_account"
  | "account_mismatch"
  | "missing_transaction_identity"
  | "unknown_schema_version"
  | "write_failed"
  | "account_unbound";

export type JournalHealth =
  | { writable: true }
  | { writable: false; reason: WriteDisabledReason; detail: string };

export type OperationState =
  | "claimed"
  | "prepared"
  | "not_submitted"
  | "may_broadcast"
  | "finalized"
  | "reverted";

export type Hold = "may_broadcast_unknown" | "may_broadcast_denied" | "interrupted";

export interface StoredOperation {
  operationId: string;
  fingerprint: string;
  terms: SettlementTerms;
  state: OperationState;
  reason: string | null;
  retryable: boolean;
  hold: Hold | null;
  currentAttempt: number | null;
  /** Last durable observation: set on terminal states, informative otherwise. */
  observation: Observation | null;
  createdAt: number;
  updatedAt: number;
}

export interface Attempt {
  attempt: number;
  txHash: string;
  expirationTimestamp: string;
  preparedAt: number;
  mayBroadcastAt: number | null;
}

export type ClaimResult =
  | { kind: "new"; operation: StoredOperation }
  | { kind: "existing"; operation: StoredOperation }
  | { kind: "conflict"; operation: StoredOperation };

/** Another live process holds the journal's writer lock. */
export class JournalLockedError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `Settlement journal ${path} is held by another writer. One bridge process owns ` +
        "submission; refusing to start a second.",
      { cause },
    );
    this.name = "JournalLockedError";
  }
}

/** The journal cannot answer a read; nothing about any operation is known. */
export class JournalUnreadableError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(`Settlement journal unreadable: ${detail}`, { cause });
    this.name = "JournalUnreadableError";
  }
}

/** A write was refused or failed; the operation's durable state is unchanged. */
export class JournalWriteError extends Error {
  constructor(
    readonly health: JournalHealth,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "JournalWriteError";
  }
}

interface OperationRow {
  operation_id: string;
  fingerprint: string;
  terms_json: string;
  state: OperationState;
  reason: string | null;
  retryable: number;
  hold: Hold | null;
  current_attempt: number | null;
  observation_json: string | null;
  created_at: number;
  updated_at: number;
}

interface AttemptRow {
  attempt: number;
  tx_hash: string;
  expiration_timestamp: string;
  prepared_at: number;
  may_broadcast_at: number | null;
}

interface HighWaterMark {
  journalId: string;
  generation: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  hold TEXT,
  current_attempt INTEGER,
  observation_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  attempt INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_bytes BLOB NOT NULL,
  expiration_timestamp TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  may_broadcast_at INTEGER,
  PRIMARY KEY (operation_id, attempt)
);
CREATE TABLE IF NOT EXISTS spends (
  operation_id TEXT PRIMARY KEY,
  amount TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface JournalOptions {
  /** Injectable for tests. */
  now?: () => number;
}

export class SettlementJournal {
  private db: Database.Database | null = null;
  private healthState: JournalHealth = { writable: true };
  private readonly now: () => number;
  private journalId = "";
  private generation = 0;
  private fresh = false;
  private bound = false;
  private readonly hwmPath: string;

  private constructor(
    readonly path: string,
    options: JournalOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.hwmPath = `${path}.hwm`;
  }

  /**
   * Opens (or creates) the journal and takes the writer lock.
   *
   * Throws `JournalLockedError` when another process holds it. Every other
   * defect opens the journal with writes disabled, so recovery reads keep
   * working: refusing to start would take the one authority on what was
   * broadcast offline exactly when it is needed.
   */
  static open(path: string, options: JournalOptions = {}): SettlementJournal {
    const journal = new SettlementJournal(path, options);
    journal.initialize();
    return journal;
  }

  private initialize(): void {
    let db: Database.Database;
    try {
      db = new Database(this.path, { timeout: 0 });
    } catch (cause) {
      this.disable("corrupt", `cannot open: ${(cause as Error).message}`);
      return;
    }
    this.db = db;
    try {
      db.pragma("locking_mode = EXCLUSIVE");
      db.pragma("journal_mode = DELETE");
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
    } catch (cause) {
      this.classifyOpenError(cause);
      return;
    }

    // The write that takes the exclusive lock. Before it, a second process
    // could still open the file; after it, it cannot until this one exits.
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("COMMIT");
    } catch (cause) {
      if (isBusy(cause)) {
        db.close();
        this.db = null;
        throw new JournalLockedError(this.path, cause);
      }
      this.classifyOpenError(cause);
      return;
    }

    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        this.disable("corrupt", `integrity_check: ${String(integrity)}`);
        return;
      }
      const hasMeta = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .get();
      if (!hasMeta) {
        this.createSchema(db);
      } else {
        this.loadMeta(db);
      }
    } catch (cause) {
      this.classifyOpenError(cause);
      return;
    }

    if (!this.healthState.writable) return;
    this.checkHighWaterMark();
    if (!this.healthState.writable) return;
    this.checkTransactionIdentity();
  }

  private classifyOpenError(cause: unknown): void {
    if (isBusy(cause)) {
      this.db?.close();
      this.db = null;
      throw new JournalLockedError(this.path, cause);
    }
    this.disable("corrupt", (cause as Error).message ?? String(cause));
  }

  private createSchema(db: Database.Database): void {
    const id = randomUUID();
    db.transaction(() => {
      db.exec(SCHEMA);
      const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      put.run("journal_id", id);
      put.run("schema_version", String(JOURNAL_SCHEMA_VERSION));
      put.run("generation", "0");
      put.run("created_at", String(this.now()));
    })();
    this.journalId = id;
    this.generation = 0;
    this.fresh = true;
    // Written at creation, so a later loss of the file is a visible event and
    // not indistinguishable from a journal that never had one.
    this.writeHighWaterMark();
  }

  private loadMeta(db: Database.Database): void {
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    const version = Number(meta.get("schema_version"));
    if (version !== JOURNAL_SCHEMA_VERSION) {
      this.disable(
        "unknown_schema_version",
        `journal schema ${meta.get("schema_version")} is not ${JOURNAL_SCHEMA_VERSION}`,
      );
    }
    this.journalId = meta.get("journal_id") ?? "";
    this.generation = Number(meta.get("generation") ?? "NaN");
    if (!this.journalId || !Number.isSafeInteger(this.generation)) {
      this.disable("corrupt", "journal meta is missing its id or generation");
    }
  }

  /**
   * Rollback detection. The generation bumps inside every write transaction
   * and is mirrored, after commit, into `<journal>.hwm`. A journal whose
   * generation is BELOW the mark, or whose id differs, was restored from an
   * older copy or swapped: operations it has forgotten may have broadcast. A
   * missing mark beside a journal that has written is the same uncertainty.
   * Above the mark is a crash between commit and mirror, and is normal.
   */
  private checkHighWaterMark(): void {
    if (this.fresh) return;
    let mark: HighWaterMark;
    try {
      mark = JSON.parse(readFileSync(this.hwmPath, "utf8")) as HighWaterMark;
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
      this.disable(
        "rollback_detected",
        missing
          ? `high-water mark ${this.hwmPath} is missing beside a used journal`
          : `high-water mark ${this.hwmPath} is unreadable: ${(cause as Error).message}`,
      );
      return;
    }
    if (mark.journalId !== this.journalId) {
      this.disable(
        "rollback_detected",
        `journal id ${this.journalId} is not the high-water mark's ${mark.journalId}`,
      );
    } else if (this.generation < mark.generation) {
      this.disable(
        "rollback_detected",
        `journal generation ${this.generation} is below the high-water mark ${mark.generation}`,
      );
    }
  }

  /** May-broadcast without a recorded transaction hash cannot be reconciled. */
  private checkTransactionIdentity(): void {
    const db = this.db!;
    const orphan = db
      .prepare(
        `SELECT o.operation_id FROM operations o
         WHERE o.state IN ('prepared', 'may_broadcast', 'finalized', 'reverted')
           AND NOT EXISTS (SELECT 1 FROM attempts a
                           WHERE a.operation_id = o.operation_id
                             AND a.attempt = o.current_attempt
                             AND length(a.tx_hash) = 66)
         LIMIT 1`,
      )
      .get() as { operation_id: string } | undefined;
    if (orphan) {
      this.disable(
        "missing_transaction_identity",
        `operation ${orphan.operation_id} may have broadcast but has no recorded transaction`,
      );
    }
  }

  /**
   * Binds the journal to the account it journals for, once the client knows
   * it. Until bound, writes are refused.
   *
   * A fresh journal next to an account that already existed on chain is the
   * lost-journal case: whatever the old journal knew -- may-broadcast marks,
   * transactions in flight -- is gone, and a plausible balance proves nothing
   * (§7 recovery: "A does not resume sends simply because balances appear
   * plausible"). Writes stay disabled unless the operator names the account
   * in `adoptAccount` (PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT), having reconciled.
   */
  bindAccount(address: string, accountPreexisted: boolean, adoptAccount?: string): void {
    if (!this.db || !this.healthState.writable) {
      this.bound = true;
      return;
    }
    const lower = address.toLowerCase();
    const stored = (
      this.db.prepare("SELECT value FROM meta WHERE key = 'account'").get() as
        | { value: string }
        | undefined
    )?.value;
    if (stored !== undefined) {
      if (stored !== lower) {
        this.disable("account_mismatch", `journal belongs to ${stored}, not ${lower}`);
      }
      this.bound = true;
      return;
    }
    const operations = (
      this.db.prepare("SELECT count(*) AS n FROM operations").get() as { n: number }
    ).n;
    if (accountPreexisted && operations === 0) {
      if (adoptAccount === undefined || adoptAccount.toLowerCase() !== lower) {
        this.disable(
          "empty_journal_for_existing_account",
          `account ${lower} existed before this journal; set ` +
            `PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT=${lower} only after reconciling every ` +
            "earlier transfer",
        );
        this.bound = true;
        return;
      }
    }
    this.write("bind account", (db) => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('account', ?)").run(lower);
    });
    this.bound = true;
  }

  health(): JournalHealth {
    if (this.healthState.writable && !this.bound) {
      return { writable: false, reason: "account_unbound", detail: "account not yet bound" };
    }
    return this.healthState;
  }

  get(operationId: string): StoredOperation | undefined {
    const row = this.read((db) =>
      db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId),
    ) as OperationRow | undefined;
    return row ? toOperation(row) : undefined;
  }

  attempts(operationId: string): Attempt[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `SELECT attempt, tx_hash, expiration_timestamp, prepared_at, may_broadcast_at
           FROM attempts WHERE operation_id = ? ORDER BY attempt`,
        )
        .all(operationId),
    ) as AttemptRow[];
    return rows.map((r) => ({
      attempt: r.attempt,
      txHash: r.tx_hash,
      expirationTimestamp: r.expiration_timestamp,
      preparedAt: r.prepared_at,
      mayBroadcastAt: r.may_broadcast_at,
    }));
  }

  /** The exact bytes of an attempt: what a re-broadcast sends, never rebuilt. */
  attemptBytes(operationId: string, attempt: number): Buffer {
    const row = this.read((db) =>
      db
        .prepare("SELECT tx_bytes FROM attempts WHERE operation_id = ? AND attempt = ?")
        .get(operationId, attempt),
    ) as { tx_bytes: Buffer } | undefined;
    if (!row) throw new JournalUnreadableError(`attempt ${attempt} of ${operationId} missing`);
    return row.tx_bytes;
  }

  /**
   * Claims an operation id for these terms, or reports what it already is.
   * Same id with a different fingerprint is a conflict and changes nothing.
   */
  claim(operationId: string, fingerprint: string, terms: SettlementTerms): ClaimResult {
    let result: ClaimResult | undefined;
    this.write("claim", (db) => {
      const row = db
        .prepare("SELECT * FROM operations WHERE operation_id = ?")
        .get(operationId) as OperationRow | undefined;
      if (row) {
        const operation = toOperation(row);
        result =
          row.fingerprint === fingerprint
            ? { kind: "existing", operation }
            : { kind: "conflict", operation };
        return false;
      }
      const at = this.now();
      db.prepare(
        `INSERT INTO operations (operation_id, fingerprint, terms_json, state, created_at, updated_at)
         VALUES (?, ?, ?, 'claimed', ?, ?)`,
      ).run(operationId, fingerprint, JSON.stringify(terms), at, at);
      result = {
        kind: "new",
        operation: toOperation(
          db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as OperationRow,
        ),
      };
      return true;
    });
    return result!;
  }

  /** Re-arms an operation that provably never broadcast, for a retry. */
  reclaim(operationId: string): void {
    this.transition("reclaim", operationId, ["not_submitted", "claimed"], (db, at) =>
      db
        .prepare(
          `UPDATE operations SET state = 'claimed', reason = NULL, retryable = 0, hold = NULL,
             current_attempt = NULL, updated_at = ? WHERE operation_id = ?`,
        )
        .run(at, operationId),
    );
  }

  /**
   * Flushes the exact prepared transaction BEFORE anything may broadcast it.
   * Returns the attempt number. Refused once any attempt is marked.
   */
  recordPrepared(
    operationId: string,
    tx: { txHash: string; txBytes: Buffer; expirationTimestamp: bigint },
  ): number {
    let attempt = 0;
    this.transition("record prepared", operationId, ["claimed", "prepared"], (db, at) => {
      const marked = db
        .prepare(
          "SELECT 1 FROM attempts WHERE operation_id = ? AND may_broadcast_at IS NOT NULL",
        )
        .get(operationId);
      if (marked) throw new Error("an attempt is already marked may-broadcast");
      const last = db
        .prepare("SELECT max(attempt) AS n FROM attempts WHERE operation_id = ?")
        .get(operationId) as { n: number | null };
      attempt = (last.n ?? 0) + 1;
      db.prepare(
        `INSERT INTO attempts (operation_id, attempt, tx_hash, tx_bytes, expiration_timestamp, prepared_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(operationId, attempt, tx.txHash.toLowerCase(), tx.txBytes, tx.expirationTimestamp.toString(), at);
      return db
        .prepare(
          `UPDATE operations SET state = 'prepared', current_attempt = ?, hold = NULL,
             updated_at = ? WHERE operation_id = ?`,
        )
        .run(attempt, at, operationId);
    });
    return attempt;
  }

  recordHold(operationId: string, hold: Hold): void {
    this.transition("record hold", operationId, ["prepared"], (db, at) =>
      db
        .prepare("UPDATE operations SET hold = ?, updated_at = ? WHERE operation_id = ?")
        .run(hold, at, operationId),
    );
  }

  /** Definitively not broadcast: only from states that cannot have been. */
  recordNotSubmitted(operationId: string, reason: string, retryable: boolean): void {
    this.transition("record not submitted", operationId, ["claimed", "prepared"], (db, at) =>
      db
        .prepare(
          `UPDATE operations SET state = 'not_submitted', reason = ?, retryable = ?, hold = NULL,
             updated_at = ? WHERE operation_id = ?`,
        )
        .run(reason, retryable ? 1 : 0, at, operationId),
    );
  }

  /**
   * The may-broadcast mark, and the spend it implies, in one transaction.
   * After this commits the operation is never abandoned, re-prepared or
   * refunded without authoritative resolution.
   */
  markMayBroadcast(operationId: string, attempt: number, amount: string): void {
    this.transition("mark may-broadcast", operationId, ["prepared"], (db, at) => {
      const updated = db
        .prepare(
          `UPDATE attempts SET may_broadcast_at = ?
           WHERE operation_id = ? AND attempt = ? AND may_broadcast_at IS NULL`,
        )
        .run(at, operationId, attempt);
      if (updated.changes !== 1) throw new Error(`attempt ${attempt} is not markable`);
      db.prepare("INSERT INTO spends (operation_id, amount, at) VALUES (?, ?, ?)").run(
        operationId,
        amount,
        at,
      );
      return db
        .prepare(
          `UPDATE operations SET state = 'may_broadcast', hold = NULL, updated_at = ?
           WHERE operation_id = ? AND current_attempt = ?`,
        )
        .run(at, operationId, attempt);
    });
  }

  /** Last non-terminal observation, kept so a read can show what was seen. */
  recordObservation(operationId: string, observation: Observation): void {
    this.transition("record observation", operationId, ["may_broadcast"], (db, at) =>
      db
        .prepare("UPDATE operations SET observation_json = ?, updated_at = ? WHERE operation_id = ?")
        .run(JSON.stringify(observation), at, operationId),
    );
  }

  /**
   * A finalized outcome (success or revert): durable, and never re-read.
   * Anything short of `receiptStatus: "finalized"` is refused.
   */
  recordTerminal(operationId: string, observation: Observation): void {
    if (
      (observation.state !== "finalized" && observation.state !== "reverted") ||
      observation.receiptStatus !== "finalized"
    ) {
      throw new JournalWriteError(this.healthState, "record terminal: observation is not final");
    }
    this.transition("record terminal", operationId, ["may_broadcast"], (db, at) =>
      db
        .prepare(
          `UPDATE operations SET state = ?, observation_json = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(observation.state, JSON.stringify(observation), at, operationId),
    );
  }

  /** Spends since `sinceMs`, for `TransactionLimits.restore()`. */
  spendsSince(sinceMs: number): { amount: bigint; timestamp: number }[] {
    const rows = this.read((db) =>
      db.prepare("SELECT amount, at FROM spends WHERE at >= ? ORDER BY at").all(sinceMs),
    ) as { amount: string; at: number }[];
    return rows.map((r) => ({ amount: BigInt(r.amount), timestamp: r.at }));
  }

  /** Operations a restart must reconcile: anything not provably settled. */
  unresolved(): string[] {
    const rows = this.read((db) =>
      db
        .prepare(
          "SELECT operation_id FROM operations WHERE state IN ('claimed', 'prepared', 'may_broadcast')",
        )
        .all(),
    ) as { operation_id: string }[];
    return rows.map((r) => r.operation_id);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** Exposed for the operator status line and tests. */
  meta(): { journalId: string; generation: number; dayMs: number } {
    return { journalId: this.journalId, generation: this.generation, dayMs: DAY_MS };
  }

  private read<T>(fn: (db: Database.Database) => T): T {
    if (!this.db) {
      throw new JournalUnreadableError(
        this.healthState.writable ? "journal closed" : this.healthState.detail,
      );
    }
    try {
      return fn(this.db);
    } catch (cause) {
      throw new JournalUnreadableError((cause as Error).message ?? String(cause), cause);
    }
  }

  private transition(
    what: string,
    operationId: string,
    from: OperationState[],
    apply: (db: Database.Database, at: number) => Database.RunResult,
  ): void {
    this.write(what, (db) => {
      const row = db
        .prepare("SELECT state FROM operations WHERE operation_id = ?")
        .get(operationId) as { state: OperationState } | undefined;
      if (!row || !from.includes(row.state)) {
        throw new StateError(
          `${what}: operation ${operationId} is ${row?.state ?? "absent"}, not ${from.join("|")}`,
        );
      }
      const result = apply(db, this.now());
      if (result.changes !== 1) {
        throw new StateError(`${what}: operation ${operationId} did not change`);
      }
      return true;
    });
  }

  /**
   * Runs `fn` as one durable transaction that bumps the generation, then
   * mirrors the generation to the high-water mark. `fn` returning false means
   * "nothing to write" and commits nothing.
   *
   * A refused or failed write throws `JournalWriteError`. An I/O-class failure
   * disables writes for the life of the process: the next write cannot be
   * trusted to land where this one did not. A state precondition failing is
   * a caller bug, not a durability fault, and leaves writes enabled.
   */
  private write(what: string, fn: (db: Database.Database) => boolean | void): void {
    const health = this.health();
    const binding = what === "bind account";
    if (!health.writable && !(binding && health.reason === "account_unbound")) {
      throw new JournalWriteError(health, `${what} refused: journal writes are disabled (${health.reason})`);
    }
    const db = this.db!;
    let changed = false;
    try {
      db.transaction(() => {
        changed = fn(db) !== false;
        if (changed) {
          db.prepare("UPDATE meta SET value = ? WHERE key = 'generation'").run(
            String(this.generation + 1),
          );
        }
      }).immediate();
    } catch (cause) {
      if (cause instanceof StateError) {
        throw new JournalWriteError(this.healthState, cause.message, { cause });
      }
      this.disable("write_failed", `${what}: ${(cause as Error).message ?? String(cause)}`);
      throw new JournalWriteError(this.healthState, `${what} failed`, { cause });
    }
    if (changed) {
      this.generation += 1;
      try {
        this.writeHighWaterMark();
      } catch (cause) {
        // Committed, but the mark is behind; the next open would read the
        // journal as above the mark, which is the benign direction. Still a
        // durability fault, so writes stop.
        this.disable("write_failed", `high-water mark: ${(cause as Error).message}`);
      }
    }
  }

  private writeHighWaterMark(): void {
    const tmp = `${this.hwmPath}.tmp`;
    const body = JSON.stringify({ journalId: this.journalId, generation: this.generation });
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.hwmPath);
    const dir = openSync(dirname(this.hwmPath), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }

  private disable(reason: WriteDisabledReason, detail: string): void {
    if (!this.healthState.writable) return;
    this.healthState = { writable: false, reason, detail };
    console.error(`[pxe-bridge] SETTLEMENT JOURNAL WRITES DISABLED (${reason}): ${detail}`);
  }
}

class StateError extends Error {}

function isBusy(cause: unknown): boolean {
  const code = (cause as { code?: string } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function toOperation(row: OperationRow): StoredOperation {
  return {
    operationId: row.operation_id,
    fingerprint: row.fingerprint,
    terms: JSON.parse(row.terms_json) as SettlementTerms,
    state: row.state,
    reason: row.reason,
    retryable: row.retryable === 1,
    hold: row.hold,
    currentAttempt: row.current_attempt,
    observation: row.observation_json ? (JSON.parse(row.observation_json) as Observation) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** True when a journal file exists at `path`; used to tell first boot apart. */
export function journalExists(path: string): boolean {
  return existsSync(path);
}
