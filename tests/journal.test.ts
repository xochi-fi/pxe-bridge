import { describe, it, expect } from "vitest";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  JournalLockedError,
  JournalUnreadableError,
  JournalWriteError,
  SettlementJournal,
} from "../src/journal.js";
import { CreateNoteV1Schema, fingerprintTerms, termsFrom } from "../src/settlement.js";
import { ACCOUNT, openBoundJournal, tempJournalPath, v1Params } from "./settlement-fixtures.js";

const terms = termsFrom(CreateNoteV1Schema.parse(v1Params()));
const fingerprint = fingerprintTerms(terms);
const tx = (n: number) => ({
  txHash: "0x" + n.toString(16).padStart(64, "0"),
  txBytes: Buffer.from(`tx-${n}`),
  expirationTimestamp: 1_900_000_000n,
});

/** Claims, prepares and marks one operation. */
function marked(journal: SettlementJournal, operationId = "op-1"): void {
  journal.claim(operationId, fingerprint, terms);
  const attempt = journal.recordPrepared(operationId, tx(1));
  journal.markMayBroadcast(operationId, attempt, terms.amount);
}

describe("SettlementJournal", () => {
  it("keeps every write across a close and reopen", () => {
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    marked(journal);
    journal.close();

    const reopened = SettlementJournal.open(path);
    reopened.bindAccount(ACCOUNT, true);
    expect(reopened.health()).toEqual({ writable: true });
    expect(reopened.get("op-1")).toMatchObject({ state: "may_broadcast", fingerprint, terms });
    expect(reopened.attemptBytes("op-1", 1)).toEqual(Buffer.from("tx-1"));
    expect(reopened.unresolved()).toEqual(["op-1"]);
  });

  it("refuses a second writer while the first holds the lock", () => {
    const path = tempJournalPath();
    const first = SettlementJournal.open(path);
    expect(() => SettlementJournal.open(path)).toThrow(JournalLockedError);
    first.close();
    expect(() => SettlementJournal.open(path).close()).not.toThrow();
  });

  it("reports a conflict for the same id with different terms and writes nothing", () => {
    const journal = openBoundJournal();
    journal.claim("op-1", fingerprint, terms);
    const before = journal.meta().generation;
    const res = journal.claim("op-1", "0x" + "f".repeat(64), terms);
    expect(res.kind).toBe("conflict");
    expect(journal.meta().generation).toBe(before);
  });

  it("never marks twice and never re-prepares a marked operation", () => {
    const journal = openBoundJournal();
    marked(journal);
    expect(() => journal.markMayBroadcast("op-1", 1, terms.amount)).toThrow(JournalWriteError);
    expect(() => journal.recordPrepared("op-1", tx(2))).toThrow(JournalWriteError);
    expect(() => journal.recordNotSubmitted("op-1", "x", true)).toThrow(JournalWriteError);
    // A precondition failure is a caller bug, not a durability fault.
    expect(journal.health()).toEqual({ writable: true });
  });

  it("records the spend in the same transaction as the mark, apart from tombstones", () => {
    const journal = openBoundJournal();
    marked(journal);
    expect(journal.spendsSince(0)).toEqual([{ amount: 1000n, timestamp: expect.any(Number) }]);
    expect(journal.spendsSince(Date.now() + 1)).toEqual([]);
    // Outside the spend window the operation and its bytes are still there.
    expect(journal.get("op-1")?.state).toBe("may_broadcast");
  });

  it("disables writes but keeps reads after a rollback to an older copy", () => {
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    journal.claim("op-1", fingerprint, terms);
    journal.close();
    copyFileSync(path, `${path}.backup`);

    const again = SettlementJournal.open(path);
    again.bindAccount(ACCOUNT, true);
    marked(again, "op-2");
    again.close();
    copyFileSync(`${path}.backup`, path);

    const restored = SettlementJournal.open(path);
    expect(restored.health()).toMatchObject({ writable: false, reason: "rollback_detected" });
    expect(restored.get("op-1")?.state).toBe("claimed");
    expect(() => restored.claim("op-3", fingerprint, terms)).toThrow(JournalWriteError);
  });

  it("treats a missing high-water mark beside a used journal as a rollback", () => {
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    marked(journal);
    journal.close();
    rmSync(`${path}.hwm`);
    const reopened = SettlementJournal.open(path);
    expect(reopened.health()).toMatchObject({ writable: false, reason: "rollback_detected" });
    expect(reopened.get("op-1")?.state).toBe("may_broadcast");
  });

  it("halts writes visibly on a corrupt file, and says it cannot read", () => {
    const path = tempJournalPath();
    writeFileSync(path, Buffer.alloc(4096, 0x5a));
    const journal = SettlementJournal.open(path);
    expect(journal.health()).toMatchObject({ writable: false, reason: "corrupt" });
    expect(() => journal.get("op-1")).toThrow(JournalUnreadableError);
    expect(() => journal.claim("op-1", fingerprint, terms)).toThrow(JournalWriteError);
  });

  it("refuses to adopt an account that existed before the journal", () => {
    const journal = SettlementJournal.open(tempJournalPath());
    journal.bindAccount(ACCOUNT, true);
    expect(journal.health()).toMatchObject({
      writable: false,
      reason: "empty_journal_for_existing_account",
    });
  });

  it("adopts an existing account only when the operator names it", () => {
    const journal = SettlementJournal.open(tempJournalPath());
    journal.bindAccount(ACCOUNT, true, ACCOUNT.toUpperCase().replace("0X", "0x"));
    expect(journal.health()).toEqual({ writable: true });
  });

  it("refuses writes until an account is bound, and refuses another account", () => {
    const path = tempJournalPath();
    const journal = SettlementJournal.open(path);
    expect(journal.health()).toMatchObject({ writable: false, reason: "account_unbound" });
    journal.bindAccount(ACCOUNT, false);
    journal.close();
    const other = SettlementJournal.open(path);
    other.bindAccount("0x" + "9".repeat(64), false);
    expect(other.health()).toMatchObject({ writable: false, reason: "account_mismatch" });
  });

  it("disables writes when a marked operation has no recorded transaction", () => {
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    marked(journal);
    journal.close();
    const db = new Database(path);
    db.prepare("DELETE FROM attempts").run();
    db.close();
    const reopened = SettlementJournal.open(path);
    expect(reopened.health()).toMatchObject({
      writable: false,
      reason: "missing_transaction_identity",
    });
    expect(reopened.get("op-1")?.state).toBe("may_broadcast");
  });

  it("disables writes on a schema version it does not know", () => {
    const path = tempJournalPath();
    openBoundJournal(path).close();
    const db = new Database(path);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();
    expect(SettlementJournal.open(path).health()).toMatchObject({
      writable: false,
      reason: "unknown_schema_version",
    });
  });

  it("mirrors every write's generation to the high-water mark", () => {
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    marked(journal);
    const mark = JSON.parse(readFileSync(`${path}.hwm`, "utf8")) as { generation: number };
    expect(mark.generation).toBe(journal.meta().generation);
  });
});
