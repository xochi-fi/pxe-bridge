import { describe, it, expect } from "vitest";
import { JsonRpcRequestSchema, CreateNoteParamsSchema } from "../src/types.js";

const VALID_ADDR = "0x" + "a".repeat(64);

describe("JsonRpcRequestSchema", () => {
  it("accepts a valid request", () => {
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      method: "aztec_createNote",
      params: [{}],
    });
    expect(result.success).toBe(true);
  });

  it("accepts string id", () => {
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: "abc-123",
      method: "test",
    });
    expect(result.success).toBe(true);
  });

  it("defaults params to empty array", () => {
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      method: "test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toEqual([]);
    }
  });

  it("rejects wrong jsonrpc version", () => {
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: "1.0",
      id: 1,
      method: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing jsonrpc", () => {
    const result = JsonRpcRequestSchema.safeParse({
      id: 1,
      method: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing method", () => {
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects null id", () => {
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: null,
      method: "test",
    });
    expect(result.success).toBe(false);
  });
});

describe("CreateNoteParamsSchema", () => {
  const validParams = {
    recipient: VALID_ADDR,
    token: VALID_ADDR,
    amount: "1000000000000000000",
    chainId: 1,
  };

  it("accepts valid params", () => {
    const result = CreateNoteParamsSchema.safeParse(validParams);
    expect(result.success).toBe(true);
  });

  it("rejects short hex address", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      recipient: "0xabc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-hex recipient", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      recipient: "not-hex",
    });
    expect(result.success).toBe(false);
  });

  it("rejects address without 0x prefix", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      token: "a".repeat(64),
    });
    expect(result.success).toBe(false);
  });

  it("rejects decimal amount", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      amount: "12.5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric amount", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      amount: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero chainId", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      chainId: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative chainId", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      chainId: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects fractional chainId", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      chainId: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("accepts amount without leading zeros", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      amount: "1000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects leading zeros in amount", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      amount: "01000",
    });
    expect(result.success).toBe(false);
  });

  it("rejects amount exceeding 78 digits", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      amount: "1" + "0".repeat(78),
    });
    expect(result.success).toBe(false);
  });

  it("accepts very large numeric amount (bigint-scale)", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      amount:
        "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty string amount", () => {
    const result = CreateNoteParamsSchema.safeParse({
      ...validParams,
      amount: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields individually", () => {
    for (const key of Object.keys(validParams)) {
      const partial = { ...validParams };
      delete (partial as Record<string, unknown>)[key];
      const result = CreateNoteParamsSchema.safeParse(partial);
      expect(result.success, `should reject missing ${key}`).toBe(false);
    }
  });

  describe("XIP-1 trade context", () => {
    const tradeContext = {
      tradeId: "0x" + "b".repeat(64),
      subTradeIndex: 0,
      totalSubTrades: 3,
    };

    it("accepts params with full trade context", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        ...tradeContext,
      });
      expect(result.success).toBe(true);
    });

    it("accepts params without trade context (backwards compat)", () => {
      const result = CreateNoteParamsSchema.safeParse(validParams);
      expect(result.success).toBe(true);
    });

    it("rejects partial trade context: tradeId only", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
      });
      expect(result.success).toBe(false);
    });

    it("rejects partial trade context: subTradeIndex only", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        subTradeIndex: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects partial trade context: totalSubTrades only", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        totalSubTrades: 3,
      });
      expect(result.success).toBe(false);
    });

    it("rejects partial trade context: two of three fields", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects subTradeIndex >= totalSubTrades", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: 3,
        totalSubTrades: 3,
      });
      expect(result.success).toBe(false);
    });

    it("rejects subTradeIndex > totalSubTrades", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: 5,
        totalSubTrades: 3,
      });
      expect(result.success).toBe(false);
    });

    it("accepts subTradeIndex at last valid position", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: 2,
        totalSubTrades: 3,
      });
      expect(result.success).toBe(true);
    });

    it("rejects negative subTradeIndex", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: -1,
        totalSubTrades: 3,
      });
      expect(result.success).toBe(false);
    });

    it("rejects totalSubTrades of 0", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: 0,
        totalSubTrades: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects totalSubTrades of 1 (below XIP-1 minimum of 2)", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: 0,
        totalSubTrades: 1,
      });
      expect(result.success).toBe(false);
    });

    it("accepts totalSubTrades at upper bound (100)", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: 0,
        totalSubTrades: 100,
      });
      expect(result.success).toBe(true);
    });

    it("rejects totalSubTrades above max (101)", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: tradeContext.tradeId,
        subTradeIndex: 0,
        totalSubTrades: 101,
      });
      expect(result.success).toBe(false);
    });

    it("accepts uppercase hex in tradeId", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: "0x" + "A".repeat(64),
        subTradeIndex: 0,
        totalSubTrades: 3,
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid tradeId format", () => {
      const result = CreateNoteParamsSchema.safeParse({
        ...validParams,
        tradeId: "not-a-hex-id",
        subTradeIndex: 0,
        totalSubTrades: 3,
      });
      expect(result.success).toBe(false);
    });
  });
});
