import {
  JsonRpcRequestSchema,
  CreateNoteParamsSchema,
  RPC_ERRORS,
  type IAztecClient,
  type JsonRpcResponse,
} from "./types.js";

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
      return handleCreateNote(id, params, client);
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

async function handleCreateNote(
  id: number | string,
  params: unknown[],
  client: IAztecClient,
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

  try {
    const result = await client.createNote(parsed.data);
    return success(id, result);
  } catch (cause) {
    console.error("[rpc] aztec_createNote failed:", cause);
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
