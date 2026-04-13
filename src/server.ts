import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { handleRpcRequest } from "./rpc.js";
import type { IAztecClient } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const REQUEST_TIMEOUT_MS = 30_000;

export interface ServerOptions {
  apiKey?: string | undefined;
}

class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.max) return false;
    this.timestamps.push(now);
    return true;
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
  // Constant-time comparison to prevent timing attacks
  const expected = `Bearer ${apiKey}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < header.length; i++) {
    mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
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

        // Rate limit
        if (!rateLimiter.allow()) {
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
