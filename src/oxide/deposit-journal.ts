import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  enforceOwnerOnly,
  isBusy,
  JournalLockedError,
  writeHighWaterMarkFile,
} from "../journal.js";
import {
  OXIDE_DEPOSIT_PER_TX_CAP,
  OXIDE_DEPOSIT_ROLLING_CAP,
  OXIDE_DEPOSIT_WINDOW_MS,
  type VerifiedOxideDeposit,
} from "./deposit.js";

export type OxideDepositState = "verified" | "submitting" | "stored";

export interface OxideDepositJournalRecord extends VerifiedOxideDeposit {
  state: OxideDepositState;
  sendJournalId?: string;
  sendJournalGeneration?: number;
}

export interface OxideDepositJournalIdentity {
  walletDataDirectory: string;
  sendJournalId: string;
  account: string;
  token: string;
  deployment: string;
}

export interface OxideDepositJournalOptions {
  allowCreate?: boolean;
  now?: () => number;
  hwmPath: string;
  identity: OxideDepositJournalIdentity;
}

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE deposits (
  tx_hash TEXT PRIMARY KEY NOT NULL,
  event_id TEXT UNIQUE NOT NULL,
  log_index INTEGER NOT NULL,
  block_number TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp_ms INTEGER NOT NULL,
  amount TEXT NOT NULL,
  message_key TEXT UNIQUE NOT NULL,
  inbox_index TEXT UNIQUE NOT NULL,
  recipient_commitment TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verified', 'submitting', 'stored')),
  send_journal_id TEXT,
  send_journal_generation INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface DepositRow {
  tx_hash: string;
  event_id: string;
  log_index: number;
  block_number: string;
  block_hash: string;
  block_timestamp_ms: number;
  amount: string;
  message_key: string;
  inbox_index: string;
  recipient_commitment: string;
  state: OxideDepositState;
  send_journal_id: string | null;
  send_journal_generation: number | null;
  created_at: number;
}

/** Owner-only, rollback-detecting journal for the one-shot PXE store operation. */
export class OxideDepositJournal {
  private readonly db: Database.Database;
  private readonly hwmPath: string;
  private readonly now: () => number;
  private readonly identity: OxideDepositJournalIdentity;
  private journalId = "";
  private generation = 0;

  private constructor(
    readonly path: string,
    options: OxideDepositJournalOptions,
  ) {
    this.hwmPath = options.hwmPath;
    this.now = options.now ?? Date.now;
    const journalDirectory = resolve(dirname(path));
    const hwmDirectory = resolve(dirname(this.hwmPath));
    if (journalDirectory === hwmDirectory) {
      throw new Error(
        "deposit journal high-water mark must use a separate rollback domain",
      );
    }
    const hwmDirectoryMode = statSync(hwmDirectory).mode & 0o777;
    if ((hwmDirectoryMode & 0o022) !== 0) {
      throw new Error(
        `${hwmDirectory} is writable by group or others (mode ${hwmDirectoryMode.toString(8)}); make it 0700`,
      );
    }
    this.identity = options.identity;
    const journalExisted = existsSync(path);
    const hwmExisted = existsSync(this.hwmPath);
    enforceOwnerOnly(path, this.hwmPath);
    try {
      this.db = new Database(path, { timeout: 0 });
      this.db.pragma("locking_mode = EXCLUSIVE");
      this.db.pragma("journal_mode = DELETE");
      this.db.pragma("synchronous = FULL");
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec("COMMIT");
    } catch (cause) {
      if (isBusy(cause)) throw new JournalLockedError(path, cause);
      throw cause;
    }
    const integrity = this.db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new Error(
        `deposit journal integrity check failed: ${String(integrity)}`,
      );
    const hasMeta = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
      )
      .get();
    if (hasMeta) {
      this.loadMeta();
      this.checkHighWaterMark();
    } else {
      if (journalExisted || hwmExisted) {
        throw new Error(
          "deposit journal or high-water mark exists without a valid schema",
        );
      }
      if (options.allowCreate !== true) {
        throw new Error(
          "deposit journal does not exist; pass --initialize-journal exactly once",
        );
      }
      this.createSchema();
    }
    this.checkRows();
  }

  static open(
    path: string,
    options: OxideDepositJournalOptions,
  ): OxideDepositJournal {
    return new OxideDepositJournal(path, options);
  }

  get(txHash: string): OxideDepositJournalRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM deposits WHERE tx_hash = ?")
      .get(txHash.toLowerCase()) as DepositRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  recordVerified(deposit: VerifiedOxideDeposit): OxideDepositJournalRecord {
    const existing = this.get(deposit.txHash);
    if (existing) {
      assertSameDeposit(existing, deposit);
      return existing;
    }
    const eventOwner = this.db
      .prepare("SELECT tx_hash FROM deposits WHERE event_id = ?")
      .get(deposit.eventId) as { tx_hash: string } | undefined;
    if (eventOwner)
      throw new Error(
        `deposit event is already journaled under ${eventOwner.tx_hash}`,
      );
    const at = this.admissionTime();
    this.assertRollingCap(deposit.amount, at);
    this.write(() => {
      this.db
        .prepare(
          `INSERT INTO deposits (
             tx_hash, event_id, log_index, block_number, block_hash, block_timestamp_ms,
             amount, message_key, inbox_index, recipient_commitment, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
        )
        .run(
          deposit.txHash,
          deposit.eventId,
          deposit.logIndex,
          deposit.blockNumber.toString(),
          deposit.blockHash,
          deposit.blockTimestampMs,
          deposit.amount.toString(),
          deposit.messageKey,
          deposit.inboxIndex.toString(),
          deposit.recipientCommitment,
          at,
          at,
        );
    });
    return this.get(deposit.txHash)!;
  }

  markSubmitting(
    txHash: string,
    sendJournal: { journalId: string; generation: number },
  ): OxideDepositJournalRecord {
    const normalized = txHash.toLowerCase();
    const record = this.require(normalized);
    if (record.state !== "verified")
      throw new Error(`deposit ${normalized} is already ${record.state}`);
    if (
      sendJournal.journalId !== this.identity.sendJournalId ||
      !Number.isSafeInteger(sendJournal.generation) ||
      sendJournal.generation < 0
    ) {
      throw new Error("Oxide send journal checkpoint is invalid");
    }
    this.write(() => {
      const changed = this.db
        .prepare(
          `UPDATE deposits
             SET state = 'submitting', send_journal_id = ?,
                 send_journal_generation = ?, updated_at = ?
           WHERE tx_hash = ? AND state = 'verified'`,
        )
        .run(
          sendJournal.journalId,
          sendJournal.generation,
          this.now(),
          normalized,
        );
      if (changed.changes !== 1)
        throw new Error(`deposit ${normalized} changed state concurrently`);
    });
    return this.require(normalized);
  }

  markStored(txHash: string): OxideDepositJournalRecord {
    const normalized = txHash.toLowerCase();
    const record = this.require(normalized);
    if (record.state === "stored") return record;
    if (record.state !== "submitting")
      throw new Error(`deposit ${normalized} was never submitted to PXE`);
    this.write(() => {
      const changed = this.db
        .prepare(
          "UPDATE deposits SET state = 'stored', updated_at = ? WHERE tx_hash = ? AND state = 'submitting'",
        )
        .run(this.now(), normalized);
      if (changed.changes !== 1)
        throw new Error(`deposit ${normalized} changed state concurrently`);
    });
    return this.require(normalized);
  }

  close(): void {
    this.db.close();
  }

  private require(txHash: string): OxideDepositJournalRecord {
    const record = this.get(txHash);
    if (!record) throw new Error(`deposit ${txHash} is not journaled`);
    return record;
  }

  private admissionTime(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("local admission time is invalid");
    const latest = this.db
      .prepare("SELECT MAX(created_at) AS at FROM deposits")
      .get() as {
      at: number | null;
    };
    return Math.max(now, latest.at ?? 0);
  }

  private assertRollingCap(amount: bigint, admittedAt: number): void {
    const rows = this.db
      .prepare("SELECT created_at, amount FROM deposits")
      .all() as {
      created_at: number;
      amount: string;
    }[];
    assertRollingCap([
      ...rows.map((row) => ({
        at: row.created_at,
        amount: BigInt(row.amount),
      })),
      { at: admittedAt, amount },
    ]);
  }

  private createSchema(): void {
    this.journalId = randomUUID();
    this.db.transaction(() => {
      this.db.exec(SCHEMA);
      const put = this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?)",
      );
      put.run("kind", "oxide-deposit-store");
      put.run("schema_version", String(SCHEMA_VERSION));
      put.run("journal_id", this.journalId);
      put.run("generation", "0");
      put.run(
        "identity_wallet_data_directory",
        this.identity.walletDataDirectory,
      );
      put.run("identity_send_journal_id", this.identity.sendJournalId);
      put.run("identity_account", this.identity.account);
      put.run("identity_token", this.identity.token);
      put.run("identity_deployment", this.identity.deployment);
    })();
    writeHighWaterMarkFile(this.hwmPath, this.journalId, 0);
  }

  private loadMeta(): void {
    const meta = new Map(
      (
        this.db.prepare("SELECT key, value FROM meta").all() as {
          key: string;
          value: string;
        }[]
      ).map((row) => [row.key, row.value]),
    );
    if (meta.get("kind") !== "oxide-deposit-store")
      throw new Error("not an Oxide deposit journal");
    if (Number(meta.get("schema_version")) !== SCHEMA_VERSION) {
      throw new Error(
        `unsupported Oxide deposit journal schema ${meta.get("schema_version")}`,
      );
    }
    this.journalId = meta.get("journal_id") ?? "";
    this.generation = Number(meta.get("generation"));
    if (
      !this.journalId ||
      !Number.isSafeInteger(this.generation) ||
      this.generation < 0
    ) {
      throw new Error("Oxide deposit journal metadata is invalid");
    }
    if (
      meta.get("identity_wallet_data_directory") !==
        this.identity.walletDataDirectory ||
      meta.get("identity_send_journal_id") !== this.identity.sendJournalId ||
      meta.get("identity_account") !== this.identity.account ||
      meta.get("identity_token") !== this.identity.token ||
      meta.get("identity_deployment") !== this.identity.deployment
    ) {
      throw new Error(
        "Oxide deposit journal identity does not match this wallet and deployment",
      );
    }
  }

  private checkHighWaterMark(): void {
    let mark: unknown;
    try {
      mark = JSON.parse(readFileSync(this.hwmPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `deposit journal high-water mark is missing or unreadable: ${(cause as Error).message}`,
      );
    }
    const parsed = mark as { journalId?: unknown; generation?: unknown } | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Object.keys(parsed).length !== 2 ||
      parsed.journalId !== this.journalId ||
      typeof parsed.generation !== "number" ||
      !Number.isSafeInteger(parsed.generation) ||
      this.generation < parsed.generation
    ) {
      throw new Error("deposit journal rollback detected");
    }
  }

  private checkRows(): void {
    const rows = this.db
      .prepare("SELECT * FROM deposits")
      .all() as DepositRow[];
    const deposits: { at: number; amount: bigint }[] = [];
    for (const row of rows) {
      const record = fromRow(row);
      if (
        !/^0x[0-9a-f]{64}$/.test(record.txHash) ||
        !/^0x[0-9a-f]{64}$/.test(record.blockHash) ||
        !/^0x[0-9a-f]{64}$/.test(record.messageKey) ||
        !/^0x[0-9a-f]{64}$/.test(record.recipientCommitment) ||
        !Number.isSafeInteger(row.created_at) ||
        row.created_at < 0 ||
        record.blockNumber < 0n ||
        record.inboxIndex < 0n ||
        record.amount <= 0n ||
        record.amount > OXIDE_DEPOSIT_PER_TX_CAP ||
        record.eventId !==
          `${record.txHash}:${record.logIndex}:${record.messageKey}:${record.inboxIndex}`
      ) {
        throw new Error(`deposit journal row ${record.txHash} is invalid`);
      }
      deposits.push({ at: row.created_at, amount: record.amount });
      if (record.state === "verified") {
        if (
          record.sendJournalId !== undefined ||
          record.sendJournalGeneration !== undefined
        ) {
          throw new Error(
            `verified deposit ${record.txHash} contains submission state`,
          );
        }
      } else if (
        record.sendJournalId !== this.identity.sendJournalId ||
        record.sendJournalGeneration === undefined ||
        !Number.isSafeInteger(record.sendJournalGeneration) ||
        record.sendJournalGeneration < 0
      ) {
        throw new Error(
          `${record.state} deposit ${record.txHash} has invalid submission state`,
        );
      }
    }
    assertRollingCap(deposits);
  }

  private write(fn: () => void): void {
    this.db.transaction(() => {
      fn();
      this.generation += 1;
      this.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'generation'")
        .run(String(this.generation));
    })();
    writeHighWaterMarkFile(this.hwmPath, this.journalId, this.generation);
  }
}

function fromRow(row: DepositRow): OxideDepositJournalRecord {
  if (!Number.isSafeInteger(row.log_index) || row.log_index < 0)
    throw new Error("deposit log index is invalid");
  if (
    !Number.isSafeInteger(row.block_timestamp_ms) ||
    row.block_timestamp_ms < 0
  ) {
    throw new Error("deposit block timestamp is invalid");
  }
  const base: OxideDepositJournalRecord = {
    txHash: row.tx_hash as `0x${string}`,
    eventId: row.event_id,
    logIndex: row.log_index,
    blockNumber: BigInt(row.block_number),
    blockHash: row.block_hash as `0x${string}`,
    blockTimestampMs: row.block_timestamp_ms,
    amount: BigInt(row.amount),
    messageKey: row.message_key as `0x${string}`,
    inboxIndex: BigInt(row.inbox_index),
    recipientCommitment: row.recipient_commitment as `0x${string}`,
    state: row.state,
  };
  if (row.send_journal_id !== null) base.sendJournalId = row.send_journal_id;
  if (row.send_journal_generation !== null)
    base.sendJournalGeneration = row.send_journal_generation;
  return base;
}

function assertSameDeposit(
  existing: OxideDepositJournalRecord,
  deposit: VerifiedOxideDeposit,
): void {
  if (
    existing.eventId !== deposit.eventId ||
    existing.logIndex !== deposit.logIndex ||
    existing.blockNumber !== deposit.blockNumber ||
    existing.blockHash !== deposit.blockHash ||
    existing.blockTimestampMs !== deposit.blockTimestampMs ||
    existing.amount !== deposit.amount ||
    existing.messageKey !== deposit.messageKey ||
    existing.inboxIndex !== deposit.inboxIndex ||
    existing.recipientCommitment !== deposit.recipientCommitment
  ) {
    throw new Error(
      `journaled deposit ${deposit.txHash} does not match the finalized receipt`,
    );
  }
}

function assertRollingCap(deposits: { at: number; amount: bigint }[]): void {
  deposits.sort((a, b) => a.at - b.at);
  let start = 0;
  let total = 0n;
  for (let end = 0; end < deposits.length; end += 1) {
    total += deposits[end]!.amount;
    while (deposits[end]!.at - deposits[start]!.at >= OXIDE_DEPOSIT_WINDOW_MS) {
      total -= deposits[start]!.amount;
      start += 1;
    }
    if (total > OXIDE_DEPOSIT_ROLLING_CAP) {
      throw new Error(
        `deposit exceeds the rolling 24h cap of ${OXIDE_DEPOSIT_ROLLING_CAP}`,
      );
    }
  }
}
