import { z } from "zod";

// JSON-RPC envelope
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.array(z.unknown()).default([]),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string } };

// aztec_createNote params
export const CreateNoteParamsSchema = z.object({
  recipient: z.string().regex(/^0x[0-9a-fA-F]+$/, "Must be hex address"),
  token: z.string().regex(/^0x[0-9a-fA-F]+$/, "Must be hex address"),
  amount: z.string().regex(/^\d+$/, "Must be numeric string"),
  chainId: z.number().int().positive(),
});

export type CreateNoteParams = z.infer<typeof CreateNoteParamsSchema>;

export interface CreateNoteResult {
  noteCommitment: string;
  nullifierHash: string;
  l2TxHash: string;
}

// JSON-RPC error codes
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
