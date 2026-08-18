import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp, type ServerOptions } from "../src/server.js";
import { TransactionLimits } from "../src/limits.js";
import { IdempotencyStore } from "../src/idempotency.js";
import type { CreateNoteParams, CreateNoteResult, IAztecClient } from "../src/types.js";
import { rpcJson } from "./helpers.js";

const VALID_ADDR = "0x" + "a".repeat(64);
const JSON_HEADERS = { "Content-Type": "application/json" };

class FakeAztecClient implements IAztecClient {
  createNoteResult: CreateNoteResult = {
    // Two note hashes and three nullifiers, matching what a real
    // transfer_to_private emits: a fake with one of each would hide the reason
    // the scalar fields below are ambiguous.
    noteHashes: ["0xcommit", "0xcommit2"],
    nullifiers: ["0xnullifier", "0xnullifier2", "0xnullifier3"],
    l2TxHash: "0xtx",
    noteCommitment: "0xcommit",
    nullifierHash: "0xnullifier",
  };
  versionResult = "4.1.3";
  versionError: Error | null = null;
  /** Counts real executions, so a replay is distinguishable from a re-run. */
  createNoteCalls = 0;

  async connect(): Promise<void> {}

  async createNote(_params: CreateNoteParams): Promise<CreateNoteResult> {
    this.createNoteCalls++;
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

function rpcBody(method: string, params: unknown[] = [], id: number | string = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function jsonPost(url: string, body: string, extraHeaders: Record<string, string> = {}) {
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
      const body = await rpcJson(res);
      expect(body).toEqual({ jsonrpc: "2.0", id: 1, result: "4.1.3" });
    });

    it("handles aztec_createNote", async () => {
      const params = {
        recipient: VALID_ADDR,
        token: VALID_ADDR,
        amount: "1000",
        chainId: 1,
      };
      const res = await jsonPost(baseUrl, rpcBody("aztec_createNote", [params]));
      expect(res.status).toBe(200);
      const body = await rpcJson<CreateNoteResult>(res);
      expect(body.result).toEqual(client.createNoteResult);
    });
  });

  describe("POST /api/rpc (alias)", () => {
    it("works same as POST /", async () => {
      const res = await jsonPost(`${baseUrl}/api/rpc`, rpcBody("aztec_getVersion"));
      expect(res.status).toBe(200);
      const body = await rpcJson<string>(res);
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
      const body = await rpcJson(res);
      expect(body.error?.code).toBe(-32600);
    });

    it("returns INVALID_REQUEST for JSON number body", async () => {
      const res = await jsonPost(baseUrl, JSON.stringify(42));
      expect(res.status).toBe(200);
      const body = await rpcJson(res);
      expect(body.error?.code).toBe(-32600);
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
      const json = await rpcJson<string>(res);
      expect(json.result).toBe("4.1.3");
    });
  });

  describe("error handling", () => {
    it("returns 400 for invalid JSON", async () => {
      const res = await jsonPost(baseUrl, "not json{{{");
      expect(res.status).toBe(400);
      const body = await rpcJson(res);
      expect(body.error?.code).toBe(-32700);
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
    const body = await rpcJson<string>(res);
    expect(body.result).toBe("4.1.3");
  });

  it("allows /status without auth", async () => {
    const res = await fetch(`${authBaseUrl}/status`);
    expect(res.status).toBe(200);
  });
});

// The rate limit used to run AFTER auth, so a 401 returned before `allow()`
// was ever called. That left API key guessing unthrottled: the documented
// "60 requests/min" bounded only callers who already had the key. Its own
// server so the limiter starts fresh and no other suite shares the budget.
describe("rate limiting applies to failed auth", () => {
  let rlServer: Server;
  let rlBaseUrl: string;
  const RL_API_KEY = "rate-limit-suite-key";
  const RATE_LIMIT_MAX = 60;

  beforeAll(async () => {
    rlServer = createApp(new FakeAztecClient(), { apiKey: RL_API_KEY });
    await new Promise<void>((resolve) => {
      rlServer.listen(0, () => {
        const addr = rlServer.address();
        if (addr && typeof addr === "object") {
          rlBaseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => rlServer.close(() => resolve()));
  });

  it("spends the budget on wrong keys, so a correct key is throttled too", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await jsonPost(rlBaseUrl, rpcBody("aztec_getVersion"), {
        Authorization: "Bearer wrong-key",
      });
      statuses.push(res.status);
    }
    // Every guess is refused on its merits, not yet on volume.
    expect(new Set(statuses)).toEqual(new Set([401]));

    // The budget is now spent. A caller holding the real key is refused for
    // volume, which is the proof the failed attempts were counted at all.
    const throttled = await jsonPost(rlBaseUrl, rpcBody("aztec_getVersion"), {
      Authorization: `Bearer ${RL_API_KEY}`,
    });
    expect(throttled.status).toBe(429);
  });
});

describe("Idempotency-Key header", () => {
  async function boot(): Promise<{
    url: string;
    client: FakeAztecClient;
    close: () => Promise<void>;
  }> {
    const c = new FakeAztecClient();
    const srv = createApp(c, { idempotency: new IdempotencyStore() });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const addr = srv.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      client: c,
      close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    };
  }

  const noteBody = () =>
    rpcBody("aztec_createNote", [
      { recipient: VALID_ADDR, token: VALID_ADDR, amount: "1000", chainId: 1 },
    ]);

  it("carries the header through to replay a duplicate", async () => {
    const { url, close } = await boot();
    try {
      const first = await jsonPost(url, noteBody(), { "Idempotency-Key": "trade-1" });
      const second = await jsonPost(url, noteBody(), { "Idempotency-Key": "trade-1" });

      expect(await rpcJson(first)).toEqual(await rpcJson(second));
    } finally {
      await close();
    }
  });

  it("treats different keys as different requests", async () => {
    const { url, close } = await boot();
    try {
      await jsonPost(url, noteBody(), { "Idempotency-Key": "trade-1" });
      const other = await jsonPost(url, noteBody(), { "Idempotency-Key": "trade-2" });

      expect(other.status).toBe(200);
      expect("result" in (await rpcJson(other))).toBe(true);
    } finally {
      await close();
    }
  });

  // Rejected, not sanitised. A key that is silently altered stops matching the
  // one the caller retries with, which turns the protection off precisely when
  // it is needed.
  //
  // A newline is absent from this list because fetch refuses to send one, so
  // no conforming client can produce it; the validator still rejects control
  // characters for anything that reaches the socket by other means.
  it("rejects a malformed key rather than cleaning it up", async () => {
    const { url, close } = await boot();
    try {
      for (const bad of ["", "   ", "x".repeat(129), "tab\there"]) {
        const res = await jsonPost(url, noteBody(), { "Idempotency-Key": bad });
        expect(res.status, `should reject ${JSON.stringify(bad)}`).toBe(400);
      }
    } finally {
      await close();
    }
  });

  it("accepts a key at the length limit", async () => {
    const { url, close } = await boot();
    try {
      const res = await jsonPost(url, noteBody(), { "Idempotency-Key": "x".repeat(128) });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("runs normally when no key is sent", async () => {
    const { url, client, close } = await boot();
    try {
      await jsonPost(url, noteBody());
      await jsonPost(url, noteBody());
      expect(client.createNoteCalls).toBe(2);
    } finally {
      await close();
    }
  });
});

describe("POST /admin/resume", () => {
  const ADMIN_KEY = "admin-secret-key-67890";
  const RPC_KEY = "rpc-secret-key-12345";

  /** Boots a server on an ephemeral port and returns its URL plus a closer. */
  async function boot(opts: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
    const srv = createApp(new FakeAztecClient(), opts);
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const addr = srv.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    };
  }

  function resume(url: string, key?: string) {
    return fetch(`${url}/admin/resume`, {
      method: "POST",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
  }

  it("clears a tripped breaker and reports the new state", async () => {
    const limits = new TransactionLimits({ dailyLimit: 5000n });
    limits.recordSpend(5000n);
    limits.check(1n);
    expect(limits.isPaused()).toBe(true);

    const { url, close } = await boot({ adminKey: ADMIN_KEY, limits });
    try {
      const res = await resume(url, ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "resumed", paused: false });
      expect(limits.isPaused()).toBe(false);
    } finally {
      await close();
    }
  });

  it("rejects a missing or wrong admin key", async () => {
    const { url, close } = await boot({
      adminKey: ADMIN_KEY,
      limits: new TransactionLimits({ dailyLimit: 5000n }),
    });
    try {
      expect((await resume(url)).status).toBe(401);
      expect((await resume(url, "wrong-key")).status).toBe(401);
    } finally {
      await close();
    }
  });

  // The whole reason the key is separate: a caller who can move funds must not
  // be able to clear the breaker that stopped them.
  it("does not accept the RPC key", async () => {
    const { url, close } = await boot({
      apiKey: RPC_KEY,
      adminKey: ADMIN_KEY,
      limits: new TransactionLimits({ dailyLimit: 5000n }),
    });
    try {
      expect((await resume(url, RPC_KEY)).status).toBe(401);
    } finally {
      await close();
    }
  });

  // 404 rather than 403: an endpoint that cannot be used should not confirm
  // that it exists.
  it("is invisible when no admin key is configured", async () => {
    const { url, close } = await boot({ limits: new TransactionLimits({ dailyLimit: 5000n }) });
    try {
      expect((await resume(url, ADMIN_KEY)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("reports 409 when no limits are configured", async () => {
    const { url, close } = await boot({ adminKey: ADMIN_KEY });
    try {
      expect((await resume(url, ADMIN_KEY)).status).toBe(409);
    } finally {
      await close();
    }
  });
});
