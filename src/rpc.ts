import {
  JsonRpcRequestSchema,
  CreateNoteParamsSchema,
  RPC_ERRORS,
  type IAztecClient,
  type JsonRpcResponse,
} from "./types.js";
import type { TransactionLimits } from "./limits.js";
import type { AuditLogger, AuditEntry } from "./audit.js";

export interface RpcContext {
  limits?: TransactionLimits | undefined;
  audit?: AuditLogger | undefined;
  clientIp?: string | undefined;
}

function auditBase(
  params: {
    recipient: string;
    token: string;
    amount: string;
    chainId: number;
    tradeId?: string | undefined;
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
    clientIp: ctx.clientIp ?? "unknown",
  };
}

function success(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
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

  try {
    const result = await client.createNote(noteParams);

    // Finalize the reservation as a permanent spend after successful tx
    if (ctx.limits && reservationId !== undefined) {
      ctx.limits.commit(reservationId);
    }

    if (ctx.audit) {
      await ctx.audit.log({
        ...auditBase(noteParams, ctx),
        status: "success",
        txHash: result.l2TxHash,
      });
    }

    return success(id, result);
  } catch (cause) {
    console.error("[rpc] aztec_createNote failed:", cause);

    // Free the reservation so a failed tx does not count against the cap
    if (ctx.limits && reservationId !== undefined) {
      ctx.limits.release(reservationId);
    }

    if (ctx.audit) {
      await ctx.audit.log({
        ...auditBase(noteParams, ctx),
        status: "error",
        error: cause instanceof Error ? cause.message : "Unknown error",
      });
    }

    return rpcError(id, RPC_ERRORS.INTERNAL_ERROR, "Internal error");
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
