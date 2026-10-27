import { z } from "zod";

/**
 * The binding-revocation signal (xochi §7 "Decided 2026-10-24"): before the
 * bridge marks an operation may-broadcast, it asks Riddler, synchronously,
 * whether this admitted operation may still broadcast. Riddler answers from
 * the operation's captured admission, not the binding's current state.
 *
 * Only `allow` proceeds. `deny` and `unknown` hold the operation `prepared`:
 * not broadcast, retried later, never refunded. A timeout, a transport error,
 * a non-2xx status or a body that is not exactly the contract are all
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
  const timeoutMs = config.timeoutMs ?? MAY_BROADCAST_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;
  return async (query) => {
    let response: Response;
    try {
      response = await doFetch(config.url, {
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
    if (!response.ok) {
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
