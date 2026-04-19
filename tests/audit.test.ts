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
    recipient: "0x" + "a".repeat(64),
    token: "0x" + "b".repeat(64),
    amount: "1000",
    chainId: 1,
    clientIp: "127.0.0.1",
    status: "success",
    txHash: "0xtx",
    ...overrides,
  };
}

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
    await logger.log(entry({ status: "rejected", error: "over limit" }));

    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.status).toBe("success");
    expect(first.txHash).toBe("0xtx");

    const second = JSON.parse(lines[1]!);
    expect(second.status).toBe("rejected");
    expect(second.error).toBe("over limit");
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

  it("includes optional fields when present", async () => {
    const path = tmpPath();
    files.push(path);
    const logger = new AuditLogger(path);

    await logger.log(entry({ tradeId: "0x" + "c".repeat(64) }));

    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.tradeId).toBe("0x" + "c".repeat(64));
  });

  it("omits undefined optional fields", async () => {
    const path = tmpPath();
    files.push(path);
    const logger = new AuditLogger(path);

    await logger.log(entry());

    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content.trim());
    expect("tradeId" in parsed).toBe(false);
    expect("error" in parsed).toBe(false);
  });
});
