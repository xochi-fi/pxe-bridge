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
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | {
      jsonrpc: "2.0";
      id: number | string | null;
      error: { code: number; message: string };
    };

// aztec_createNote params
export const CreateNoteParamsSchema = z
  .object({
    recipient: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "Must be 32-byte hex address"),
    token: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "Must be 32-byte hex address"),
    amount: z
      .string()
      .regex(
        /^(0|[1-9]\d*)$/,
        "Must be non-negative integer without leading zeros",
      )
      .refine((s) => s.length <= 78, "Amount exceeds uint256 max (78 digits)"),
    chainId: z.number().int().positive(),
    // XIP-1 trade context (optional, but all-or-nothing)
    tradeId: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "Must be 32-byte hex identifier")
      .optional(),
    subTradeIndex: z.number().int().min(0).optional(),
    totalSubTrades: z.number().int().min(2).max(100).optional(),
  })
  .refine(
    (data) => {
      const fields = [data.tradeId, data.subTradeIndex, data.totalSubTrades];
      const provided = fields.filter((f) => f !== undefined).length;
      return provided === 0 || provided === 3;
    },
    {
      message:
        "tradeId, subTradeIndex, and totalSubTrades must all be provided together",
    },
  )
  .refine(
    (data) => {
      if (
        data.subTradeIndex !== undefined &&
        data.totalSubTrades !== undefined
      ) {
        return data.subTradeIndex < data.totalSubTrades;
      }
      return true;
    },
    { message: "subTradeIndex must be less than totalSubTrades" },
  );

export type CreateNoteParams = z.infer<typeof CreateNoteParamsSchema>;

export interface CreateNoteResult {
  noteCommitment: string;
  nullifierHash: string;
  l2TxHash: string;
}

// Fee Juice claim from L1->L2 bridge (one-time account deployment)
export const FeeJuiceClaimSchema = z.object({
  claimAmount: z.string().regex(/^\d+$/, "Must be a non-negative integer"),
  claimSecret: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "Must be 32-byte hex Fr element"),
  messageLeafIndex: z.string().regex(/^\d+$/, "Must be a non-negative integer"),
});

export type FeeJuiceClaim = z.infer<typeof FeeJuiceClaimSchema>;

// Abstraction over AztecClient for testability
export interface IAztecClient {
  connect(): Promise<void>;
  createNote(params: CreateNoteParams): Promise<CreateNoteResult>;
  getVersion(): Promise<string>;
}

// JSON-RPC error codes
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
