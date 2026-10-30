import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { TransactionLimits } from "../src/limits.js";
import { AuditLogger } from "../src/audit.js";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { rpcJson } from "./helpers.js";
import {
  FakeAztecClient,
  openBoundJournal,
  rpcBody,
  settlementContext,
  v1Params,
} from "./settlement-fixtures.js";

function createNote(baseUrl: string, operationId: string, amount: string): Promise<Response> {
  return fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": operationId },
    body: JSON.stringify(rpcBody("aztec_createNote", [v1Params({ operationId, amount })])),
  });
}

describe("limits integration through server", () => {
  let server: Server;
  let baseUrl: string;
  let auditPath: string;
  const journal = openBoundJournal();

  beforeAll(async () => {
    auditPath = join(tmpdir(), `audit-int-${randomBytes(8).toString("hex")}.jsonl`);
    const limits = new TransactionLimits({
      maxAmount: 10000n,
      dailyLimit: 50000n,
    });
    const audit = new AuditLogger(auditPath);
    server = createApp(new FakeAztecClient(), {
      limits,
      audit,
      settlement: settlementContext(journal),
    });

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

  it("refuses an amount above the per-tx ceiling as not submitted", async () => {
    const res = await createNote(baseUrl, "over", "10001");
    expect(res.status).toBe(200);
    const body = await rpcJson(res);
    expect(body.error?.code).toBe(-32005);
    expect(JSON.stringify(body.error?.data)).toContain("per-transaction maximum");
    expect(journal.get("over")?.state).toBe("not_submitted");
  });

  it("allows an amount within the ceiling", async () => {
    const res = await createNote(baseUrl, "within", "5000");
    const body = await rpcJson<{ observation: { state: string } }>(res);
    expect(body.result?.observation.state).toBe("included");
  });

  it("writes identifier-free output-only audit lines for both", async () => {
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((line) => line.observation)).toEqual(["not_submitted", "included"]);
    for (const line of lines) {
      expect(Object.keys(line).every((key) =>
        ["timestamp", "method", "observation"].includes(key)
      )).toBe(true);
    }
    expect(JSON.stringify(lines)).not.toMatch(/over|within|10001|5000/);
  });
});
