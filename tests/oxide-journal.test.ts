import { copyFileSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { JournalLockedError } from "../src/journal.js";
import { AllowlistControlConflictError, OxideJournal } from "../src/oxide/journal.js";
import { fingerprintTerms } from "../src/settlement.js";
import { CAPS, evidenceFor, RECIPIENT, request, tempJournalPath } from "./oxide-fixtures.js";

const { terms } = request();
const tx = (n: number) => ({
  txHash: "0x" + n.toString(16).padStart(64, "0"),
  txBytes: Buffer.from(`tx-${n}`),
  expirationTimestamp: 1_900_000_000n,
  evidence: evidenceFor({ recipient: RECIPIENT, amount: BigInt(terms.amount) }),
});

function marked(journal: OxideJournal, id = "op-1") {
  journal.claim(id, terms);
  const attempt = journal.recordPrepared(id, tx(1));
  journal.markMayBroadcast(id, attempt, terms.amount, CAPS);
}

describe("OxideJournal", () => {
  it("keeps the prepared bytes, evidence and mark across a reopen", () => {
    const path = tempJournalPath();
    const journal = OxideJournal.open(path, { allowCreate: true });
    marked(journal);
    const evidence = journal.attemptEvidence("op-1", 1);
    journal.close();

    const reopened = OxideJournal.open(path);
    expect(reopened.health()).toEqual({ writable: true });
    expect(reopened.get("op-1")).toMatchObject({ state: "may_broadcast", terms });
    expect(reopened.attemptBytes("op-1", 1)).toEqual(Buffer.from("tx-1"));
    expect(reopened.attemptEvidence("op-1", 1)).toEqual(evidence);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("is one writer: a second open while the first lives is refused", () => {
    const path = tempJournalPath();
    const first = OxideJournal.open(path, { allowCreate: true });
    expect(() => OxideJournal.open(path)).toThrow(JournalLockedError);
    first.close();
  });

  it("never re-prepares or reclaims a marked operation", () => {
    const journal = OxideJournal.open(tempJournalPath(), { allowCreate: true });
    marked(journal);
    expect(() => journal.reclaim("op-1")).toThrow(/may_broadcast/);
    expect(() => journal.recordPrepared("op-1", tx(2))).toThrow(/may_broadcast/);
    expect(() => journal.markMayBroadcast("op-1", 1, terms.amount, CAPS)).toThrow(/may_broadcast/);
  });

  it("refuses an operation journaled by another file (not a settlement journal)", () => {
    const path = tempJournalPath();
    const db = new Database(path);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    expect(OxideJournal.open(path).health()).toMatchObject({ writable: false, reason: "corrupt" });
  });

  it("disables writes when a spend row no longer matches its mark", () => {
    const path = tempJournalPath();
    const journal = OxideJournal.open(path, { allowCreate: true });
    marked(journal);
    journal.close();
    const db = new Database(path);
    db.prepare("UPDATE spends SET amount = '1'").run();
    db.close();
    const reopened = OxideJournal.open(path);
    expect(reopened.health()).toMatchObject({ writable: false, reason: "journal_inconsistent" });
    // Reads still work; writes do not.
    expect(reopened.get("op-1")?.state).toBe("may_broadcast");
    expect(() => reopened.claim("op-2", terms)).toThrow(/disabled/);
  });

  it("disables writes on a rolled-back file", () => {
    const path = tempJournalPath();
    const journal = OxideJournal.open(path, { allowCreate: true });
    journal.claim("op-1", terms);
    journal.close();
    copyFileSync(path, `${path}.bak`);
    const again = OxideJournal.open(path);
    again.recordPrepared("op-1", tx(1));
    again.close();
    copyFileSync(`${path}.bak`, path); // the volume comes back with the older journal
    expect(OxideJournal.open(path).health()).toMatchObject({ writable: false, reason: "rollback_detected" });
  });

  it("disables writes when the high-water mark names another journal", () => {
    const path = tempJournalPath();
    OxideJournal.open(path, { allowCreate: true }).close();
    const mark = JSON.parse(readFileSync(`${path}.hwm`, "utf8")) as { generation: number };
    writeFileSync(`${path}.hwm`, JSON.stringify({ journalId: "other", generation: mark.generation }));
    expect(OxideJournal.open(path).health()).toMatchObject({ writable: false, reason: "rollback_detected" });
  });

  it("does not migrate schema 2 before rollback validation", () => {
    const path = tempJournalPath();
    OxideJournal.open(path, { allowCreate: true }).close();
    const db = new Database(path);
    db.exec(`
      DROP TABLE allowlist_control_audit;
      DROP TABLE allowlist_control_operations;
      DROP TABLE allowlist_control_state;
      UPDATE meta SET value = '2' WHERE key = 'schema_version';
    `);
    db.close();
    const mark = JSON.parse(readFileSync(`${path}.hwm`, "utf8")) as {
      journalId: string;
      generation: number;
    };
    writeFileSync(
      `${path}.hwm`,
      JSON.stringify({ ...mark, generation: mark.generation + 1 }),
    );

    const rolledBack = OxideJournal.open(path);
    expect(rolledBack.health()).toMatchObject({
      writable: false,
      reason: "rollback_detected",
    });
    rolledBack.close();
    const inspected = new Database(path, { readonly: true });
    expect(
      inspected.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get(),
    ).toBe("2");
    expect(
      inspected
        .prepare(
          "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'allowlist_control_%'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    inspected.close();
  });

  it("refuses malformed evidence at write and at open", () => {
    const path = tempJournalPath();
    const journal = OxideJournal.open(path, { allowCreate: true });
    journal.claim("op-1", terms);
    const bad = { ...tx(1), evidence: { ...tx(1).evidence, recipientNoteIndex: 5 } };
    expect(() => journal.recordPrepared("op-1", bad)).toThrow(/evidence/);
    journal.recordPrepared("op-1", tx(1));
    journal.close();
    const db = new Database(path);
    db.prepare("UPDATE attempts SET evidence_json = '{}'").run();
    db.close();
    expect(OxideJournal.open(path).health()).toMatchObject({ writable: false, reason: "journal_inconsistent" });
  });

  it("requires one-shot initialization for a brand-new journal", () => {
    const refused = OxideJournal.open(tempJournalPath());
    expect(refused.health()).toMatchObject({ writable: false, reason: "empty_journal_for_existing_account" });
  });

  it("never overwrites an orphaned high-water mark", () => {
    const path = tempJournalPath();
    OxideJournal.open(path, { allowCreate: true }).close();
    const mark = readFileSync(`${path}.hwm`, "utf8");
    unlinkSync(path);
    const refused = OxideJournal.open(path, { allowCreate: true });
    expect(refused.health()).toMatchObject({ writable: false, reason: "rollback_detected" });
    expect(readFileSync(`${path}.hwm`, "utf8")).toBe(mark);
  });

  it("binds the journal to its account, token and deployment", () => {
    const path = tempJournalPath();
    const identity = { account: "0x01", token: "0x02", deployment: "dep-v6:abc" };
    OxideJournal.open(path, { allowCreate: true, identity }).close();
    const refused = OxideJournal.open(path, { identity: { ...identity, account: "0x03" } });
    expect(refused.health()).toMatchObject({ writable: false, reason: "account_mismatch" });
  });

  // pxe-bridge#84: the row is keyed by the v2 request fingerprint, 1:1.
  it("keys an operation by its v2 fingerprint, and the same id with other v2 terms is a conflict", () => {
    const journal = OxideJournal.open(tempJournalPath(), { allowCreate: true });
    const first = journal.claim("op-1", terms);
    expect(first).toMatchObject({ kind: "new", operation: { fingerprint: fingerprintTerms(terms), terms } });
    expect(journal.claim("op-1", request().terms).kind).toBe("existing");
    for (const other of [
      request({ amount: (101n * 10n ** 18n).toString() }).terms,
      request({ validUntil: terms.validUntil + 1 }).terms,
      { ...terms, recipientDescriptorDigest: "0x" + "ee".repeat(32) },
      { ...terms, corridor: { ...terms.corridor, corridorRevision: 2 } },
    ]) {
      const claim = journal.claim("op-1", other);
      expect(claim.kind).toBe("conflict");
      expect(claim.operation.fingerprint).toBe(fingerprintTerms(terms));
    }
  });

  it("refuses to journal terms that are not an oxide send", () => {
    const journal = OxideJournal.open(tempJournalPath(), { allowCreate: true });
    expect(() => journal.claim("op-1", { ...terms, sendMode: "spending_limit" })).toThrow(/not journaled here/);
    expect(journal.get("op-1")).toBeUndefined();
  });

  it("refuses a phase-1 (schema 1) journal rather than read its terms as v2", () => {
    const path = tempJournalPath();
    OxideJournal.open(path, { allowCreate: true }).close();
    const db = new Database(path);
    db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    db.close();
    expect(OxideJournal.open(path).health()).toMatchObject({ writable: false, reason: "unknown_schema_version" });
  });

  it("disables writes on a stored row whose terms no longer hash to its fingerprint", () => {
    const path = tempJournalPath();
    const journal = OxideJournal.open(path, { allowCreate: true });
    marked(journal);
    journal.close();
    const db = new Database(path);
    db.prepare("UPDATE operations SET terms_json = ? WHERE operation_id = 'op-1'").run(
      JSON.stringify({ ...terms, recipientDescriptorDigest: "0x" + "ee".repeat(32) }),
    );
    db.close();
    expect(OxideJournal.open(path).health()).toMatchObject({
      writable: false,
      reason: "journal_inconsistent",
      detail: expect.stringContaining("not the fingerprint of the stored terms"),
    });
  });
  it("migrates schema 2 to the durable allowlist control schema", () => {
    const path = tempJournalPath();
    OxideJournal.open(path, { allowCreate: true }).close();
    const db = new Database(path);
    db.exec(`
      DROP TABLE allowlist_control_audit;
      DROP TABLE allowlist_control_operations;
      DROP TABLE allowlist_control_state;
      UPDATE meta SET value = '2' WHERE key = 'schema_version';
    `);
    db.close();
    const journal = OxideJournal.open(path);
    expect(journal.health()).toEqual({ writable: true });
    expect(journal.initializeAllowlistControl(`0x${"01".repeat(32)}`, [])).toMatchObject({
      sequence: "0",
    });
  });

  it("durably applies one monotonic allowlist replacement and reconciles an exact replay", () => {
    const path = tempJournalPath();
    const journal = OxideJournal.open(path, { allowCreate: true });
    const firstRoot = `0x${"11".repeat(32)}`;
    const nextRoot = `0x${"12".repeat(32)}`;
    const digest = `0x${"13".repeat(32)}`;
    const recipient = `0x${"14".repeat(32)}`;
    expect(journal.initializeAllowlistControl(firstRoot, [])).toEqual({
      sequence: "0",
      root: firstRoot,
      recipients: [],
    });
    const prepared = journal.prepareAllowlistControlOperation({
      operationId: "allow-1",
      action: "approve",
      recipient,
      sequence: "1",
      previousRoot: firstRoot,
      root: nextRoot,
      digest,
      recipients: [{ address: recipient, index: 17 }],
    });
    expect(prepared.state).toBe("prepared");
    expect(
      journal.authorizeAllowlistControlOperation("allow-1", "1", digest, `0x${"15".repeat(65)}`).state,
    ).toBe("authorized");
    expect(journal.applyAllowlistControlOperation("allow-1").state).toBe("applied");
    expect(journal.applyAllowlistControlOperation("allow-1").state).toBe("applied");
    journal.close();

    const reopened = OxideJournal.open(path);
    expect(reopened.allowlistControlState()).toEqual({
      sequence: "1",
      root: nextRoot,
      recipients: [{ address: recipient, index: 17 }],
    });
    expect(reopened.allowlistControlOperation("allow-1")).toMatchObject({
      state: "applied",
      sequence: "1",
      digest,
    });
  });

  it("allows only one delayed allowlist replacement at a time", () => {
    const journal = OxideJournal.open(tempJournalPath(), { allowCreate: true });
    const root0 = `0x${"31".repeat(32)}`;
    const root1 = `0x${"32".repeat(32)}`;
    const root2 = `0x${"33".repeat(32)}`;
    const digest1 = `0x${"34".repeat(32)}`;
    const digest2 = `0x${"35".repeat(32)}`;
    const recipient1 = `0x${"36".repeat(32)}`;
    const recipient2 = `0x${"37".repeat(32)}`;
    const operation1 = {
      operationId: "delayed-1",
      action: "approve" as const,
      recipient: recipient1,
      sequence: "1",
      previousRoot: root0,
      root: root1,
      digest: digest1,
      recipients: [{ address: recipient1, index: 1 }],
    };
    const operation2 = {
      operationId: "delayed-2",
      action: "approve" as const,
      recipient: recipient2,
      sequence: "2",
      previousRoot: root1,
      root: root2,
      digest: digest2,
      recipients: [
        { address: recipient1, index: 1 },
        { address: recipient2, index: 2 },
      ],
    };
    journal.initializeAllowlistControl(root0, []);
    expect(journal.prepareAllowlistControlOperation(operation1).state).toBe("prepared");
    expect(journal.prepareAllowlistControlOperation(operation1).state).toBe("prepared");
    expect(() => journal.prepareAllowlistControlOperation(operation2)).toThrow(
      AllowlistControlConflictError,
    );
    expect(journal.health()).toEqual({ writable: true });
    expect(
      journal.authorizeAllowlistControlOperation(
        operation1.operationId,
        operation1.sequence,
        operation1.digest,
        `0x${"38".repeat(65)}`,
      ).state,
    ).toBe("authorized");
    expect(() => journal.prepareAllowlistControlOperation(operation2)).toThrow(
      AllowlistControlConflictError,
    );
    expect(journal.applyAllowlistControlOperation(operation1.operationId).state).toBe("applied");
    expect(journal.prepareAllowlistControlOperation(operation2).state).toBe("prepared");
    expect(journal.prepareAllowlistControlOperation(operation2).state).toBe("prepared");
  });

  it("refuses stale sequence, conflicting replay, and unsigned application", () => {
    const journal = OxideJournal.open(tempJournalPath(), { allowCreate: true });
    const firstRoot = `0x${"21".repeat(32)}`;
    const nextRoot = `0x${"22".repeat(32)}`;
    const digest = `0x${"23".repeat(32)}`;
    const recipient = `0x${"24".repeat(32)}`;
    journal.initializeAllowlistControl(firstRoot, []);
    expect(() =>
      journal.prepareAllowlistControlOperation({
        operationId: "stale",
        action: "approve",
        recipient,
        sequence: "2",
        previousRoot: firstRoot,
        root: nextRoot,
        digest,
        recipients: [{ address: recipient, index: 1 }],
      }),
    ).toThrow(/monotonic/);
    journal.prepareAllowlistControlOperation({
      operationId: "allow-1",
      action: "approve",
      recipient,
      sequence: "1",
      previousRoot: firstRoot,
      root: nextRoot,
      digest,
      recipients: [{ address: recipient, index: 1 }],
    });
    expect(() => journal.applyAllowlistControlOperation("allow-1")).toThrow(/not authorized/);
    expect(() =>
      journal.prepareAllowlistControlOperation({
        operationId: "allow-1",
        action: "revoke",
        recipient,
        sequence: "1",
        previousRoot: firstRoot,
        root: nextRoot,
        digest,
        recipients: [],
      }),
    ).toThrow(/replayed/);
  });
});
