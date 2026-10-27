import { describe, it, expect } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  JournalLockedError,
  JournalPermissionError,
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

  it("adopts an existing account only with an acknowledgement naming THIS journal", () => {
    const journal = SettlementJournal.open(tempJournalPath());
    const ack = `${ACCOUNT.toUpperCase().replace("0X", "0x")}@${journal.meta().journalId}`;
    journal.bindAccount(ACCOUNT, true, { acknowledgement: ack });
    expect(journal.health()).toEqual({ writable: true });
  });

  it("refuses the pre-D-B bare-address acknowledgement", () => {
    const journal = SettlementJournal.open(tempJournalPath());
    journal.bindAccount(ACCOUNT, true, { acknowledgement: ACCOUNT });
    expect(journal.health()).toMatchObject({
      writable: false,
      reason: "empty_journal_for_existing_account",
      detail: expect.stringContaining(`PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT=${ACCOUNT}@${journal.meta().journalId}`),
    });
  });

  it("spends the acknowledgement once: it cannot authorise a later journal loss", () => {
    const first = SettlementJournal.open(tempJournalPath());
    const ack = `${ACCOUNT}@${first.meta().journalId}`;
    first.bindAccount(ACCOUNT, true, { acknowledgement: ack });
    expect(first.health()).toEqual({ writable: true });
    marked(first);
    first.close();

    // The journal is lost and a fresh one appears beside the same account,
    // with the old acknowledgement still in the environment.
    const replacement = SettlementJournal.open(tempJournalPath());
    expect(replacement.meta().journalId).not.toBe(first.meta().journalId);
    replacement.bindAccount(ACCOUNT, true, { acknowledgement: ack });
    expect(replacement.health()).toMatchObject({
      writable: false,
      reason: "empty_journal_for_existing_account",
    });
    expect(() => replacement.claim("op-2", fingerprint, terms)).toThrow(JournalWriteError);
  });

  it("ignores a leftover acknowledgement once the journal is bound", () => {
    const path = tempJournalPath();
    const journal = SettlementJournal.open(path);
    const ack = `${ACCOUNT}@${journal.meta().journalId}`;
    journal.bindAccount(ACCOUNT, true, { acknowledgement: ack });
    journal.close();
    const reopened = SettlementJournal.open(path);
    reopened.bindAccount(ACCOUNT, true, { acknowledgement: "anything@else" });
    expect(reopened.health()).toEqual({ writable: true });
  });

  it("refuses adoption while the legacy audit log says so, and never asks otherwise", () => {
    const journal = SettlementJournal.open(tempJournalPath());
    let asked = 0;
    journal.bindAccount(ACCOUNT, true, {
      acknowledgement: `${ACCOUNT}@${journal.meta().journalId}`,
      legacyAuditRefusal: () => {
        asked += 1;
        return "1 unresolved key(s) (k1)";
      },
    });
    expect(asked).toBe(1);
    expect(journal.health()).toMatchObject({
      writable: false,
      reason: "legacy_audit_unresolved",
      detail: expect.stringContaining("k1"),
    });

    // A fresh account adopts nothing, so the legacy log is not consulted.
    const fresh = SettlementJournal.open(tempJournalPath());
    fresh.bindAccount(ACCOUNT, false, { legacyAuditRefusal: () => "never asked" });
    expect(fresh.health()).toEqual({ writable: true });
  });

  it("refuses adoption when the legacy check itself fails", () => {
    const journal = SettlementJournal.open(tempJournalPath());
    journal.bindAccount(ACCOUNT, true, {
      acknowledgement: `${ACCOUNT}@${journal.meta().journalId}`,
      legacyAuditRefusal: () => {
        throw new Error("EACCES");
      },
    });
    expect(journal.health()).toMatchObject({ writable: false, reason: "legacy_audit_unresolved" });
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

describe("SettlementJournal startup invariant", () => {
  /** Leaves op-1 claimed, prepared or marked, then closes the journal. */
  function journalWith(state: "claimed" | "prepared" | "marked"): string {
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    journal.claim("op-1", fingerprint, terms);
    if (state !== "claimed") {
      const attempt = journal.recordPrepared("op-1", tx(1));
      if (state === "marked") journal.markMayBroadcast("op-1", attempt, terms.amount);
    }
    journal.close();
    return path;
  }

  /** Edits the file behind the journal's back; the generation is untouched. */
  function tamper(path: string, sql: string): void {
    const db = new Database(path);
    db.exec(sql);
    db.close();
  }

  it.each([
    ["a prepared operation with a marked attempt", "prepared", "UPDATE attempts SET may_broadcast_at = 1"],
    ["a prepared operation with a spend", "prepared", "INSERT INTO spends VALUES ('op-1', '1000', 1)"],
    ["a marked operation with no spend", "marked", "DELETE FROM spends"],
    ["a marked operation whose attempt is unmarked", "marked", "UPDATE attempts SET may_broadcast_at = NULL"],
    [
      "a claimed operation with a marked attempt",
      "marked",
      "UPDATE operations SET state = 'claimed', current_attempt = NULL; DELETE FROM spends",
    ],
    ["a spend for an operation never marked", "claimed", "INSERT INTO spends VALUES ('op-1', '1000', 1)"],
    ["a spend for an operation that does not exist", "marked", "INSERT INTO spends VALUES ('ghost', '1', 1)"],
    [
      "terms that are not the fingerprint's",
      "marked",
      `UPDATE operations SET terms_json = replace(terms_json, '"amount":"1000"', '"amount":"9"')`,
    ],
    ["a state the code never writes", "claimed", "UPDATE operations SET state = 'sending'"],
  ] as const)("disables writes (and so every replay) on %s, keeping reads", (_name, state, sql) => {
    const path = journalWith(state);
    tamper(path, sql);
    const reopened = SettlementJournal.open(path);
    reopened.bindAccount(ACCOUNT, false);
    expect(reopened.health()).toMatchObject({ writable: false, reason: "journal_inconsistent" });
    expect(reopened.get("op-1")).toBeDefined();
    expect(() => reopened.claim("op-1", fingerprint, terms)).toThrow(JournalWriteError);
  });

  it.each([
    ["a prepared operation", "prepared"],
    ["a marked operation", "marked"],
  ] as const)("treats a malformed transaction hash on %s as a missing identity", (_name, state) => {
    const path = journalWith(state);
    tamper(path, "UPDATE attempts SET tx_hash = '0x' || substr(tx_hash, 4)");
    expect(SettlementJournal.open(path).health()).toMatchObject({
      writable: false,
      reason: "missing_transaction_identity",
    });
  });

  it("passes every state the code itself writes", () => {
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    journal.claim("claimed", fingerprint, terms);
    journal.claim("held", fingerprint, terms);
    journal.recordPrepared("held", tx(6));
    journal.recordHold("held", "may_broadcast_denied");
    journal.claim("refused", fingerprint, terms);
    journal.recordNotSubmitted("refused", "corridor_mismatch", true);
    journal.claim("abandoned", fingerprint, terms);
    journal.recordPrepared("abandoned", tx(7));
    journal.recordNotSubmitted("abandoned", "validity_bound_passed", false);
    journal.claim("rearmed", fingerprint, terms);
    journal.recordNotSubmitted("rearmed", "prepare_failed", true);
    journal.reclaim("rearmed");
    marked(journal, "sent");
    journal.close();
    const reopened = SettlementJournal.open(path);
    reopened.bindAccount(ACCOUNT, false);
    expect(reopened.health()).toEqual({ writable: true });
  });
});

describe("SettlementJournal file permissions", () => {
  const mode = (path: string) => statSync(path).mode & 0o777;

  it("creates the journal and its high-water mark owner-only", () => {
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    marked(journal);
    expect(mode(path)).toBe(0o600);
    expect(mode(`${path}.hwm`)).toBe(0o600);
  });

  it("tightens an existing journal and its side files at open", () => {
    const path = tempJournalPath();
    openBoundJournal(path).close();
    chmodSync(path, 0o644);
    chmodSync(`${path}.hwm`, 0o644);
    // An empty rollback journal is not hot; SQLite ignores it.
    writeFileSync(`${path}-journal`, "", { mode: 0o644 });
    chmodSync(`${path}-journal`, 0o644);
    const reopened = SettlementJournal.open(path);
    expect(mode(path)).toBe(0o600);
    expect(mode(`${path}.hwm`)).toBe(0o600);
    if (existsSync(`${path}-journal`)) expect(mode(`${path}-journal`)).toBe(0o600);
    reopened.bindAccount(ACCOUNT, false);
    expect(reopened.health()).toEqual({ writable: true });
  });

  it("refuses to start in a directory others can write", () => {
    const path = tempJournalPath();
    chmodSync(dirname(path), 0o770);
    expect(() => SettlementJournal.open(path)).toThrow(JournalPermissionError);
    expect(existsSync(path)).toBe(false);
  });
});
