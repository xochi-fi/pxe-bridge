import { z } from "zod";

/**
 * The binding-revocation signal (xochi §7 "Decided 2026-10-24"): before the
 * bridge marks an operation may-broadcast, it asks Riddler, synchronously,
 * whether this admitted operation may still broadcast. Riddler answers from
 * the operation's captured admission, not the binding's current state, and
 * its first `allow` binds `{operationId, fingerprint, txHash}` (decision D-A,
 * docs/settlement-operations.md): a fresh transaction for an operation it has
 * already allowed is denied.
 *
 * Only `allow` proceeds. `deny` and `unknown` hold the operation `prepared`:
 * not broadcast, retried later, never refunded. A timeout, a transport error,
 * any status but 200, or a body that is not exactly the contract are all
 * `unknown` -- nothing here ever turns silence into permission.
 */
export const MAY_BROADCAST_VERSION = "pxe-bridge.may-broadcast.v1";

export type MayBroadcastDecision = "allow" | "deny" | "unknown";

export interface MayBroadcastQuery {
  operationId: string;
  fingerprint: string;
  txHash: string;
}

export interface MayBroadcastAnswer {
  decision: MayBroadcastDecision;
  /** Why the answer is what it is; for logs, never for control flow. */
  detail: string;
}

/** The DI boundary rpc.ts depends on; tests substitute it. */
export type MayBroadcastClient = (query: MayBroadcastQuery) => Promise<MayBroadcastAnswer>;

const ResponseSchema = z
  .object({
    version: z.literal(MAY_BROADCAST_VERSION),
    operationId: z.string(),
    decision: z.enum(["allow", "deny", "unknown"]),
  })
  .passthrough();

export const MAY_BROADCAST_TIMEOUT_MS = 5_000;

/**
 * Refuses a may-broadcast URL the bearer token and the allow/deny answer
 * could not safely travel over. `https:` anywhere; plain `http:` only to a
 * loopback host (`localhost`, 127.0.0.0/8, `[::1]`), in every mode: an
 * on-path attacker who reads the token can ask on the bridge's behalf, and
 * one who can write the answer can forge an `allow`. No credentials in the
 * URL, so the only secret is the bearer token.
 */
export function assertMayBroadcastUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PXE_BRIDGE_MAY_BROADCAST_URL is not a URL");
  }
  if (url.username || url.password) {
    throw new Error("PXE_BRIDGE_MAY_BROADCAST_URL must not carry credentials; use PXE_BRIDGE_MAY_BROADCAST_TOKEN");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol !== "http:") {
    throw new Error(`PXE_BRIDGE_MAY_BROADCAST_URL must be https (got ${url.protocol})`);
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host)) return url;
  throw new Error(
    `PXE_BRIDGE_MAY_BROADCAST_URL must be https: plain http is allowed only to a loopback ` +
      `host, and ${host} is not one. The bearer token and the allow/deny answer cross it.`,
  );
}

export interface HttpMayBroadcastConfig {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * `POST <url>` with `Authorization: Bearer <token>` and body
 * `{version, operationId, fingerprint, txHash}`. The answer must echo the
 * operation id; an answer about another operation is `unknown`.
 */
export function httpMayBroadcastClient(config: HttpMayBroadcastConfig): MayBroadcastClient {
  const url = assertMayBroadcastUrl(config.url).toString();
  const timeoutMs = config.timeoutMs ?? MAY_BROADCAST_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;
  return async (query) => {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ version: MAY_BROADCAST_VERSION, ...query }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      return {
        decision: "unknown",
        detail: timedOut ? `no answer within ${timeoutMs}ms` : `transport: ${String(cause)}`,
      };
    }
    // Exactly 200. The contract answers nothing else, and "any 2xx" would let
    // a proxy's or a stub's 201/202/204 carry an allow nobody gave.
    if (response.status !== 200) {
      return { decision: "unknown", detail: `HTTP ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { decision: "unknown", detail: "response is not JSON" };
    }
    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { decision: "unknown", detail: "response does not match the contract" };
    }
    if (parsed.data.operationId !== query.operationId) {
      return { decision: "unknown", detail: "response names a different operation" };
    }
    return { decision: parsed.data.decision, detail: "answered" };
  };
}
