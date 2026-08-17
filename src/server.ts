import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { handleRpcRequest, type RpcContext } from "./rpc.js";
import { RPC_ERRORS, type IAztecClient } from "./types.js";
import type { TransactionLimits } from "./limits.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { AuditLogger } from "./audit.js";

const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
// Bounds RECEIVING the request. Node's server.requestTimeout covers headers
// plus body, not the response, which is why it was never the protection the
// docs claimed it was.
const REQUEST_TIMEOUT_MS = 30_000;

// Bounds PRODUCING the response. Above aztec-client's 120s TX_TIMEOUT_MS, so a
// legitimate transfer is never cut off by it; a socket that outlives even that
// is not waiting on anything the bridge is going to deliver.
const RESPONSE_TIMEOUT_MS = 150_000;

export interface ServerOptions {
  apiKey?: string | undefined;
  /**
   * Separate key for `POST /admin/resume`. Deliberately not `apiKey`: whoever
   * can move funds should not also be able to clear the circuit breaker that
   * stopped them. Unset disables the endpoint entirely.
   */
  adminKey?: string | undefined;
  limits?: TransactionLimits | undefined;
  audit?: AuditLogger | undefined;
  /** Absent disables replay: every request executes, as before. */
  idempotency?: IdempotencyStore | undefined;
}

const RATE_LIMIT_CLEANUP_INTERVAL_MS = 300_000; // 5 min

export class RateLimiter {
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

// Long enough for a UUID or a "0x<32 bytes>-<index>" trade identifier, short
// enough that keys cannot be used to grow the store or the audit log.
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
/** Distinct from undefined, which means the caller simply sent no key. */
const INVALID_KEY = Symbol("invalid-idempotency-key");

/**
 * Validates the `Idempotency-Key` header.
 *
 * Rejected rather than sanitised. A key that is silently altered stops
 * matching the one the caller will retry with, which turns the protection off
 * exactly when it is needed. Printable ASCII only, since the value is written
 * to the audit log and read back by a parser.
 */
function readIdempotencyKey(
  header: string | string[] | undefined,
): string | undefined | typeof INVALID_KEY {
  if (header === undefined) return undefined;
  // Duplicate headers are ambiguous about which key the caller meant.
  if (Array.isArray(header)) return INVALID_KEY;

  const key = header.trim();
  if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) return INVALID_KEY;
  if (!/^[\x20-\x7e]+$/.test(key)) return INVALID_KEY;
  return key;
}

function checkAuth(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers["authorization"];
  if (!header) return false;
  // Constant-time comparison -- pad both to the same length so we
  // never leak the expected key length via timing or early return.
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const actual = Buffer.from(header);
  const maxLen = Math.max(actual.length, expected.length);
  const paddedExpected = Buffer.alloc(maxLen);
  const paddedActual = Buffer.alloc(maxLen);
  expected.copy(paddedExpected);
  actual.copy(paddedActual);
  const match = timingSafeEqual(paddedActual, paddedExpected);
  // Both must match in content AND length
  return match && actual.length === expected.length;
}

export function createApp(client: IAztecClient, opts: ServerOptions = {}): Server {
  const rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

  const server = createServer(async (req, res) => {
    // Nothing otherwise bounded how long a connection could stay open waiting
    // for a reply, so a stalled node held sockets indefinitely.
    res.setTimeout(RESPONSE_TIMEOUT_MS, () => {
      console.error("[pxe-bridge] Response deadline exceeded, closing connection");
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 504, {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_ERRORS.INTERNAL_ERROR, message: "Gateway timeout" },
      });
    });

    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      // Health check (no auth required, rate-limited)
      if (req.method === "GET" && pathname === "/status") {
        const statusIp = req.socket.remoteAddress ?? "unknown";
        if (!rateLimiter.allow(statusIp)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        try {
          const version = await client.getVersion();
          sendJson(res, 200, { status: "ok", version });
        } catch (err) {
          console.error("[pxe-bridge] Health check failed:", err);
          sendJson(res, 503, { status: "starting" });
        }
        return;
      }

      // Operator recovery after the circuit breaker trips. Without it the only
      // way back was a process restart, which also wiped the rolling window
      // and handed back the full daily budget.
      if (req.method === "POST" && pathname === "/admin/resume") {
        const adminIp = req.socket.remoteAddress ?? "unknown";
        if (!rateLimiter.allow(adminIp)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        // 404 rather than 403 when no admin key is configured: an endpoint
        // that cannot be used should not confirm that it exists.
        if (!opts.adminKey) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        if (!checkAuth(req, opts.adminKey)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        if (!opts.limits) {
          sendJson(res, 409, { error: "No transaction limits configured" });
          return;
        }
        opts.limits.resume();
        sendJson(res, 200, { status: "resumed", paused: opts.limits.isPaused() });
        return;
      }

      // JSON-RPC endpoint
      if (req.method === "POST" && (pathname === "/" || pathname === "/api/rpc")) {
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

        // A header rather than an RPC param: it is a property of the delivery
        // attempt, not of the note being created, and it has to work for
        // callers that send no XIP-1 trade context.
        const idempotencyKey = readIdempotencyKey(req.headers["idempotency-key"]);
        if (idempotencyKey === INVALID_KEY) {
          sendJson(res, 400, {
            error: `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters`,
          });
          return;
        }

        const rpcCtx: RpcContext = {
          limits: opts.limits,
          audit: opts.audit,
          idempotency: opts.idempotency,
          idempotencyKey,
          clientIp: clientIp,
        };
        const result = await handleRpcRequest(parsed, client, rpcCtx);
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
