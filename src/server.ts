import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { handleRpcRequest, type RpcContext, type SettlementContext } from "./rpc.js";
import { JsonRpcRequestSchema, RPC_ERRORS, type IAztecClient } from "./types.js";
import type { TransactionLimits } from "./limits.js";
import type { AuditLogger } from "./audit.js";
import type { ReadinessObserver } from "./readiness.js";
import {
  AttestationRpcRequestSchema,
  attestationHttpStatus,
  handleAttestationRpc,
  type AttestationProducer,
} from "./attestation.js";
import {
  CreateNoteSchema,
  GetSettlementSchema,
  SETTLEMENT_VERSION,
  namesRetiredVersion,
} from "./settlement.js";

const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const MAX_RPC_IN_FLIGHT = 16;
const MAX_RPC_BODY_IN_FLIGHT = 16;
// Bounds RECEIVING the request. Node's server.requestTimeout covers headers
// plus body, not the response, which is why it was never the protection the
// docs claimed it was.
const REQUEST_TIMEOUT_MS = 30_000;

// Bounds PRODUCING the response. Above aztec-client's 120s TX_TIMEOUT_MS, so a
// legitimate transfer is never cut off by it; a socket that outlives even that
// is not waiting on anything the bridge is going to deliver.
export const RESPONSE_TIMEOUT_MS = 150_000;

// A readiness probe is diagnostic, not a settlement. Return a typed 503 before
// the general response deadline if an authenticated backend observation hangs.
const READINESS_TIMEOUT_MS = 20_000;

// The one deadline of a createNote, started when the request is handled and
// spent by admission, cooldown, proving, the may-broadcast query and the
// send. Under the response deadline by a margin, so the structured answer
// (prepared / submitted_unknown with the txHash) reaches the caller before a
// bare 504 can; the response deadline's abort closes the gate regardless.
export const SETTLEMENT_DEADLINE_MS = RESPONSE_TIMEOUT_MS - 5_000;

export interface ServerOptions {
  apiKey?: string | undefined;
  /**
   * Separate key for `POST /api/recovery`. Its identity is what makes the
   * route's reserved body intake safe before the JSON-RPC body can be parsed.
   * Unset disables the dedicated endpoint; legacy RPC routes still reconcile.
   */
  recoveryApiKey?: string | undefined;
  /**
   * Separate key for `POST /admin/resume`. Deliberately not `apiKey`: whoever
   * can move funds should not also be able to clear the circuit breaker that
   * stopped them. Unset disables the endpoint entirely.
   */
  adminKey?: string | undefined;
  /** Dedicated Worker/Riddler credential; unset keeps POST /api/attestation hidden. */
  attestationApiKey?: string | undefined;
  attestation?: AttestationProducer | undefined;
  limits?: TransactionLimits | undefined;
  audit?: AuditLogger | undefined;
  /**
   * The settlement journal and its collaborators. Absent refuses every
   * `aztec_createNote` and `aztec_getSettlement` with -32004.
   */
  settlement?: SettlementContext | undefined;
  /** Authoritative operational readiness, shared with createNote admission. */
  readiness?: ReadinessObserver | undefined;
  /** The HTTP response deadline; RESPONSE_TIMEOUT_MS unless a test shortens it. */
  responseTimeoutMs?: number | undefined;
  /** Readiness observation deadline; READINESS_TIMEOUT_MS unless a test shortens it. */
  readinessTimeoutMs?: number | undefined;
  /** False while startup is still connecting/binding; only public /status is served. */
  initialized?: (() => boolean) | undefined;
}


// Failed auth gets its own, much smaller budget, separate from the one real
// traffic spends. One shared bucket forces a choice between two bad outcomes:
// authenticate first and key guessing is unthrottled, or rate limit first and
// an unauthenticated caller starves every legitimate one.
//
// The second is worse than it looks. Nothing here reads X-Forwarded-For, so
// behind the reverse proxy this is documented to run behind, `remoteAddress`
// is the PROXY for every request and all callers share a single bucket. One
// attacker sending 60 unauthenticated requests a minute would stop the bridge
// for everybody.
const AUTH_FAILURE_MAX = 10;

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
    let tooLarge = false;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      if (tooLarge) {
        fail(new Error("Request body too large"));
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("aborted", () => fail(new Error("Request body aborted")));
    req.on("error", (error) => fail(error));
    req.on("close", () => {
      if (!req.complete) fail(new Error("Request body closed"));
    });
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  // The response deadline may already have answered (504); the handler that
  // finishes afterwards has nobody to tell.
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

// Long enough for a UUID or a "0x<32 bytes>-<index>" trade identifier, short
// enough that keys cannot be used to grow durable journal state.
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

export function assertDistinctCredentials(
  credentials: readonly (readonly [name: string, value: string | undefined])[],
): void {
  const namesByValue = new Map<string, string>();
  for (const [name, value] of credentials) {
    if (value === undefined) continue;
    const existing = namesByValue.get(value);
    if (existing !== undefined) {
      throw new Error(`${name} must differ from ${existing}`);
    }
    namesByValue.set(value, name);
  }
}

type ReadinessProjection = Awaited<ReturnType<ReadinessObserver["observe"]>>;

async function observeReadiness(
  observation: Promise<ReadinessProjection>,
  timeoutMs: number,
  abort: () => void,
): Promise<ReadinessProjection> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort();
      reject(new Error("readiness observation timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([observation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process-local surface used before remote secrets and the Aztec client have
 * initialized. The caller swaps this handler for `createApp` without rebinding
 * the listening socket.
 */
export function createInitializationApp(apiKey?: string): Server {
  const livenessRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const readinessRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const startupRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const malformedTargetRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const authFailureLimiter = new RateLimiter(AUTH_FAILURE_MAX, RATE_LIMIT_WINDOW_MS);
  const server = createServer((req, res) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      if (!malformedTargetRateLimiter.allow("malformed-target")) {
        sendJson(res, 429, { error: "Too many requests" });
        return;
      }
      sendJson(res, 400, { error: "Invalid request target" });
      return;
    }

    if (req.method === "GET" && pathname === "/status") {
      if (!livenessRateLimiter.allow(ip)) {
        sendJson(res, 429, { error: "Too many requests" });
        return;
      }
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && pathname === "/ready") {
      if (!apiKey) {
        sendJson(res, 503, { ready: false, reasons: ["api_key_unconfigured"] });
        return;
      }
      if (!checkAuth(req, apiKey)) {
        if (!authFailureLimiter.allow(ip)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      if (!readinessRateLimiter.allow(ip)) {
        sendJson(res, 429, { error: "Too many requests" });
        return;
      }
      sendJson(res, 503, { ready: false, reasons: ["initializing"] });
      return;
    }

    if (!startupRateLimiter.allow("startup")) {
      sendJson(res, 429, { error: "Too many requests" });
      return;
    }

    sendJson(res, 503, { error: "Service initializing" });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}


export function createApp(client: IAztecClient, opts: ServerOptions = {}): Server {
  const attestationConfigured =
    opts.attestationApiKey !== undefined || opts.attestation !== undefined;
  if (
    attestationConfigured &&
    (opts.attestationApiKey === undefined || opts.attestation === undefined)
  ) {
    throw new Error("Attestation route requires both its credential and producer");
  }
  if (attestationConfigured && opts.apiKey === undefined) {
    throw new Error("Attestation route requires authenticated main RPC");
  }
  if (
    opts.attestationApiKey !== undefined &&
    (opts.attestationApiKey === opts.apiKey ||
      opts.attestationApiKey === opts.adminKey)
  ) {
    throw new Error("Attestation credential must differ from RPC and admin credentials");
  }
  if (
    opts.apiKey !== undefined &&
    opts.adminKey !== undefined &&
    opts.apiKey === opts.adminKey
  ) {
    throw new Error("Admin credential must differ from RPC credential");
  }
  if (
    opts.recoveryApiKey !== undefined &&
    (opts.recoveryApiKey === opts.apiKey ||
      opts.recoveryApiKey === opts.adminKey ||
      opts.recoveryApiKey === opts.attestationApiKey)
  ) {
    throw new Error(
      "Recovery credential must differ from RPC, admin, and attestation credentials",
    );
  }
  if (
    opts.readiness !== undefined &&
    opts.settlement?.readiness !== undefined &&
    opts.readiness !== opts.settlement.readiness
  ) {
    throw new Error("Server and settlement must share one readiness observer");
  }
  const sourceReadinessObserver = opts.readiness ?? opts.settlement?.readiness;
  type ReadinessFlight = {
    raw: Promise<ReadinessProjection>;
    bounded: Promise<ReadinessProjection>;
  };
  let readinessFlight: ReadinessFlight | undefined;
  const currentReadinessObservation = (): Promise<ReadinessProjection> => {
    if (!sourceReadinessObserver) {
      return Promise.reject(new Error("readiness observer is not configured"));
    }
    if (readinessFlight) return readinessFlight.bounded;

    const controller = new AbortController();
    const raw = Promise.resolve().then(() =>
      sourceReadinessObserver.observe(controller.signal),
    );
    const flight = {
      raw,
      bounded: observeReadiness(
        raw,
        opts.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
        () => controller.abort(),
      ),
    };
    readinessFlight = flight;
    const clear = () => {
      if (readinessFlight === flight) readinessFlight = undefined;
    };
    void raw.then(clear, clear);
    return flight.bounded;
  };
  const readinessObserver: ReadinessObserver | undefined = sourceReadinessObserver
    ? { observe: currentReadinessObservation }
    : undefined;
  const readinessRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const rpcRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const recoveryRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const invalidRpcRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const adminRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const livenessRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const authFailureLimiter = new RateLimiter(AUTH_FAILURE_MAX, RATE_LIMIT_WINDOW_MS);
  const attestationRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const attestationAuthFailureLimiter = new RateLimiter(AUTH_FAILURE_MAX, RATE_LIMIT_WINDOW_MS);
  const attestationInvalidRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const startupRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const malformedTargetRateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  let backendInFlight = 0;
  let recoveryInFlight = 0;
  let ordinaryBodyInFlight = 0;
  let recoveryBodyInFlight = 0;
  const acquireBodyLease = (recovery = false): (() => void) | null => {
    const active = recovery ? recoveryBodyInFlight : ordinaryBodyInFlight;
    if (active >= MAX_RPC_BODY_IN_FLIGHT) return null;
    if (recovery) recoveryBodyInFlight += 1;
    else ordinaryBodyInFlight += 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      if (recovery) recoveryBodyInFlight -= 1;
      else ordinaryBodyInFlight -= 1;
    };
  };
  const acquireBackendLease = (recovery = false): {
    trackBackground: (call: Promise<unknown>) => void;
    finish: () => void;
  } | null => {
    const active = recovery ? recoveryInFlight : backendInFlight;
    if (active >= MAX_RPC_IN_FLIGHT) return null;
    if (recovery) recoveryInFlight += 1;
    else backendInFlight += 1;
    let backgroundPending = 0;
    let handlerFinished = false;
    let capacityReleased = false;
    const releaseCapacity = (): void => {
      if (capacityReleased || !handlerFinished || backgroundPending !== 0) return;
      capacityReleased = true;
      if (recovery) recoveryInFlight -= 1;
      else backendInFlight -= 1;
    };
    return {
      trackBackground(call): void {
        backgroundPending += 1;
        const settled = (): void => {
          backgroundPending -= 1;
          releaseCapacity();
        };
        call.then(settled, settled);
      },
      finish(): void {
        handlerFinished = true;
        releaseCapacity();
      },
    };
  };

  /**
   * Rejects an unauthenticated caller, charging the attempt to its own bucket.
   *
   * Returns true when the request was rejected and a response already sent.
   * A caller that never proves who it is cannot spend the budget that real
   * traffic depends on, and cannot guess keys without limit either.
   */
  const rejectedUnauthenticated = (
    req: IncomingMessage,
    res: ServerResponse,
    key: string | undefined,
    ip: string,
  ): boolean => {
    if (!key || checkAuth(req, key)) return false;
    if (!authFailureLimiter.allow(ip)) {
      sendJson(res, 429, { error: "Too many requests" });
      return true;
    }
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  };


  const server = createServer(async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      if (!malformedTargetRateLimiter.allow("malformed-target")) {
        sendJson(res, 429, { error: "Too many requests" });
        return;
      }
      sendJson(res, 400, { error: "Invalid request target" });
      return;
    }
    // Nothing otherwise bounded how long a connection could stay open waiting
    // for a reply, so a stalled node held sockets indefinitely.
    //
    // The settlement deadline (SettlementContext.timeoutMs) normally answers
    // first; this signal is the backstop that closes the gate if it does not.
    const responseDeadline = new AbortController();
    res.setTimeout(opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS, () => {
      console.error("[pxe-bridge] Response deadline exceeded, closing connection");
      // Before the 504 goes out: once the caller is answered, nothing this
      // request started may be marked may-broadcast.
      responseDeadline.abort();
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

      // Public liveness is deliberately process-local. It exposes no funded
      // account detail and performs no Aztec RPC that an unauthenticated caller
      // could use to contend with readiness or payout admission.
      if (req.method === "GET" && pathname === "/status") {
        const statusIp = req.socket.remoteAddress ?? "unknown";
        if (!livenessRateLimiter.allow(statusIp)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // Operational readiness contains funded-account and policy detail, so it
      // is authenticated before spending the real-traffic rate-limit budget.
      if (req.method === "GET" && pathname === "/ready") {
        const readyIp = req.socket.remoteAddress ?? "unknown";
        if (!opts.apiKey) {
          sendJson(res, 503, { ready: false, reasons: ["api_key_unconfigured"] });
          return;
        }
        if (rejectedUnauthenticated(req, res, opts.apiKey, readyIp)) return;
        if (!readinessRateLimiter.allow(readyIp)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        if (opts.initialized && !opts.initialized()) {
          sendJson(res, 503, { ready: false, reasons: ["initializing"] });
          return;
        }
        if (!readinessObserver) {
          sendJson(res, 503, { ready: false, reasons: ["readiness_observer_unconfigured"] });
          return;
        }
        try {
          const readiness = await currentReadinessObservation();
          const projected =
            backendInFlight >= MAX_RPC_IN_FLIGHT ||
            ordinaryBodyInFlight >= MAX_RPC_BODY_IN_FLIGHT
              ? {
                  ...readiness,
                  ready: false,
                  reasons: [...readiness.reasons, "backend_capacity_exhausted" as const],
                }
              : readiness;
          sendJson(res, projected.ready ? 200 : 503, projected);
        } catch {
          console.error("[pxe-bridge] Readiness observation failed");
          const reasons = ["readiness_observation_failed"];
          if (
            backendInFlight >= MAX_RPC_IN_FLIGHT ||
            ordinaryBodyInFlight >= MAX_RPC_BODY_IN_FLIGHT
          ) {
            reasons.push("backend_capacity_exhausted");
          }
          sendJson(res, 503, { ready: false, reasons });
        }
        return;
      }
      if (opts.initialized && !opts.initialized()) {
        if (!startupRateLimiter.allow("startup")) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        sendJson(res, 503, { error: "Service initializing" });
        return;
      }


      if (req.method === "POST" && pathname === "/api/attestation") {
        const attestationIp = req.socket.remoteAddress ?? "unknown";
        if (!opts.attestationApiKey || !opts.attestation) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        if (!checkAuth(req, opts.attestationApiKey)) {
          if (!attestationAuthFailureLimiter.allow(attestationIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        const contentType = req.headers["content-type"];
        if (!contentType || !contentType.startsWith("application/json")) {
          if (!attestationInvalidRateLimiter.allow(attestationIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const releaseBody = acquireBodyLease();
        if (releaseBody === null) {
          sendJson(res, 503, { error: "Service busy" });
          return;
        }
        let parsed: unknown;
        try {
          let body: string;
          try {
            body = await readBody(req);
          } catch {
            if (!attestationInvalidRateLimiter.allow(attestationIp)) {
              sendJson(res, 429, { error: "Too many requests" });
              return;
            }
            sendJson(res, 413, { error: "Request body too large" });
            return;
          }
          try {
            parsed = JSON.parse(body);
          } catch {
            if (!attestationInvalidRateLimiter.allow(attestationIp)) {
              sendJson(res, 429, { error: "Too many requests" });
              return;
            }
            sendJson(res, 400, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            });
            return;
          }
        } finally {
          releaseBody();
        }
        if (!AttestationRpcRequestSchema.safeParse(parsed).success) {
          if (!attestationInvalidRateLimiter.allow(attestationIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          const response = await handleAttestationRpc(parsed, opts.attestation);
          sendJson(res, attestationHttpStatus(response), response);
          return;
        }
        if (!attestationRateLimiter.allow(attestationIp)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        const lease = acquireBackendLease();
        if (lease === null) {
          sendJson(res, 503, { error: "Service busy" });
          return;
        }
        try {
          const response = await handleAttestationRpc(parsed, opts.attestation);
          sendJson(res, attestationHttpStatus(response), response);
        } finally {
          lease.finish();
        }
        return;
      }

      // Operator recovery after the circuit breaker trips. Without it the only
      // way back was a process restart, which also wiped the rolling window
      // and handed back the full daily budget.
      if (req.method === "POST" && pathname === "/admin/resume") {
        const adminIp = req.socket.remoteAddress ?? "unknown";
        // 404 rather than 403 when no admin key is configured: an endpoint
        // that cannot be used should not confirm that it exists.
        if (!opts.adminKey) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        // Administrative recovery keeps reserved capacity: a lower-privilege
        // RPC caller cannot consume its limiter through ordinary traffic.
        if (rejectedUnauthenticated(req, res, opts.adminKey, adminIp)) return;
        if (!adminRateLimiter.allow(adminIp)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        // Same Content-Type requirement as the RPC branch. The docs state it
        // for POST without qualifying which POST, and this one was exempt. A
        // browser cannot forge the Authorization header above, so the CSRF
        // risk was nil; the point is that the stated property now holds.
        const adminContentType = req.headers["content-type"];
        if (!adminContentType || !adminContentType.startsWith("application/json")) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        if (!opts.limits) {
          sendJson(res, 409, { error: "No transaction limits configured" });
          return;
        }
        opts.limits.resume();
        // `paused: false` on its own was a true statement that read as a false
        // one. Clearing the latch does not clear the window, so a resume
        // issued while volume still drains the budget is undone by the next
        // request, and the operator who just got a 200 has no way to know that
        // from the response. The numbers that decide it go back with it.
        const window = opts.limits.windowStatus();
        sendJson(res, 200, {
          status: "resumed",
          paused: opts.limits.isPaused(),
          committed: window.committed.toString(),
          reserved: window.reserved.toString(),
          ...(window.dailyLimit !== undefined
            ? { dailyLimit: window.dailyLimit.toString() }
            : {}),
          ...(window.remaining !== undefined
            ? { remaining: window.remaining.toString() }
            : {}),
          mayTripAgain: window.mayTripAgain,
        });
        return;
      }

      // JSON-RPC endpoints. Reconciliation has a dedicated intake route so
      // ordinary slow bodies cannot consume its reserved receive capacity.
      if (
        req.method === "POST" &&
        (pathname === "/" || pathname === "/api/rpc" || pathname === "/api/recovery")
      ) {
        const recoveryEndpoint = pathname === "/api/recovery";
        const clientIp = req.socket.remoteAddress ?? "unknown";

        // Dedicated recovery intake is selected before the body is available,
        // so only its separate credential may reserve those receive slots.
        if (recoveryEndpoint && !opts.recoveryApiKey) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        const requestKey = recoveryEndpoint ? opts.recoveryApiKey : opts.apiKey;
        if (rejectedUnauthenticated(req, res, requestKey, clientIp)) return;

        // Content-Type check (CSRF defense: forces browser preflight which fails without CORS)
        const contentType = req.headers["content-type"];
        if (!contentType || !contentType.startsWith("application/json")) {
          if (!invalidRpcRateLimiter.allow(clientIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          sendJson(res, 415, {
            error: "Content-Type must be application/json",
          });
          return;
        }

        // A header rather than an RPC param: it is a property of the delivery
        // attempt, not of the note being created, and it has to work for
        // callers that send no XIP-1 trade context. Validate it before reading
        // the body so invalid headers cannot bypass every request bound.
        const idempotencyKey = readIdempotencyKey(req.headers["idempotency-key"]);
        if (idempotencyKey === INVALID_KEY) {
          if (!invalidRpcRateLimiter.allow(clientIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          sendJson(res, 400, {
            error: `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters`,
          });
          return;
        }

        // Method-specific limits require the parsed JSON-RPC body. Bound that
        // pre-classification work separately so slow or concurrent bodies
        // cannot accumulate outside the backend pools.
        const releaseBody = acquireBodyLease(recoveryEndpoint);
        if (releaseBody === null) {
          sendJson(res, 503, { error: "Service busy" });
          return;
        }
        let parsed: unknown;
        try {
          let body: string;
          try {
            body = await readBody(req);
          } catch {
            if (!invalidRpcRateLimiter.allow(clientIp)) {
              sendJson(res, 429, { error: "Too many requests" });
              return;
            }
            sendJson(res, 413, { error: "Request body too large" });
            return;
          }

          try {
            parsed = JSON.parse(body);
          } catch {
            if (!invalidRpcRateLimiter.allow(clientIp)) {
              sendJson(res, 429, { error: "Too many requests" });
              return;
            }
            sendJson(res, 400, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            });
            return;
          }
        } finally {
          releaseBody();
        }

        const rpcRequest = JsonRpcRequestSchema.safeParse(parsed);
        if (!rpcRequest.success) {
          if (!invalidRpcRateLimiter.allow(clientIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: null,
            error: { code: RPC_ERRORS.INVALID_REQUEST, message: "Invalid JSON-RPC request" },
          });
          return;
        }
        const { id, method, params } = rpcRequest.data;
        const recoveryMethod = method === "aztec_getSettlement";
        const recoveryRequest =
          recoveryMethod &&
          params.length === 1 &&
          GetSettlementSchema.safeParse(params[0]).success;
        if (recoveryMethod && !recoveryRequest) {
          if (!invalidRpcRateLimiter.allow(clientIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            error: {
              code: RPC_ERRORS.INVALID_PARAMS,
              message: "Invalid params for aztec_getSettlement",
              ...(params.length === 1 && namesRetiredVersion(params[0])
                ? { data: { reason: "settlement_version_unsupported", supported: SETTLEMENT_VERSION } }
                : {}),
            },
          });
          return;
        }
        if (recoveryEndpoint && !recoveryRequest) {
          if (!invalidRpcRateLimiter.allow(clientIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          sendJson(res, 400, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Recovery endpoint requires aztec_getSettlement" },
          });
          return;
        }
        const createNoteParams =
          method === "aztec_createNote" && params.length === 1
            ? CreateNoteSchema.safeParse(params[0])
            : undefined;
        const createNoteRequest =
          createNoteParams?.success === true &&
          idempotencyKey === createNoteParams.data.operationId;
        if (
          createNoteParams?.success === true &&
          idempotencyKey !== createNoteParams.data.operationId
        ) {
          if (!invalidRpcRateLimiter.allow(clientIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            error: {
              code: RPC_ERRORS.INVALID_PARAMS,
              message: "Idempotency-Key must equal operationId",
              data: { reason: "operation_id_mismatch" },
            },
          });
          return;
        }
        const versionRequest = method === "aztec_getVersion" && params.length === 0;
        if (!recoveryRequest && !createNoteRequest && !versionRequest) {
          if (!invalidRpcRateLimiter.allow(clientIp)) {
            sendJson(res, 429, { error: "Too many requests" });
            return;
          }
          const result = await handleRpcRequest(rpcRequest.data, client);
          sendJson(res, 200, result);
          return;
        }
        const requestRateLimiter = recoveryEndpoint ? recoveryRateLimiter : rpcRateLimiter;
        if (!requestRateLimiter.allow(clientIp)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        const lease = acquireBackendLease(recoveryEndpoint);
        if (lease === null) {
          sendJson(res, 503, { error: "Service busy" });
          return;
        }
        try {
          const rpcCtx: RpcContext = {
            limits: opts.limits,
            audit: opts.audit,
            settlement: opts.settlement,
            readiness: readinessObserver,
            idempotencyKey,
            signal: responseDeadline.signal,
            trackBackground: lease.trackBackground,
          };
          const result = await handleRpcRequest(parsed, client, rpcCtx);
          sendJson(res, 200, result);
        } finally {
          lease.finish();
        }
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch {
      console.error("[pxe-bridge] Unhandled request error");
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
