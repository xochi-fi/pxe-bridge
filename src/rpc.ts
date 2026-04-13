import type { AztecClient } from "./aztec-client.js";
import {
  JsonRpcRequestSchema,
  CreateNoteParamsSchema,
  RPC_ERRORS,
  type JsonRpcResponse,
} from "./types.js";

function success(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleRpcRequest(
  body: unknown,
  client: AztecClient,
): Promise<JsonRpcResponse> {
  const parsed = JsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) {
    return error(0, RPC_ERRORS.INVALID_REQUEST, `Invalid JSON-RPC request: ${parsed.error.message}`);
  }

  const { id, method, params } = parsed.data;

  switch (method) {
    case "aztec_createNote":
      return handleCreateNote(id, params, client);
    case "aztec_getVersion":
      return handleGetVersion(id, client);
    default:
      return error(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

async function handleCreateNote(
  id: number | string,
  params: unknown[],
  client: AztecClient,
): Promise<JsonRpcResponse> {
  const first = params[0];
  const parsed = CreateNoteParamsSchema.safeParse(first);
  if (!parsed.success) {
    return error(id, RPC_ERRORS.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }

  try {
    const result = await client.createNote(parsed.data);
    return success(id, result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error("[rpc] aztec_createNote failed:", cause);
    return error(id, RPC_ERRORS.INTERNAL_ERROR, message);
  }
}

async function handleGetVersion(
  id: number | string,
  client: AztecClient,
): Promise<JsonRpcResponse> {
  try {
    const version = await client.getVersion();
    return success(id, version);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error("[rpc] aztec_getVersion failed:", cause);
    return error(id, RPC_ERRORS.INTERNAL_ERROR, message);
  }
}
