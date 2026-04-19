import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { TransactionLimits } from "../src/limits.js";
import { AuditLogger } from "../src/audit.js";
import type {
  CreateNoteParams,
  CreateNoteResult,
  IAztecClient,
} from "../src/types.js";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const VALID_ADDR = "0x" + "a".repeat(64);
const JSON_HEADERS = { "Content-Type": "application/json" };

class FakeAztecClient implements IAztecClient {
  createNoteResult: CreateNoteResult = {
    noteCommitment: "0xcommit",
    nullifierHash: "0xnullifier",
    l2TxHash: "0xtx",
  };

  async connect(): Promise<void> {}

  async createNote(_params: CreateNoteParams): Promise<CreateNoteResult> {
    return this.createNoteResult;
  }

  async getVersion(): Promise<string> {
    return "4.2.0";
  }
}

function rpcBody(method: string, params: unknown[] = [], id: number = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function createNoteBody(amount: string) {
  return rpcBody("aztec_createNote", [
    { recipient: VALID_ADDR, token: VALID_ADDR, amount, chainId: 1 },
  ]);
}

describe("limits integration through server", () => {
  let server: Server;
  let baseUrl: string;
  let auditPath: string;

  beforeAll(async () => {
    auditPath = join(
      tmpdir(),
      `audit-int-${randomBytes(8).toString("hex")}.jsonl`,
    );
    const limits = new TransactionLimits({
      maxAmount: 10000n,
      dailyLimit: 50000n,
    });
    const audit = new AuditLogger(auditPath);
    const client = new FakeAztecClient();
    server = createApp(client, { limits, audit });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(auditPath).catch(() => {});
  });

  it("rejects amount above per-tx ceiling", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: JSON_HEADERS,
      body: createNoteBody("10001"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("per-transaction maximum");
  });

  it("allows amount within ceiling", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: JSON_HEADERS,
      body: createNoteBody("5000"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBeDefined();
    expect(body.result.l2TxHash).toBe("0xtx");
  });

  it("writes audit log entries for success and rejection", async () => {
    // Wait a tick for file writes to flush
    await new Promise((r) => setTimeout(r, 50));
    const content = await readFile(auditPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const rejected = lines.find((l) => JSON.parse(l).status === "rejected");
    expect(rejected).toBeDefined();
    const rejectedEntry = JSON.parse(rejected!);
    expect(rejectedEntry.amount).toBe("10001");
    expect(rejectedEntry.error).toContain("per-transaction maximum");

    const success = lines.find((l) => JSON.parse(l).status === "success");
    expect(success).toBeDefined();
    const successEntry = JSON.parse(success!);
    expect(successEntry.amount).toBe("5000");
    expect(successEntry.txHash).toBe("0xtx");
  });
});
