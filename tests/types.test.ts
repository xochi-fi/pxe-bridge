import { describe, it, expect } from "vitest";
import { JsonRpcRequestSchema } from "../src/types.js";

// The createNote payload schema and its refusals live in settlement.test.ts.
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
