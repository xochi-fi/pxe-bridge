import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { AztecClient } from "../../src/aztec-client.js";
import { createApp } from "../../src/server.js";
import { getTestConfig } from "./helpers.js";

const config = getTestConfig();

describe("HTTP server (e2e)", () => {
  let client: AztecClient;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    client = new AztecClient(
      config.nodeUrl,
      config.secretKey,
      config.feeJuiceClaim,
    );
    await client.connect();

    server = createApp(client);
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

  describe("GET /status", () => {
    it("returns ok with live node version", async () => {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { status: string; version: string };
      expect(body.status).toBe("ok");
      expect(body.version).toBeTruthy();
      expect(body.version).not.toBe("unknown");
    });
  });

  describe("aztec_getVersion via JSON-RPC", () => {
    it("returns version from live node via POST /", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
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
        body: rpcBody("aztec_getVersion"),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { result: string };
      expect(body.result).toBeTruthy();
    });
  });

  describe("aztec_createNote via JSON-RPC", () => {
    const tokenAddress = process.env["E2E_TOKEN_ADDRESS"];

    it.skipIf(!tokenAddress)(
      "creates note via full HTTP round-trip",
      async () => {
        const params = {
          recipient: tokenAddress!,
          token: tokenAddress!,
          amount: "500",
          chainId: 1,
        };

        const res = await fetch(baseUrl, {
          method: "POST",
          body: rpcBody("aztec_createNote", [params]),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as {
          result: {
            noteCommitment: string;
            nullifierHash: string;
            l2TxHash: string;
          };
        };
        expect(body.result.noteCommitment).toBeTruthy();
        expect(body.result.nullifierHash).toBeTruthy();
        expect(body.result.l2TxHash).toBeTruthy();
      },
    );

    it("returns error for non-existent token", async () => {
      const params = {
        recipient: "0x" + "dead".repeat(16),
        token: "0x" + "dead".repeat(16),
        amount: "1000",
        chainId: 1,
      };

      const res = await fetch(baseUrl, {
        method: "POST",
        body: rpcBody("aztec_createNote", [params]),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        error: { code: number; message: string };
      };
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toBe("Internal error");
    });
  });

  describe("error handling against live stack", () => {
    it("returns METHOD_NOT_FOUND for unknown method", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
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
