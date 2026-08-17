import { describe, it, expect, afterEach } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { AuditLogger, replayAuditLog, type AuditEntry } from "../src/audit.js";
import { SUBMITTED_UNKNOWN_MESSAGE } from "../src/types.js";

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

describe("replayAuditLog", () => {
  const files: string[] = [];

  afterEach(async () => {
    await Promise.all(files.splice(0).map((f) => unlink(f).catch(() => undefined)));
  });

  /** Writes JSON lines and registers the file for cleanup. */
  async function writeLog(entries: Partial<AuditEntry>[]): Promise<string> {
    const path = tmpPath();
    files.push(path);
    await writeFile(path, entries.map((e) => JSON.stringify(entry(e))).join("\n") + "\n");
    return path;
  }

  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const amounts = (r: { spends: { amount: bigint }[] }) => r.spends.map((s) => s.amount);

  describe("spends", () => {
    it("round-trips what AuditLogger wrote", async () => {
      const path = tmpPath();
      files.push(path);
      const logger = new AuditLogger(path);
      await logger.log(entry({ timestamp: iso(0), amount: "1500" }));

      const { spends } = await replayAuditLog(path, 0);
      expect(spends).toHaveLength(1);
      expect(spends[0]!.amount).toBe(1500n);
    });

    // "unknown" counts. rpc.ts commits the reservation for a transfer that may
    // have landed, so a restart that skipped these would hand back budget the
    // running process had already spent.
    it("counts success and unknown, not rejected or error", async () => {
      const path = await writeLog([
        { timestamp: iso(0), amount: "100", status: "success" },
        { timestamp: iso(0), amount: "200", status: "rejected" },
        { timestamp: iso(0), amount: "400", status: "error" },
        { timestamp: iso(0), amount: "800", status: "unknown" },
      ]);

      expect(amounts(await replayAuditLog(path, 0))).toEqual([100n, 800n]);
    });

    // The intent record is not itself a spend; the outcome line that follows
    // is. Counting both would double every amount.
    it("does not count the submitting intent record", async () => {
      const path = await writeLog([
        { timestamp: iso(0), amount: "100", status: "submitting" },
        { timestamp: iso(0), amount: "100", status: "success" },
      ]);

      expect(amounts(await replayAuditLog(path, 0))).toEqual([100n]);
    });

    it("drops entries older than the cutoff", async () => {
      const path = await writeLog([
        { timestamp: iso(25 * 60 * 60 * 1000), amount: "100" },
        { timestamp: iso(60_000), amount: "200" },
      ]);

      expect(amounts(await replayAuditLog(path, Date.now() - 24 * 60 * 60 * 1000))).toEqual([200n]);
    });

    // A log killed mid-append leaves a partial final line. Refusing to boot
    // over that would turn an observability problem into an outage.
    it("skips a truncated final line and keeps the rest", async () => {
      const path = await writeLog([{ timestamp: iso(0), amount: "100" }]);
      await writeFile(path, (await readFile(path, "utf8")) + '{"status":"success","amo');

      expect(amounts(await replayAuditLog(path, 0))).toEqual([100n]);
    });

    it("treats a missing log as a first boot", async () => {
      expect(await replayAuditLog(tmpPath(), 0)).toEqual({ spends: [], keys: [] });
    });
  });

  describe("idempotency keys", () => {
    const success = {
      timestamp: "",
      status: "success" as const,
      idempotencyKey: "k1",
      txHash: "0xtx",
      noteHashes: ["0xn1", "0xn2"],
      nullifiers: ["0xu1", "0xu2", "0xu3"],
    };

    it("replays a success with its full result", async () => {
      const path = await writeLog([{ ...success, timestamp: iso(0) }]);

      const { keys } = await replayAuditLog(path, 0);
      expect(keys).toHaveLength(1);
      expect(keys[0]!.key).toBe("k1");
      expect(keys[0]!.outcome).toEqual({
        kind: "result",
        result: {
          noteHashes: ["0xn1", "0xn2"],
          nullifiers: ["0xu1", "0xu2", "0xu3"],
          l2TxHash: "0xtx",
          noteCommitment: "0xn1",
          nullifierHash: "0xu1",
        },
      });
    });

    it("ignores keys whose request moved nothing", async () => {
      const path = await writeLog([
        { timestamp: iso(0), status: "rejected", idempotencyKey: "k-rejected" },
        { timestamp: iso(0), status: "error", idempotencyKey: "k-error" },
      ]);

      expect((await replayAuditLog(path, 0)).keys).toEqual([]);
    });

    it("replays a post-submission failure as unknown, with the txHash", async () => {
      const path = await writeLog([
        { timestamp: iso(0), status: "unknown", idempotencyKey: "k1", txHash: "0xtx" },
      ]);

      const { keys } = await replayAuditLog(path, 0);
      expect(keys[0]!.outcome).toMatchObject({
        kind: "error",
        message: SUBMITTED_UNKNOWN_MESSAGE,
        data: { txHash: "0xtx" },
      });
    });

    // THE CRASH WINDOW. A submitting record with no successor means the
    // process died between the send and recording what it did, so whether
    // funds moved is exactly what is unknown. Treating it as fresh would hand
    // the key back and let a retry transfer a second time.
    it("replays an unfinished submitting record as unknown", async () => {
      const path = await writeLog([
        { timestamp: iso(0), status: "submitting", idempotencyKey: "k1" },
      ]);

      const { keys } = await replayAuditLog(path, 0);
      expect(keys[0]!.outcome).toMatchObject({
        kind: "error",
        message: SUBMITTED_UNKNOWN_MESSAGE,
      });
    });

    it("lets the outcome supersede the submitting record", async () => {
      const path = await writeLog([
        { timestamp: iso(0), status: "submitting", idempotencyKey: "k1" },
        { ...success, timestamp: iso(0) },
      ]);

      const { keys } = await replayAuditLog(path, 0);
      expect(keys).toHaveLength(1);
      expect(keys[0]!.outcome.kind).toBe("result");
    });

    // A retry after a definitive failure is legitimate, so the key was
    // abandoned in memory. The log must agree, or the retry would replay a
    // failure forever and the trade could never settle.
    it("frees a key whose retry then failed cleanly", async () => {
      const path = await writeLog([
        { ...success, timestamp: iso(0) },
        { timestamp: iso(0), status: "error", idempotencyKey: "k1" },
      ]);

      expect((await replayAuditLog(path, 0)).keys).toEqual([]);
    });

    // Downgraded rather than invented: handing back empty arrays would read as
    // a transfer that emitted no notes.
    it("downgrades a success recorded before effects were logged", async () => {
      const path = await writeLog([
        { timestamp: iso(0), status: "success", idempotencyKey: "k1", txHash: "0xtx" },
      ]);

      const { keys } = await replayAuditLog(path, 0);
      expect(keys[0]!.outcome).toMatchObject({
        kind: "error",
        message: SUBMITTED_UNKNOWN_MESSAGE,
        data: { txHash: "0xtx" },
      });
    });

    it("ignores entries with no key at all", async () => {
      const path = await writeLog([{ timestamp: iso(0), status: "success" }]);
      expect((await replayAuditLog(path, 0)).keys).toEqual([]);
    });
  });
});
