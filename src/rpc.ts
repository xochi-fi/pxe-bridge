import {
  JsonRpcRequestSchema,
  CreateNoteParamsSchema,
  PostSubmissionError,
  RPC_ERRORS,
  SUBMITTED_UNKNOWN_MESSAGE,
  type IAztecClient,
  type JsonRpcResponse,
} from "./types.js";
import type { TransactionLimits } from "./limits.js";
import type { IdempotencyStore, IdempotentOutcome } from "./idempotency.js";
import type { AuditLogger, AuditEntry } from "./audit.js";

export interface RpcContext {
  limits?: TransactionLimits | undefined;
  audit?: AuditLogger | undefined;
  idempotency?: IdempotencyStore | undefined;
  /** From the `Idempotency-Key` request header, when the caller sent one. */
  idempotencyKey?: string | undefined;
  clientIp?: string | undefined;
}

function auditBase(
  params: {
    recipient: string;
    token: string;
    amount: string;
    chainId: number;
    tradeId?: string | undefined;
    subTradeIndex?: number | undefined;
  },
  ctx: RpcContext,
): Omit<AuditEntry, "status" | "txHash" | "error"> {
  return {
    timestamp: new Date().toISOString(),
    method: "aztec_createNote",
    recipient: params.recipient,
    token: params.token,
    amount: params.amount,
    chainId: params.chainId,
    tradeId: params.tradeId,
    subTradeIndex: params.subTradeIndex,
    idempotencyKey: ctx.idempotencyKey,
    clientIp: ctx.clientIp ?? "unknown",
  };
}

/** Applies a recorded outcome to the id of the request replaying it. */
function replay(id: number | string, outcome: IdempotentOutcome): JsonRpcResponse {
  return outcome.kind === "result"
    ? success(id, outcome.result)
    : rpcError(id, outcome.code, outcome.message, outcome.data);
}

function success(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export async function handleRpcRequest(
  body: unknown,
  client: IAztecClient,
  ctx: RpcContext = {},
): Promise<JsonRpcResponse> {
  const parsed = JsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) {
    return rpcError(null, RPC_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC request");
  }

  const { id, method, params } = parsed.data;

  switch (method) {
    case "aztec_createNote":
      return handleCreateNote(id, params, client, ctx);
    case "aztec_getVersion":
      return handleGetVersion(id, client);
    default:
      return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleCreateNote(
  id: number | string,
  params: unknown[],
  client: IAztecClient,
  ctx: RpcContext,
): Promise<JsonRpcResponse> {
  const first = params[0];
  const parsed = CreateNoteParamsSchema.safeParse(first);
  if (!parsed.success) {
    console.error("[rpc] Invalid createNote params:", parsed.error.message);
    return rpcError(id, RPC_ERRORS.INVALID_PARAMS, "Invalid params for aztec_createNote");
  }

  const noteParams = parsed.data;
  const amount = BigInt(noteParams.amount);

  // Claimed before the limits are touched, so a duplicate neither transfers
  // nor consumes budget. Claiming is synchronous, so two concurrent requests
  // carrying the same key cannot both proceed.
  const key = ctx.idempotency && ctx.idempotencyKey ? ctx.idempotencyKey : undefined;
  if (ctx.idempotency && key !== undefined) {
    const lookup = ctx.idempotency.begin(key);
    if (lookup.state === "settled") {
      console.log(`[rpc] Replaying idempotency key ${key}`);
      return replay(id, lookup.outcome);
    }
    if (lookup.state === "in-flight") {
      console.warn(`[rpc] Idempotency key ${key} is already in flight`);
      return rpcError(
        id,
        RPC_ERRORS.INTERNAL_ERROR,
        "A request with this Idempotency-Key is still in flight",
      );
    }
  }

  /** Frees the key: nothing moved, so a retry is legitimate. */
  const abandon = (): void => {
    if (ctx.idempotency && key !== undefined) ctx.idempotency.abandon(key);
  };
  /** Holds the key: a duplicate must replay this rather than transfer again. */
  const settle = (outcome: IdempotentOutcome): void => {
    if (ctx.idempotency && key !== undefined) ctx.idempotency.settle(key, outcome);
  };

  // Enforce transaction limits (ceiling, daily volume, circuit breaker).
  // reserve() counts the amount against the rolling window immediately, so
  // concurrent in-flight requests cannot each pass on a stale total and
  // collectively exceed the daily cap (TOCTOU). The reservation is committed
  // on success or released on failure below.
  let reservationId: number | undefined;
  if (ctx.limits) {
    const reservation = ctx.limits.reserve(amount);
    if (!reservation.allowed) {
      console.error("[rpc] Limit rejected:", reservation.reason);
      abandon();
      if (ctx.audit) {
        await ctx.audit.log({
          ...auditBase(noteParams, ctx),
          status: "rejected",
          error: reservation.reason,
        });
      }
      return rpcError(id, RPC_ERRORS.INVALID_PARAMS, reservation.reason);
    }

    reservationId = reservation.reservationId;

    // Cooldown for large transfers (amount is already reserved, so this
    // delay does not widen the race window).
    if (reservation.cooldownMs) {
      console.log(`[rpc] Cooldown ${reservation.cooldownMs}ms for amount ${noteParams.amount}`);
      await delay(reservation.cooldownMs);
    }
  }

  // Intent, written and flushed BEFORE the send. A crash between submitting
  // and recording the outcome would otherwise leave the log silent about a
  // transfer that may have landed, and a restart would hand the key back as
  // fresh. Replaying a `submitting` entry with no successor as "unknown" is
  // what closes that window, and only this write makes it visible.
  if (ctx.audit && key !== undefined) {
    await ctx.audit.log({ ...auditBase(noteParams, ctx), status: "submitting" });
  }

  try {
    const result = await client.createNote(noteParams);

    // Finalize the reservation as a permanent spend after successful tx
    if (ctx.limits && reservationId !== undefined) {
      ctx.limits.commit(reservationId);
    }

    settle({ kind: "result", result });

    if (ctx.audit) {
      await ctx.audit.log({
        ...auditBase(noteParams, ctx),
        status: "success",
        txHash: result.l2TxHash,
        noteHashes: result.noteHashes,
        nullifiers: result.nullifiers,
      });
    }

    return success(id, result);
  } catch (cause) {
    console.error("[rpc] aztec_createNote failed:", cause);

    // A PostSubmissionError means the transfer may already be on chain, so the
    // amount has to stay counted. Releasing it let a caller repeat whatever
    // caused the failure -- a slow node, most obviously -- and move funds past
    // the daily cap without the window ever seeing them.
    const landed = cause instanceof PostSubmissionError;
    if (ctx.limits && reservationId !== undefined) {
      if (landed) {
        ctx.limits.commit(reservationId);
      } else {
        ctx.limits.release(reservationId);
      }
    }

    // Distinct from a clean rejection: the caller has to reconcile rather than
    // assume nothing happened. Retrying this blindly sends a second transfer,
    // which is why the key holds it rather than freeing it.
    const outcome: IdempotentOutcome = landed
      ? {
          kind: "error",
          code: RPC_ERRORS.INTERNAL_ERROR,
          message: SUBMITTED_UNKNOWN_MESSAGE,
          ...(cause.txHash !== undefined ? { data: { txHash: cause.txHash } } : {}),
        }
      : { kind: "error", code: RPC_ERRORS.INTERNAL_ERROR, message: "Internal error" };

    if (landed) {
      settle(outcome);
    } else {
      abandon();
    }

    if (ctx.audit) {
      await ctx.audit.log({
        ...auditBase(noteParams, ctx),
        // "unknown" rather than "error": whether this moved funds is exactly
        // what is not known, and the replay reader has to tell the two apart.
        status: landed ? "unknown" : "error",
        ...(landed && cause.txHash ? { txHash: cause.txHash } : {}),
        error: cause instanceof Error ? cause.message : "Unknown error",
      });
    }

    return replay(id, outcome);
  }
}

async function handleGetVersion(
  id: number | string,
  client: IAztecClient,
): Promise<JsonRpcResponse> {
  try {
    const version = await client.getVersion();
    return success(id, version);
  } catch (cause) {
    console.error("[rpc] aztec_getVersion failed:", cause);
    return rpcError(id, RPC_ERRORS.INTERNAL_ERROR, "Internal error");
  }
}
