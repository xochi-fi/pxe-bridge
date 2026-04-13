import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp, type ServerOptions } from "../src/server.js";
import type {
  CreateNoteParams,
  CreateNoteResult,
  IAztecClient,
} from "../src/types.js";

const VALID_ADDR = "0x" + "a".repeat(64);
const JSON_HEADERS = { "Content-Type": "application/json" };

class FakeAztecClient implements IAztecClient {
  createNoteResult: CreateNoteResult = {
    noteCommitment: "0xcommit",
    nullifierHash: "0xnullifier",
    l2TxHash: "0xtx",
  };
  versionResult = "4.1.3";
  versionError: Error | null = null;

  async connect(): Promise<void> {}

  async createNote(_params: CreateNoteParams): Promise<CreateNoteResult> {
    return this.createNoteResult;
  }

  async getVersion(): Promise<string> {
    if (this.versionError) throw this.versionError;
    return this.versionResult;
  }
}

let server: Server;
let client: FakeAztecClient;
let baseUrl: string;

beforeAll(async () => {
  client = new FakeAztecClient();
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function rpcBody(
  method: string,
  params: unknown[] = [],
  id: number | string = 1,
) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function jsonPost(
  url: string,
  body: string,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(url, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body,
  });
}

describe("HTTP server", () => {
  describe("GET /status", () => {
    it("returns ok with version", async () => {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok", version: "4.1.3" });
    });

    it("returns 503 when client errors", async () => {
      client.versionError = new Error("not ready");
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: "starting" });
      client.versionError = null;
    });

    it("handles query string on /status", async () => {
      const res = await fetch(`${baseUrl}/status?check=true`);
      expect(res.status).toBe(200);
    });
  });

  describe("HEAD /status", () => {
    it("returns 404 for HEAD method", async () => {
      const res = await fetch(`${baseUrl}/status`, { method: "HEAD" });
      expect(res.status).toBe(404);
    });
  });

  describe("trailing slash on /status", () => {
    it("returns 404 for /status/", async () => {
      const res = await fetch(`${baseUrl}/status/`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST / (JSON-RPC)", () => {
    it("handles aztec_getVersion", async () => {
      const res = await jsonPost(baseUrl, rpcBody("aztec_getVersion"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      const body = await res.json();
      expect(body).toEqual({ jsonrpc: "2.0", id: 1, result: "4.1.3" });
    });

    it("handles aztec_createNote", async () => {
      const params = {
        recipient: VALID_ADDR,
        token: VALID_ADDR,
        amount: "1000",
        chainId: 1,
      };
      const res = await jsonPost(
        baseUrl,
        rpcBody("aztec_createNote", [params]),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toEqual(client.createNoteResult);
    });
  });

  describe("POST /api/rpc (alias)", () => {
    it("works same as POST /", async () => {
      const res = await jsonPost(
        `${baseUrl}/api/rpc`,
        rpcBody("aztec_getVersion"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBe("4.1.3");
    });
  });

  describe("content-type enforcement", () => {
    it("rejects POST without Content-Type header", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        body: rpcBody("aztec_getVersion"),
      });
      expect(res.status).toBe(415);
    });

    it("rejects POST with text/plain Content-Type", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: rpcBody("aztec_getVersion"),
      });
      expect(res.status).toBe(415);
    });

    it("accepts application/json with charset", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: rpcBody("aztec_getVersion"),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("non-object JSON body", () => {
    it("returns INVALID_REQUEST for JSON string body", async () => {
      const res = await jsonPost(baseUrl, JSON.stringify("hello"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error.code).toBe(-32600);
    });

    it("returns INVALID_REQUEST for JSON number body", async () => {
      const res = await jsonPost(baseUrl, JSON.stringify(42));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error.code).toBe(-32600);
    });
  });

  describe("body size boundary", () => {
    it("accepts body that is exactly 64KB", async () => {
      const envelope = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "aztec_getVersion",
        pad: "",
      });
      const overhead = Buffer.byteLength(envelope);
      const pad = "x".repeat(64 * 1024 - overhead);
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "aztec_getVersion",
        pad,
      });
      expect(Buffer.byteLength(body)).toBe(64 * 1024);
      const res = await jsonPost(baseUrl, body);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result).toBe("4.1.3");
    });
  });

  describe("error handling", () => {
    it("returns 400 for invalid JSON", async () => {
      const res = await jsonPost(baseUrl, "not json{{{");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32700);
    });

    it("returns 400 for empty body", async () => {
      const res = await jsonPost(baseUrl, "");
      expect(res.status).toBe(400);
    });

    it("rejects oversized body with 413", async () => {
      const huge = "x".repeat(65 * 1024);
      const res = await jsonPost(baseUrl, huge);
      expect(res.status).toBe(413);
    });
  });

  describe("routing", () => {
    it("returns 404 for unknown path", async () => {
      const res = await fetch(`${baseUrl}/unknown`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for wrong method on /", async () => {
      const res = await fetch(baseUrl, { method: "PUT" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for GET on /", async () => {
      const res = await fetch(baseUrl);
      expect(res.status).toBe(404);
    });
  });

  describe("response headers", () => {
    it("sets content-type to application/json", async () => {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.headers.get("content-type")).toBe("application/json");
    });

    it("sets X-Content-Type-Options: nosniff", async () => {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("sets Cache-Control: no-store", async () => {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });
});

describe("HTTP server with auth", () => {
  let authServer: Server;
  let authClient: FakeAztecClient;
  let authBaseUrl: string;
  const TEST_API_KEY = "test-secret-key-12345";

  beforeAll(async () => {
    authClient = new FakeAztecClient();
    authServer = createApp(authClient, { apiKey: TEST_API_KEY });
    await new Promise<void>((resolve) => {
      authServer.listen(0, () => {
        const addr = authServer.address();
        if (addr && typeof addr === "object") {
          authBaseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
  });

  it("rejects RPC without auth header", async () => {
    const res = await jsonPost(authBaseUrl, rpcBody("aztec_getVersion"));
    expect(res.status).toBe(401);
  });

  it("rejects RPC with wrong key", async () => {
    const res = await jsonPost(authBaseUrl, rpcBody("aztec_getVersion"), {
      Authorization: "Bearer wrong-key",
    });
    expect(res.status).toBe(401);
  });

  it("accepts RPC with correct key", async () => {
    const res = await jsonPost(authBaseUrl, rpcBody("aztec_getVersion"), {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe("4.1.3");
  });

  it("allows /status without auth", async () => {
    const res = await fetch(`${authBaseUrl}/status`);
    expect(res.status).toBe(200);
  });
});
