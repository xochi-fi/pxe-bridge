import { describe, it, expect, beforeEach } from "vitest";
import { handleRpcRequest } from "../src/rpc.js";
import type {
  CreateNoteParams,
  CreateNoteResult,
  IAztecClient,
} from "../src/types.js";

const VALID_ADDR = "0x" + "a".repeat(64);

class FakeAztecClient implements IAztecClient {
  createNoteResult: CreateNoteResult = {
    noteCommitment: "0xcommit",
    nullifierHash: "0xnullifier",
    l2TxHash: "0xtx",
  };
  createNoteError: Error | null = null;
  versionResult = "4.1.3";
  versionError: Error | null = null;
  lastCreateNoteParams: CreateNoteParams | null = null;

  async connect(): Promise<void> {}

  async createNote(params: CreateNoteParams): Promise<CreateNoteResult> {
    this.lastCreateNoteParams = params;
    if (this.createNoteError) throw this.createNoteError;
    return this.createNoteResult;
  }

  async getVersion(): Promise<string> {
    if (this.versionError) throw this.versionError;
    return this.versionResult;
  }
}

function rpcRequest(method: string, params: unknown[] = []) {
  return { jsonrpc: "2.0" as const, id: 1, method, params };
}

describe("handleRpcRequest", () => {
  let client: FakeAztecClient;

  beforeEach(() => {
    client = new FakeAztecClient();
  });

  describe("envelope validation", () => {
    it("rejects non-object body", async () => {
      const res = await handleRpcRequest("not json", client);
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32600);
      }
    });

    it("rejects missing jsonrpc field", async () => {
      const res = await handleRpcRequest({ id: 1, method: "test" }, client);
      expect(res).toHaveProperty("error");
    });

    it("rejects wrong jsonrpc version", async () => {
      const res = await handleRpcRequest(
        { jsonrpc: "1.0", id: 1, method: "test" },
        client,
      );
      expect(res).toHaveProperty("error");
    });
  });

  describe("method routing", () => {
    it("returns METHOD_NOT_FOUND for unknown method", async () => {
      const res = await handleRpcRequest(rpcRequest("unknown_method"), client);
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32601);
        expect(res.error.message).toContain("unknown_method");
      }
    });
  });

  describe("aztec_getVersion", () => {
    it("returns version string", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_getVersion"),
        client,
      );
      expect(res).toHaveProperty("result");
      if ("result" in res) {
        expect(res.result).toBe("4.1.3");
      }
    });

    it("returns INTERNAL_ERROR when client throws", async () => {
      client.versionError = new Error("connection refused");
      const res = await handleRpcRequest(
        rpcRequest("aztec_getVersion"),
        client,
      );
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32603);
        expect(res.error.message).toBe("Internal error");
      }
    });
  });

  describe("aztec_createNote", () => {
    const validParams = {
      recipient: VALID_ADDR,
      token: VALID_ADDR,
      amount: "1000",
      chainId: 1,
    };

    it("returns note result on success", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [validParams]),
        client,
      );
      expect(res).toHaveProperty("result");
      if ("result" in res) {
        expect(res.result).toEqual(client.createNoteResult);
      }
    });

    it("passes parsed params to client", async () => {
      await handleRpcRequest(
        rpcRequest("aztec_createNote", [validParams]),
        client,
      );
      expect(client.lastCreateNoteParams).toEqual(validParams);
    });

    it("returns INVALID_PARAMS for missing params", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", []),
        client,
      );
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });

    it("returns INVALID_PARAMS for bad recipient", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [{ ...validParams, recipient: "bad" }]),
        client,
      );
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });

    it("returns INTERNAL_ERROR when client throws", async () => {
      client.createNoteError = new Error("tx reverted");
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [validParams]),
        client,
      );
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32603);
        expect(res.error.message).toBe("Internal error");
      }
    });

    it("does not leak internal error details", async () => {
      client.createNoteError = new Error("secret internal details");
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [validParams]),
        client,
      );
      if ("error" in res) {
        expect(res.error.message).not.toContain("secret");
      }
    });

    it("accepts params with XIP-1 trade context", async () => {
      const paramsWithTrade = {
        ...validParams,
        tradeId: "0x" + "b".repeat(64),
        subTradeIndex: 1,
        totalSubTrades: 3,
      };
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [paramsWithTrade]),
        client,
      );
      expect(res).toHaveProperty("result");
      expect(client.lastCreateNoteParams).toEqual(paramsWithTrade);
    });

    it("rejects partial XIP-1 trade context", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [
          { ...validParams, tradeId: "0x" + "b".repeat(64) },
        ]),
        client,
      );
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });
  });

  describe("params edge cases", () => {
    it("returns INVALID_PARAMS when params[0] is null", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [null]),
        client,
      );
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });

    it("returns INVALID_PARAMS when params[0] is a number", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [123]),
        client,
      );
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });

    it("returns INVALID_PARAMS when params[0] is a string", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", ["hello"]),
        client,
      );
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });
  });

  describe("batch requests", () => {
    it("rejects array body as invalid request", async () => {
      const batch = [
        rpcRequest("aztec_getVersion"),
        rpcRequest("aztec_getVersion"),
      ];
      const res = await handleRpcRequest(batch, client);
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32600);
      }
    });
  });

  describe("id fallback", () => {
    it("uses id=null when envelope is invalid (per JSON-RPC spec)", async () => {
      const res = await handleRpcRequest({ not: "valid" }, client);
      expect(res.id).toBeNull();
    });
  });

  describe("id preservation", () => {
    it("preserves numeric id", async () => {
      const res = await handleRpcRequest(
        { jsonrpc: "2.0", id: 42, method: "aztec_getVersion", params: [] },
        client,
      );
      expect(res.id).toBe(42);
    });

    it("preserves string id", async () => {
      const res = await handleRpcRequest(
        {
          jsonrpc: "2.0",
          id: "req-123",
          method: "aztec_getVersion",
          params: [],
        },
        client,
      );
      expect(res.id).toBe("req-123");
    });
  });
});
