import { describe, it, expect, afterEach } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { AuditLogger, type AuditEntry } from "../src/audit.js";

function tmpPath(): string {
  return join(tmpdir(), `audit-test-${randomBytes(8).toString("hex")}.jsonl`);
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-04-19T00:00:00.000Z",
    method: "aztec_createNote",
    observation: "included",
    ...overrides,
  };
}

// Output only: nothing reads the log back since the settlement journal
// replaced it as the durable store (journal.test.ts).
describe("AuditLogger", () => {
  const files: string[] = [];

  afterEach(async () => {
    for (const f of files) {
      await unlink(f).catch(() => {});
    }
    files.length = 0;
  });

  it("writes JSON lines to a file", async () => {
    const path = tmpPath();
    files.push(path);
    const logger = new AuditLogger(path);

    await logger.log(entry());
    await logger.log(entry({ observation: "not_submitted" }));

    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first).toEqual({
      timestamp: "2026-04-19T00:00:00.000Z",
      method: "aztec_createNote",
      observation: "included",
    });

    const second = JSON.parse(lines[1]!);
    expect(second).toEqual({
      timestamp: "2026-04-19T00:00:00.000Z",
      method: "aztec_createNote",
      observation: "not_submitted",
    });
  });

  it("writes to stdout when no path given", async () => {
    const logger = new AuditLogger();
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await logger.log(entry());
    } finally {
      process.stdout.write = orig;
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/^\[audit\] /);
    const json = JSON.parse(chunks[0]!.replace("[audit] ", ""));
    expect(json.method).toBe("aztec_createNote");
  });

  it("contains no optional identifier-bearing fields", async () => {
    const path = tmpPath();
    files.push(path);
    const logger = new AuditLogger(path);

    await logger.log(entry());

    const content = await readFile(path, "utf8");
    expect(Object.keys(JSON.parse(content.trim())).sort()).toEqual([
      "method",
      "observation",
      "timestamp",
    ]);
  });
});
