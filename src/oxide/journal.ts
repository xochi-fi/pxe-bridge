import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  enforceOwnerOnly,
  isBusy,
  JournalLockedError,
  JournalUnreadableError,
  JournalWriteError,
  writeHighWaterMarkFile,
  type JournalHealth,
  type WriteDisabledReason,
} from "../journal.js";
import { capRefusal, CapExceeded, WINDOW_MS, type OxideCapsConfig } from "./caps.js";
import {
  fingerprintOxideTerms,
  isOxideSendEvidence,
  type OxideHold,
  type OxideObservation,
  type OxideSendEvidence,
  type OxideTerms,
} from "./operation.js";

/**
 * The Oxide sender's journal: the createNote journal's semantics
 * (src/journal.ts, docs/settlement-operations.md "Journal") for an Oxide send,
 * in its own file because the terms and the per-attempt evidence differ.
 *
 * Shared with the settlement journal, deliberately: `synchronous=FULL` and a
 * rollback journal, the exclusive writer lock taken by a write at open, owner-
 * only files, the generation mirrored into `<journal>.hwm` for rollback
 * detection, writes disabled (reads kept) on any defect, and the startup
 * invariant over operations, attempts and spend rows.
 *
 * The rules that keep a restart from paying twice:
 *
 * - The exact proven transaction (bytes, hash, protocol expiration) and its
 *   evidence are written in one transaction BEFORE the may-broadcast mark. An
 *   attempt nothing journaled was never sent.
 * - The mark and the spend row commit together, and the mark re-checks the
 *   caps against the durable 24h window inside that transaction.
 * - A marked attempt is observation-only: it is never sent again, re-proved
 *   or abandoned without a finalized outcome.
 * - An unmarked prepared attempt is resent only as its journaled bytes.
 */

export const OXIDE_JOURNAL_SCHEMA_VERSION = 1;

export type OxideOperationState =
  | "claimed"
  | "prepared"
  | "not_submitted"
  | "may_broadcast"
  | "finalized"
  | "reverted";

export interface OxideStoredOperation {
  operationId: string;
  fingerprint: string;
  terms: OxideTerms;
  state: OxideOperationState;
  reason: string | null;
  retryable: boolean;
  hold: OxideHold | null;
  currentAttempt: number | null;
  observation: OxideObservation | null;
  createdAt: number;
  updatedAt: number;
}

export interface OxideAttempt {
  attempt: number;
  txHash: string;
  expirationTimestamp: string;
  preparedAt: number;
  mayBroadcastAt: number | null;
}

export type OxideClaimResult =
  | { kind: "new"; operation: OxideStoredOperation }
  | { kind: "existing"; operation: OxideStoredOperation }
  | { kind: "conflict"; operation: OxideStoredOperation };

interface OperationRow {
  operation_id: string;
  fingerprint: string;
  terms_json: string;
  state: OxideOperationState;
  reason: string | null;
  retryable: number;
  hold: OxideHold | null;
  current_attempt: number | null;
  observation_json: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE operations (
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
CREATE TABLE attempts (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  attempt INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_bytes BLOB NOT NULL,
  expiration_timestamp TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  may_broadcast_at INTEGER,
  PRIMARY KEY (operation_id, attempt)
);
CREATE TABLE spends (
  operation_id TEXT PRIMARY KEY,
  amount TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

class StateError extends Error {}

export interface OxideJournalOptions {
  now?: () => number;
}

export class OxideJournal {
  private db: Database.Database | null = null;
  private healthState: JournalHealth = { writable: true };
  private journalId = "";
  private generation = 0;
  private fresh = false;
  private readonly hwmPath: string;
  private readonly now: () => number;

  private constructor(
    readonly path: string,
    options: OxideJournalOptions,
  ) {
    this.hwmPath = `${path}.hwm`;
    this.now = options.now ?? Date.now;
  }

  /** Opens (or creates) the journal and takes the writer lock; `JournalLockedError` if another process holds it. */
  static open(path: string, options: OxideJournalOptions = {}): OxideJournal {
    const journal = new OxideJournal(path, options);
    journal.initialize();
    return journal;
  }

  private initialize(): void {
    enforceOwnerOnly(this.path, this.hwmPath);
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
      db.exec("BEGIN IMMEDIATE");
      db.exec("COMMIT");
    } catch (cause) {
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
      if (hasMeta) this.loadMeta(db);
      else this.createSchema(db);
    } catch (cause) {
      this.classifyOpenError(cause);
      return;
    }
    if (!this.healthState.writable) return;
    this.checkHighWaterMark();
    if (!this.healthState.writable) return;
    this.checkInvariants();
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
      put.run("schema_version", String(OXIDE_JOURNAL_SCHEMA_VERSION));
      put.run("generation", "0");
      put.run("kind", "oxide-send");
    })();
    this.journalId = id;
    this.generation = 0;
    this.fresh = true;
    writeHighWaterMarkFile(this.hwmPath, this.journalId, this.generation);
  }

  private loadMeta(db: Database.Database): void {
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    if (meta.get("kind") !== "oxide-send") {
      this.disable("corrupt", "not an Oxide sender journal");
      return;
    }
    if (Number(meta.get("schema_version")) !== OXIDE_JOURNAL_SCHEMA_VERSION) {
      this.disable("unknown_schema_version", `journal schema ${meta.get("schema_version")} is not supported`);
      return;
    }
    this.journalId = meta.get("journal_id") ?? "";
    this.generation = Number(meta.get("generation") ?? "NaN");
    if (!this.journalId || !Number.isSafeInteger(this.generation)) {
      this.disable("corrupt", "journal meta is missing its id or generation");
    }
  }

  /** Same rule as the settlement journal: below the mark, another id, or no mark beside a used journal. */
  private checkHighWaterMark(): void {
    if (this.fresh) return;
    let mark: unknown;
    try {
      mark = JSON.parse(readFileSync(this.hwmPath, "utf8")) as unknown;
    } catch (cause) {
      this.disable("rollback_detected", `high-water mark ${this.hwmPath} is missing or unreadable: ${(cause as Error).message}`);
      return;
    }
    const m = mark as { journalId?: unknown; generation?: unknown } | null;
    if (
      typeof m !== "object" ||
      m === null ||
      Object.keys(m).length !== 2 ||
      typeof m.journalId !== "string" ||
      typeof m.generation !== "number" ||
      !Number.isSafeInteger(m.generation)
    ) {
      this.disable("rollback_detected", `high-water mark ${this.hwmPath} is not an exact journalId/generation object`);
    } else if (m.journalId !== this.journalId) {
      this.disable("rollback_detected", `journal id ${this.journalId} is not the high-water mark's ${m.journalId}`);
    } else if (this.generation < m.generation) {
      this.disable("rollback_detected", `journal generation ${this.generation} is below the high-water mark ${m.generation}`);
    }
  }

  /**
   * prepared: current attempt identified and unmarked, nothing marked, no
   * spend. may_broadcast/finalized/reverted: the current attempt is the one
   * marked attempt and its spend row holds exactly the terms amount at the
   * mark's time. claimed/not_submitted: nothing marked, no spend. Every
   * attempt's evidence is evidence this code wrote; every fingerprint is the
   * fingerprint of its terms.
   */
  private checkInvariants(): void {
    const db = this.db!;
    const operations = db.prepare("SELECT * FROM operations").all() as OperationRow[];
    const attempts = db
      .prepare(
        `SELECT operation_id, attempt, tx_hash, expiration_timestamp, evidence_json, may_broadcast_at,
                length(tx_bytes) AS byte_length FROM attempts`,
      )
      .all() as {
      operation_id: string;
      attempt: number;
      tx_hash: string;
      expiration_timestamp: string;
      evidence_json: string;
      may_broadcast_at: number | null;
      byte_length: number;
    }[];
    const spends = new Map(
      (db.prepare("SELECT operation_id, amount, at FROM spends").all() as {
        operation_id: string;
        amount: unknown;
        at: unknown;
      }[]).map((r) => [r.operation_id, r]),
    );
    const known = new Set(operations.map((o) => o.operation_id));
    for (const a of attempts) {
      if (!known.has(a.operation_id)) {
        this.disable("journal_inconsistent", `attempt recorded for unknown operation ${a.operation_id}`);
        return;
      }
      let evidence: unknown;
      try {
        evidence = JSON.parse(a.evidence_json);
      } catch {
        evidence = undefined;
      }
      if (!isOxideSendEvidence(evidence)) {
        this.disable("journal_inconsistent", `attempt ${a.attempt} of ${a.operation_id} has malformed evidence`);
        return;
      }
    }
    for (const id of spends.keys()) {
      if (!known.has(id)) {
        this.disable("journal_inconsistent", `spend recorded for unknown operation ${id}`);
        return;
      }
    }
    for (const op of operations) {
      const id = op.operation_id;
      const own = attempts.filter((a) => a.operation_id === id);
      const marked = own.filter((a) => a.may_broadcast_at !== null);
      const current = own.find((a) => a.attempt === op.current_attempt);
      const identified =
        current !== undefined &&
        /^0x[0-9a-f]{64}$/.test(current.tx_hash) &&
        /^[0-9]+$/.test(current.expiration_timestamp) &&
        current.byte_length > 0;
      let terms: OxideTerms | undefined;
      try {
        terms = JSON.parse(op.terms_json) as OxideTerms;
      } catch {
        terms = undefined;
      }
      const spend = spends.get(id);
      let violation: string | undefined;
      switch (op.state) {
        case "prepared":
          if (!identified) {
            this.disable("missing_transaction_identity", `operation ${id} is prepared with no recorded transaction`);
            return;
          }
          if (marked.length > 0 || spend) violation = "prepared, but marked or spent";
          break;
        case "may_broadcast":
        case "finalized":
        case "reverted":
          if (!identified) {
            this.disable("missing_transaction_identity", `operation ${id} may have broadcast but has no recorded transaction`);
            return;
          }
          if (current.may_broadcast_at === null || marked.length !== 1) violation = `${op.state} without exactly one marked current attempt`;
          else if (!spend || spend.amount !== terms?.amount || spend.at !== current.may_broadcast_at) {
            violation = `${op.state} without the spend its mark writes`;
          }
          break;
        case "claimed":
        case "not_submitted":
          if (marked.length > 0 || spend) violation = `${op.state}, but marked or spent`;
          else if (op.state === "claimed" && op.current_attempt !== null) violation = "claimed with a current attempt";
          break;
        default:
          violation = `unknown state ${String(op.state)}`;
      }
      if (violation === undefined && (terms === undefined || fingerprintOxideTerms(terms) !== op.fingerprint)) {
        violation = "stored fingerprint is not the fingerprint of the stored terms";
      }
      if (violation !== undefined) {
        this.disable("journal_inconsistent", `operation ${id}: ${violation}`);
        return;
      }
    }
  }

  health(): JournalHealth {
    if (!this.db && this.healthState.writable) {
      return { writable: false, reason: "write_failed", detail: "journal closed" };
    }
    return this.healthState;
  }

  get(operationId: string): OxideStoredOperation | undefined {
    const row = this.read((db) => db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId)) as
      | OperationRow
      | undefined;
    return row ? toOperation(row) : undefined;
  }

  attempts(operationId: string): OxideAttempt[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `SELECT attempt, tx_hash, expiration_timestamp, prepared_at, may_broadcast_at
           FROM attempts WHERE operation_id = ? ORDER BY attempt`,
        )
        .all(operationId),
    ) as { attempt: number; tx_hash: string; expiration_timestamp: string; prepared_at: number; may_broadcast_at: number | null }[];
    return rows.map((r) => ({
      attempt: r.attempt,
      txHash: r.tx_hash,
      expirationTimestamp: r.expiration_timestamp,
      preparedAt: r.prepared_at,
      mayBroadcastAt: r.may_broadcast_at,
    }));
  }

  /** Exact attempt bytes, used only to resend an unmarked prepared attempt. */
  attemptBytes(operationId: string, attempt: number): Buffer {
    const row = this.read((db) =>
      db.prepare("SELECT tx_bytes FROM attempts WHERE operation_id = ? AND attempt = ?").get(operationId, attempt),
    ) as { tx_bytes: Buffer } | undefined;
    if (!row) throw new JournalUnreadableError(`attempt ${attempt} of ${operationId} missing`);
    return row.tx_bytes;
  }

  attemptEvidence(operationId: string, attempt: number): OxideSendEvidence {
    const row = this.read((db) =>
      db.prepare("SELECT evidence_json FROM attempts WHERE operation_id = ? AND attempt = ?").get(operationId, attempt),
    ) as { evidence_json: string } | undefined;
    if (!row) throw new JournalUnreadableError(`attempt ${attempt} of ${operationId} missing`);
    const evidence: unknown = JSON.parse(row.evidence_json);
    if (!isOxideSendEvidence(evidence)) throw new JournalUnreadableError(`attempt ${attempt} evidence malformed`);
    return evidence;
  }

  claim(operationId: string, terms: OxideTerms): OxideClaimResult {
    const fingerprint = fingerprintOxideTerms(terms);
    let result: OxideClaimResult | undefined;
    this.write("claim", (db) => {
      const row = db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as OperationRow | undefined;
      if (row) {
        const operation = toOperation(row);
        result = row.fingerprint === fingerprint ? { kind: "existing", operation } : { kind: "conflict", operation };
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

  /** Re-arms an operation that provably never broadcast. */
  reclaim(operationId: string): void {
    this.transition("reclaim", operationId, ["not_submitted", "claimed", "prepared"], (db, at) => {
      const marked = db
        .prepare("SELECT 1 FROM attempts WHERE operation_id = ? AND may_broadcast_at IS NOT NULL")
        .get(operationId);
      if (marked) throw new StateError("reclaim: an attempt is marked may-broadcast");
      return db
        .prepare(
          `UPDATE operations SET state = 'claimed', reason = NULL, retryable = 0, hold = NULL,
             current_attempt = NULL, updated_at = ? WHERE operation_id = ?`,
        )
        .run(at, operationId);
    });
  }

  /** The exact proven transaction and its evidence, durable before anything may send it. */
  recordPrepared(
    operationId: string,
    tx: { txHash: string; txBytes: Buffer; expirationTimestamp: bigint; evidence: OxideSendEvidence },
  ): number {
    if (!isOxideSendEvidence(tx.evidence)) {
      throw new JournalWriteError(this.healthState, "record prepared: evidence is malformed");
    }
    let attempt = 0;
    this.transition("record prepared", operationId, ["claimed"], (db, at) => {
      const last = db.prepare("SELECT max(attempt) AS n FROM attempts WHERE operation_id = ?").get(operationId) as {
        n: number | null;
      };
      attempt = (last.n ?? 0) + 1;
      db.prepare(
        `INSERT INTO attempts (operation_id, attempt, tx_hash, tx_bytes, expiration_timestamp, evidence_json, prepared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        operationId,
        attempt,
        tx.txHash.toLowerCase(),
        tx.txBytes,
        tx.expirationTimestamp.toString(),
        JSON.stringify(tx.evidence),
        at,
      );
      return db
        .prepare("UPDATE operations SET state = 'prepared', current_attempt = ?, hold = NULL, updated_at = ? WHERE operation_id = ?")
        .run(attempt, at, operationId);
    });
    return attempt;
  }

  recordHold(operationId: string, hold: OxideHold): void {
    this.transition("record hold", operationId, ["prepared"], (db, at) =>
      db.prepare("UPDATE operations SET hold = ?, updated_at = ? WHERE operation_id = ?").run(hold, at, operationId),
    );
  }

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
   * The may-broadcast mark and its spend row, in one transaction, re-checking
   * the caps against the durable 24h window first. Throws `CapExceeded` (and
   * writes nothing) when the window cannot take the amount.
   */
  markMayBroadcast(operationId: string, attempt: number, amount: string, caps: OxideCapsConfig): void {
    let refused: CapExceeded | undefined;
    this.transition("mark may-broadcast", operationId, ["prepared"], (db, at) => {
      const spent = sumSpends(db, at - WINDOW_MS);
      const refusal = capRefusal(caps, BigInt(amount), spent);
      if (refusal) {
        refused = new CapExceeded(refusal.reason, refusal.detail);
        throw new StateError(refused.message);
      }
      const updated = db
        .prepare(
          "UPDATE attempts SET may_broadcast_at = ? WHERE operation_id = ? AND attempt = ? AND may_broadcast_at IS NULL",
        )
        .run(at, operationId, attempt);
      if (updated.changes !== 1) throw new StateError(`attempt ${attempt} is not markable`);
      db.prepare("INSERT INTO spends (operation_id, amount, at) VALUES (?, ?, ?)").run(operationId, amount, at);
      return db
        .prepare(
          `UPDATE operations SET state = 'may_broadcast', hold = NULL, updated_at = ?
           WHERE operation_id = ? AND current_attempt = ?`,
        )
        .run(at, operationId, attempt);
    }, () => refused);
  }

  recordObservation(operationId: string, observation: OxideObservation): void {
    const terminal = observation.state === "finalized" || (observation.state === "reverted" && observation.receiptStatus === "finalized");
    this.transition("record observation", operationId, ["may_broadcast"], (db, at) =>
      db
        .prepare(`UPDATE operations SET state = ?, observation_json = ?, updated_at = ? WHERE operation_id = ?`)
        .run(terminal ? observation.state : "may_broadcast", JSON.stringify(observation), at, operationId),
    );
  }

  /**
   * Nullifiers of every other operation's attempt that may still land on a
   * chain whose state a simulation anchored at `anchorBlock` has not seen:
   * a prepared attempt whose bounds are open (it can still be allowed and
   * sent); a marked one not yet observed mined, before its protocol expiry;
   * and any attempt observed mined ABOVE `anchorBlock`, finalized included,
   * because the PXE that selected the notes has not synced that block. One
   * mined at or below the anchor is not live: the PXE has seen its nullifiers
   * and will not select those notes again.
   */
  liveNullifiers(nowSeconds: number, anchorBlock: number, exclude: string): Set<string> {
    const rows = this.read((db) =>
      db
        .prepare(
          `SELECT o.state, o.terms_json, a.expiration_timestamp, a.evidence_json,
                  CAST(json_extract(o.observation_json, '$.blockNumber') AS INTEGER) AS mined_block
           FROM operations o JOIN attempts a ON a.operation_id = o.operation_id AND a.attempt = o.current_attempt
           WHERE o.operation_id != ? AND (
             o.state = 'prepared'
             OR (o.state = 'may_broadcast' AND json_extract(o.observation_json, '$.blockNumber') IS NULL)
             OR (o.state IN ('may_broadcast', 'finalized', 'reverted')
                 AND CAST(json_extract(o.observation_json, '$.blockNumber') AS INTEGER) > ?)
           )`,
        )
        .all(exclude, anchorBlock),
    ) as {
      state: OxideOperationState;
      terms_json: string;
      expiration_timestamp: string;
      evidence_json: string;
      mined_block: number | null;
    }[];
    const live = new Set<string>();
    for (const row of rows) {
      const unexpired = BigInt(nowSeconds) < BigInt(row.expiration_timestamp);
      const counts =
        row.mined_block !== null
          ? row.mined_block > anchorBlock
          : row.state === "prepared"
            ? unexpired && nowSeconds < (JSON.parse(row.terms_json) as OxideTerms).validUntil
            : unexpired;
      if (!counts) continue;
      const evidence = JSON.parse(row.evidence_json) as OxideSendEvidence;
      for (const n of evidence.txNullifiers) live.add(n.toLowerCase());
    }
    return live;
  }

  /** Marked operations before their protocol expiry with no mined observation recorded: worth one node read. */
  unminedMarked(nowSeconds: number): string[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `SELECT o.operation_id, o.observation_json, a.expiration_timestamp
           FROM operations o JOIN attempts a ON a.operation_id = o.operation_id AND a.attempt = o.current_attempt
           WHERE o.state = 'may_broadcast' ORDER BY o.updated_at`,
        )
        .all(),
    ) as { operation_id: string; observation_json: string | null; expiration_timestamp: string }[];
    return rows
      .filter((r) => BigInt(nowSeconds) < BigInt(r.expiration_timestamp))
      .filter((r) => !r.observation_json || !("blockNumber" in (JSON.parse(r.observation_json) as object)))
      .map((r) => r.operation_id);
  }

  /** Total of durable spends at or after `sinceMs`. */
  spentSince(sinceMs: number): bigint {
    return this.read((db) => sumSpends(db, sinceMs));
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  meta(): { journalId: string; generation: number } {
    return { journalId: this.journalId, generation: this.generation };
  }

  private read<T>(fn: (db: Database.Database) => T): T {
    if (!this.db) {
      throw new JournalUnreadableError(this.healthState.writable ? "journal closed" : this.healthState.detail);
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
    from: OxideOperationState[],
    apply: (db: Database.Database, at: number) => Database.RunResult,
    rethrow?: () => Error | undefined,
  ): void {
    this.write(what, (db) => {
      const row = db.prepare("SELECT state FROM operations WHERE operation_id = ?").get(operationId) as
        | { state: OxideOperationState }
        | undefined;
      if (!row || !from.includes(row.state)) {
        throw new StateError(`${what}: operation ${operationId} is ${row?.state ?? "absent"}, not ${from.join("|")}`);
      }
      const result = apply(db, this.now());
      if (result.changes !== 1) throw new StateError(`${what}: operation ${operationId} did not change`);
      return true;
    }, rethrow);
  }

  /** One durable transaction bumping the generation, then the high-water mark. See SettlementJournal.write. */
  private write(what: string, fn: (db: Database.Database) => boolean | void, rethrow?: () => Error | undefined): void {
    const health = this.health();
    if (!health.writable) {
      throw new JournalWriteError(health, `${what} refused: journal writes are disabled (${health.reason})`);
    }
    const db = this.db!;
    let changed = false;
    try {
      db.transaction(() => {
        changed = fn(db) !== false;
        if (changed) {
          db.prepare("UPDATE meta SET value = ? WHERE key = 'generation'").run(String(this.generation + 1));
        }
      }).immediate();
    } catch (cause) {
      const specific = rethrow?.();
      if (specific) throw specific;
      if (cause instanceof StateError) throw new JournalWriteError(this.healthState, cause.message, { cause });
      this.disable("write_failed", `${what}: ${(cause as Error).message ?? String(cause)}`);
      throw new JournalWriteError(this.healthState, `${what} failed`, { cause });
    }
    if (changed) {
      this.generation += 1;
      try {
        writeHighWaterMarkFile(this.hwmPath, this.journalId, this.generation);
      } catch (cause) {
        this.disable("write_failed", `high-water mark: ${(cause as Error).message}`);
      }
    }
  }

  private disable(reason: WriteDisabledReason, detail: string): void {
    if (!this.healthState.writable) return;
    this.healthState = { writable: false, reason, detail };
    console.error(`[pxe-bridge] OXIDE JOURNAL WRITES DISABLED (${reason}): ${detail}`);
  }
}

function sumSpends(db: Database.Database, sinceMs: number): bigint {
  const rows = db.prepare("SELECT amount FROM spends WHERE at >= ?").all(sinceMs) as { amount: string }[];
  let total = 0n;
  for (const r of rows) total += BigInt(r.amount);
  return total;
}

function toOperation(row: OperationRow): OxideStoredOperation {
  return {
    operationId: row.operation_id,
    fingerprint: row.fingerprint,
    terms: JSON.parse(row.terms_json) as OxideTerms,
    state: row.state,
    reason: row.reason,
    retryable: row.retryable === 1,
    hold: row.hold,
    currentAttempt: row.current_attempt,
    observation: row.observation_json ? (JSON.parse(row.observation_json) as OxideObservation) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
