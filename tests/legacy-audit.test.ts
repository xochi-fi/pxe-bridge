import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyAuditRefusal } from "../src/legacy-audit.js";
import { SettlementJournal } from "../src/journal.js";
import { ACCOUNT, tempJournalPath } from "./settlement-fixtures.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** A pre-#45 audit line (the shape the legacy replay read back). */
function legacy(status: string, msAgo: number, key?: string): string {
  return JSON.stringify({
    timestamp: at(msAgo),
    method: "aztec_createNote",
    recipient: "0x" + "2".repeat(64),
    token: "0x" + "3".repeat(64),
    amount: "1000",
    chainId: 1,
    clientIp: "127.0.0.1",
    status,
    ...(key !== undefined ? { idempotencyKey: key } : {}),
  });
}

/** A journal-era output line: carries `observation`, never `status`. */
function current(msAgo: number): string {
  return JSON.stringify({
    timestamp: at(msAgo),
    method: "aztec_createNote",
    operationId: "op-1",
    fingerprint: "0x" + "a".repeat(64),
    recipient: "0x" + "2".repeat(64),
    token: "0x" + "3".repeat(64),
    amount: "1000",
    clientIp: "127.0.0.1",
    observation: "included",
  });
}

function logWith(...lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "legacy-audit-")), "audit.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("legacyAuditRefusal", () => {
  it("allows adoption when no legacy log exists", () => {
    expect(legacyAuditRefusal(join(tmpdir(), "no-such-dir", "audit.jsonl"), NOW)).toBeUndefined();
  });

  it("allows adoption over a drained log: every key resolved, nothing inside 24h", () => {
    const path = logWith(
      legacy("submitting", 30 * HOUR, "k1"),
      legacy("success", 30 * HOUR, "k1"),
      legacy("rejected", 26 * HOUR, "k2"),
      legacy("error", 25 * HOUR),
      current(HOUR),
    );
    expect(legacyAuditRefusal(path, NOW)).toBeUndefined();
  });

  it.each([
    ["submitting", "a crash between send and record"],
    ["unknown", "a transfer that may have moved funds"],
  ])("refuses a key whose last word is %s (%s), at any age", (status) => {
    const path = logWith(legacy(status, 30 * 24 * HOUR, "k-open"));
    expect(legacyAuditRefusal(path, NOW)).toMatch(/1 unresolved key\(s\) \(k-open\)/);
  });

  it("treats an appended reconciliation line as resolving the key", () => {
    const path = logWith(legacy("unknown", 40 * HOUR, "k1"), legacy("error", 39 * HOUR, "k1"));
    expect(legacyAuditRefusal(path, NOW)).toBeUndefined();
  });

  it.each([
    ["a keyless success", legacy("success", 2 * HOUR)],
    ["a keyed success", legacy("success", 23 * HOUR, "k1")],
    ["a keyless unknown", legacy("unknown", HOUR)],
  ])("refuses %s inside the last 24h", (_name, line) => {
    expect(legacyAuditRefusal(logWith(line), NOW)).toMatch(/spend\(s\) inside the last 24h/);
  });

  it("refuses a line it cannot place in the window", () => {
    const torn = legacy("success", 30 * HOUR).slice(0, 40);
    expect(legacyAuditRefusal(logWith(torn), NOW)).toMatch(/cannot be placed/);
    const undated = JSON.stringify({ status: "success", amount: "1" });
    expect(legacyAuditRefusal(logWith(undated), NOW)).toMatch(/cannot be placed/);
  });

  it("ignores journal-era lines entirely", () => {
    expect(legacyAuditRefusal(logWith(current(1), current(2)), NOW)).toBeUndefined();
  });
});

describe("adoption with a recent legacy audit log", () => {
  it("is refused, and writes stay disabled", () => {
    const log = logWith(legacy("success", HOUR, "k1"));
    const journal = SettlementJournal.open(tempJournalPath());
    journal.bindAccount(ACCOUNT, true, {
      acknowledgement: `${ACCOUNT}@${journal.meta().journalId}`,
      legacyAuditRefusal: () => legacyAuditRefusal(log, NOW),
    });
    expect(journal.health()).toMatchObject({
      writable: false,
      reason: "legacy_audit_unresolved",
      detail: expect.stringContaining("inside the last 24h"),
    });
  });
});
