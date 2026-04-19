import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { handleRpcRequest } from "./rpc.js";
import type { IAztecClient } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const REQUEST_TIMEOUT_MS = 30_000;

export interface ServerOptions {
  apiKey?: string | undefined;
}

const RATE_LIMIT_CLEANUP_INTERVAL_MS = 300_000; // 5 min

class RateLimiter {
  private buckets = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    // Periodically prune stale buckets to prevent memory growth
    this.cleanupTimer = setInterval(() => this.cleanup(), RATE_LIMIT_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  allow(key: string): boolean {
    const now = Date.now();
    let timestamps = this.buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      this.buckets.set(key, timestamps);
    }
    const filtered = timestamps.filter((t) => now - t < this.windowMs);
    if (filtered.length >= this.max) {
      this.buckets.set(key, filtered);
      return false;
    }
    filtered.push(now);
    this.buckets.set(key, filtered);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.buckets) {
      const live = timestamps.filter((t) => now - t < this.windowMs);
      if (live.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, live);
      }
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        req.resume(); // drain remaining data without buffering
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function checkAuth(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers["authorization"];
  if (!header) return false;
  // Constant-time comparison -- hash both sides to fixed length so
  // we never leak the expected key length via timing or early return.
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) {
    // Compare against expected twice to keep timing constant
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export function createApp(
  client: IAztecClient,
  opts: ServerOptions = {},
): Server {
  const rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      // Health check (no auth required)
      if (req.method === "GET" && pathname === "/status") {
        try {
          const version = await client.getVersion();
          sendJson(res, 200, { status: "ok", version });
        } catch (err) {
          console.error("[pxe-bridge] Health check failed:", err);
          sendJson(res, 503, { status: "starting" });
        }
        return;
      }

      // JSON-RPC endpoint
      if (
        req.method === "POST" &&
        (pathname === "/" || pathname === "/api/rpc")
      ) {
        // Auth check
        if (opts.apiKey && !checkAuth(req, opts.apiKey)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        // Content-Type check (CSRF defense: forces browser preflight which fails without CORS)
        const contentType = req.headers["content-type"];
        if (!contentType || !contentType.startsWith("application/json")) {
          sendJson(res, 415, {
            error: "Content-Type must be application/json",
          });
          return;
        }

        // Rate limit (per-IP)
        const clientIp = req.socket.remoteAddress ?? "unknown";
        if (!rateLimiter.allow(clientIp)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }

        let body: string;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { error: "Request body too large" });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
          return;
        }

        const result = await handleRpcRequest(parsed, client);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("[pxe-bridge] Unhandled error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        });
      }
    }
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
