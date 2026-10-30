import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { AztecClient, TX_TIMEOUT_MS } from "../../src/aztec-client.js";
import { createApp } from "../../src/server.js";
import { SettlementJournal } from "../../src/journal.js";
import { SETTLEMENT_VERSION } from "../../src/settlement.js";
import { TransactionLimits } from "../../src/limits.js";
import { createReadinessObserver } from "../../src/readiness.js";
import {
  getTestConfig,
  requireTestToken,
  walletDataDirectory,
} from "./helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CORRIDOR = {
  corridorId: "0x" + "c2".repeat(32),
  corridorRevision: 1,
  manifestDigest: "0x" + "d2".repeat(32),
  genesisOrNetworkDigest: "0x" + "e2".repeat(32),
};

const config = getTestConfig();
const API_KEY = "e2e-readiness-key";

describe("HTTP server (e2e)", () => {
  let client: AztecClient;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    client = new AztecClient(
      config.nodeUrl,
      config.secretKey,
      config.feeJuiceClaim,
      undefined,
      undefined,
      walletDataDirectory("server"),
    );
    await client.connect();

    // The account is shared with the other suites, so it predates this
    // journal; adopting it is the operator acknowledgement the bridge needs.
    const journal = SettlementJournal.open(
      join(mkdtempSync(join(tmpdir(), "e2e-journal-")), "j.sqlite"),
    );
    journal.bindAccount(client.getAddress()!, client.accountPreexisted(), {
      acknowledgement: `${client.getAddress()!}@${journal.meta().journalId}`,
    });
    const limits = new TransactionLimits({
      maxAmount: 1_000n,
      dailyLimit: 10_000n,
    });
    const readiness = createReadinessObserver(client, {
      journal,
      limits,
      mayBroadcastConfigured: true,
      corridor: CORRIDOR,
    });
    server = createApp(client, {
      apiKey: API_KEY,
      limits,
      readiness,
      settlement: {
        journal,
        mayBroadcast: async () => ({ decision: "allow", detail: "e2e" }),
        corridor: CORRIDOR,
        inFlight: new Set<string>(),
        timeoutMs: TX_TIMEOUT_MS,
        readiness,
      },
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
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function rpcBody(
    method: string,
    params: unknown[] = [],
    id: number | string = 1,
  ) {
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
  }

  describe("GET /status and /ready", () => {
    it("returns only minimal public liveness", async () => {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });

    it("reports the live standard account not ready for design-A", async () => {
      const res = await fetch(`${baseUrl}/ready`, {
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining(["account_mode_not_spending_limit"]),
      });
    });
  });

  describe("aztec_getVersion via JSON-RPC", () => {
    it("returns version from live node via POST /", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
        },
        body: rpcBody("aztec_getVersion"),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        jsonrpc: string;
        id: number;
        result: string;
      };
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      expect(body.result).toBeTruthy();
      expect(typeof body.result).toBe("string");
    });

    it("works via POST /api/rpc alias", async () => {
      const res = await fetch(`${baseUrl}/api/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
        },
        body: rpcBody("aztec_getVersion"),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { result: string };
      expect(body.result).toBeTruthy();
    });
  });

  describe("aztec_createNote via JSON-RPC", () => {
    async function params(
      operationId: string,
      overrides: Record<string, unknown> = {},
    ) {
      const network = await client.networkIdentity();
      return {
        version: SETTLEMENT_VERSION,
        operationId,
        network: {
          ...network,
          genesisOrNetworkDigest: CORRIDOR.genesisOrNetworkDigest,
        },
        corridor: {
          corridorId: CORRIDOR.corridorId,
          corridorRevision: CORRIDOR.corridorRevision,
          manifestDigest: CORRIDOR.manifestDigest,
        },
        accountMode: "standard",
        recipient: client.getAddress()!,
        recipientDescriptorDigest: "0x" + "ab".repeat(32),
        token: requireTestToken(),
        amount: "500",
        validUntil: Math.floor(Date.now() / 1000) + 3600,
        ...overrides,
      };
    }

    async function call(method: string, body: unknown, operationId?: string) {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
          ...(operationId ? { "idempotency-key": operationId } : {}),
        },
        body: rpcBody(method, [body]),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        result?: {
          observation: { state: string; txHash?: string; reason?: string };
          found?: boolean;
        };
        error?: {
          code: number;
          data?: {
            observation?: { state: string; reason?: string };
            reasons?: string[];
          };
        };
      };
    }

    it("blocks a standard-account payout and keeps recovery readable", async () => {
      const body = await call(
        "aztec_createNote",
        await params("e2e-http-1"),
        "e2e-http-1",
      );
      expect(body.error?.code).toBe(-32006);
      expect(body.error?.data?.reasons).toContain(
        "account_mode_not_spending_limit",
      );
      const read = await call("aztec_getSettlement", {
        version: SETTLEMENT_VERSION,
        operationId: "e2e-http-1",
      });
      expect(read.result).toMatchObject({
        found: true,
        observation: {
          state: "not_submitted",
          reason: "account_mode_not_spending_limit",
        },
      });
    });

    it("refuses legacy params", async () => {
      const body = await call(
        "aztec_createNote",
        {
          recipient: client.getAddress(),
          token: requireTestToken(),
          amount: "1",
          chainId: 1,
        },
        "e2e-legacy",
      );
      expect(body.error?.code).toBe(-32602);
    });

    it("does not let an unmarked operation bypass hard readiness", async () => {
      const fake = "0x" + "0dead".padEnd(64, "0");
      const body = await call(
        "aztec_createNote",
        await params("e2e-http-2", { token: fake, recipient: fake }),
        "e2e-http-2",
      );
      expect(body.error?.code).toBe(-32006);
    });
  });

  describe("error handling against live stack", () => {
    it("returns METHOD_NOT_FOUND for unknown method", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
        },
        body: rpcBody("unknown_method"),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        error: { code: number; message: string };
      };
      expect(body.error.code).toBe(-32601);
    });
  });
});
