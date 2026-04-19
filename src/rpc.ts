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

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleRpcRequest(
  body: unknown,
  client: IAztecClient,
  ctx: RpcContext = {},
): Promise<JsonRpcResponse> {
  const parsed = JsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) {
    return rpcError(
      null,
      RPC_ERRORS.INVALID_REQUEST,
      "Invalid JSON-RPC request",
    );
  }

  const { id, method, params } = parsed.data;

  switch (method) {
    case "aztec_createNote":
      return handleCreateNote(id, params, client, ctx);
    case "aztec_getVersion":
      return handleGetVersion(id, client);
    default:
      return rpcError(
        id,
        RPC_ERRORS.METHOD_NOT_FOUND,
        `Unknown method: ${method}`,
      );
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
    return rpcError(
      id,
      RPC_ERRORS.INVALID_PARAMS,
      "Invalid params for aztec_createNote",
    );
  }

  const noteParams = parsed.data;
  const amount = BigInt(noteParams.amount);

  // Enforce transaction limits (ceiling, daily volume, circuit breaker)
  if (ctx.limits) {
    const check = ctx.limits.check(amount);
    if (!check.allowed) {
      console.error("[rpc] Limit rejected:", check.reason);
      if (ctx.audit) {
        await ctx.audit.log({
          ...auditBase(noteParams, ctx),
          status: "rejected",
          error: check.reason,
        });
      }
      return rpcError(id, RPC_ERRORS.INVALID_PARAMS, check.reason);
    }

    // Cooldown for large transfers
    if (check.cooldownMs) {
      console.log(
        `[rpc] Cooldown ${check.cooldownMs}ms for amount ${noteParams.amount}`,
      );
      await delay(check.cooldownMs);
    }
  }

  try {
    const result = await client.createNote(noteParams);

    // Record spend after successful tx
    if (ctx.limits) {
      ctx.limits.recordSpend(amount);
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
