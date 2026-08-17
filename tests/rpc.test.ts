import { describe, it, expect, beforeEach } from "vitest";
import { handleRpcRequest, type RpcContext } from "../src/rpc.js";
import { TransactionLimits } from "../src/limits.js";
import { IdempotencyStore } from "../src/idempotency.js";
import { PostSubmissionError } from "../src/types.js";
import type { AuditEntry, AuditLogger } from "../src/audit.js";
import type { CreateNoteParams, CreateNoteResult, IAztecClient } from "../src/types.js";

const VALID_ADDR = "0x" + "a".repeat(64);

class FakeAztecClient implements IAztecClient {
  createNoteResult: CreateNoteResult = {
    // Two note hashes and three nullifiers, matching what a real
    // transfer_to_private emits: a fake with one of each would hide the reason
    // the scalar fields below are ambiguous.
    noteHashes: ["0xcommit", "0xcommit2"],
    nullifiers: ["0xnullifier", "0xnullifier2", "0xnullifier3"],
    l2TxHash: "0xtx",
    noteCommitment: "0xcommit",
    nullifierHash: "0xnullifier",
  };
  createNoteError: Error | null = null;
  versionResult = "4.1.3";
  versionError: Error | null = null;
  lastCreateNoteParams: CreateNoteParams | null = null;
  /** Counts real executions, so a replay is distinguishable from a re-run. */
  createNoteCalls = 0;
  /** Holds the call open long enough for a concurrent duplicate to arrive. */
  createNoteDelayMs = 0;

  async connect(): Promise<void> {}

  async createNote(params: CreateNoteParams): Promise<CreateNoteResult> {
    this.lastCreateNoteParams = params;
    this.createNoteCalls++;
    if (this.createNoteDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.createNoteDelayMs));
    }
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
      const res = await handleRpcRequest({ jsonrpc: "1.0", id: 1, method: "test" }, client);
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
      const res = await handleRpcRequest(rpcRequest("aztec_getVersion"), client);
      expect(res).toHaveProperty("result");
      if ("result" in res) {
        expect(res.result).toBe("4.1.3");
      }
    });

    it("returns INTERNAL_ERROR when client throws", async () => {
      client.versionError = new Error("connection refused");
      const res = await handleRpcRequest(rpcRequest("aztec_getVersion"), client);
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
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [validParams]), client);
      expect(res).toHaveProperty("result");
      if ("result" in res) {
        expect(res.result).toEqual(client.createNoteResult);
      }
    });

    it("returns every note hash and nullifier, not just the first", async () => {
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [validParams]), client);
      expect(res).toHaveProperty("result");
      if ("result" in res) {
        const result = res.result as CreateNoteResult;
        // The whole point of the shape: a transfer emits more than one of each,
        // so truncating to a scalar loses the values a caller may actually want.
        expect(result.noteHashes).toHaveLength(2);
        expect(result.nullifiers).toHaveLength(3);
        // The deprecated scalars stay consistent with the arrays they alias.
        expect(result.noteCommitment).toBe(result.noteHashes[0]);
        expect(result.nullifierHash).toBe(result.nullifiers[0]);
      }
    });

    it("passes parsed params to client", async () => {
      await handleRpcRequest(rpcRequest("aztec_createNote", [validParams]), client);
      expect(client.lastCreateNoteParams).toEqual(validParams);
    });

    it("returns INVALID_PARAMS for missing params", async () => {
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", []), client);
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
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [validParams]), client);
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32603);
        expect(res.error.message).toBe("Internal error");
      }
    });

    it("does not leak internal error details", async () => {
      client.createNoteError = new Error("secret internal details");
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [validParams]), client);
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
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [paramsWithTrade]), client);
      expect(res).toHaveProperty("result");
      expect(client.lastCreateNoteParams).toEqual(paramsWithTrade);
    });

    it("rejects partial XIP-1 trade context", async () => {
      const res = await handleRpcRequest(
        rpcRequest("aztec_createNote", [{ ...validParams, tradeId: "0x" + "b".repeat(64) }]),
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
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [null]), client);
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });

    it("returns INVALID_PARAMS when params[0] is a number", async () => {
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [123]), client);
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });

    it("returns INVALID_PARAMS when params[0] is a string", async () => {
      const res = await handleRpcRequest(rpcRequest("aztec_createNote", ["hello"]), client);
      expect(res).toHaveProperty("error");
      if ("error" in res) {
        expect(res.error.code).toBe(-32602);
      }
    });
  });

  describe("batch requests", () => {
    it("rejects array body as invalid request", async () => {
      const batch = [rpcRequest("aztec_getVersion"), rpcRequest("aztec_getVersion")];
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

  // A transfer that may already be on chain must not be accounted as if
  // nothing happened. Releasing the reservation let a caller repeat whatever
  // caused the failure -- a slow node, most obviously -- and move funds past
  // the daily cap without the window ever seeing them.
  describe("post-submission failures", () => {
    const noteParams = {
      recipient: VALID_ADDR,
      token: VALID_ADDR,
      amount: "3000",
      chainId: 1,
    };

    it("counts the amount against the window instead of releasing it", async () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      client.createNoteError = new PostSubmissionError("Incomplete receipt", "0xabc");

      await handleRpcRequest(rpcRequest("aztec_createNote", [noteParams]), client, { limits });

      // 3000 stayed counted, so a second 3000 no longer fits under 5000.
      expect(limits.check(3000n).allowed).toBe(false);
    });

    it("still releases when the failure was before submission", async () => {
      const limits = new TransactionLimits({ dailyLimit: 5000n });
      client.createNoteError = new Error("simulation reverted");

      await handleRpcRequest(rpcRequest("aztec_createNote", [noteParams]), client, { limits });

      expect(limits.check(5000n).allowed).toBe(true);
    });

    it("returns a distinct message and the txHash to reconcile against", async () => {
      client.createNoteError = new PostSubmissionError("Incomplete receipt", "0xabc");

      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [noteParams]), client);

      expect("error" in res && res.error.message).toContain("do not retry");
      expect("error" in res && res.error.data).toEqual({ txHash: "0xabc" });
    });

    // Without a hash there is nothing to reconcile against, so the message has
    // to carry the warning on its own.
    it("omits data when no txHash is known", async () => {
      client.createNoteError = new PostSubmissionError("Timed out");

      const res = await handleRpcRequest(rpcRequest("aztec_createNote", [noteParams]), client);

      expect("error" in res && res.error.message).toContain("result unknown");
      expect("error" in res && "data" in res.error).toBe(false);
    });

    it("records the failure as unknown, not error", async () => {
      const logged: AuditEntry[] = [];
      const audit = { log: async (e: AuditEntry) => void logged.push(e) } as AuditLogger;
      client.createNoteError = new PostSubmissionError("Incomplete receipt", "0xabc");

      await handleRpcRequest(rpcRequest("aztec_createNote", [noteParams]), client, { audit });

      // "this moved nothing" and "we do not know whether this moved funds"
      // call for opposite responses on replay.
      expect(logged.at(-1)?.status).toBe("unknown");
    });

    it("records the txHash on the audit entry", async () => {
      const logged: AuditEntry[] = [];
      const audit = { log: async (e: AuditEntry) => void logged.push(e) } as AuditLogger;
      client.createNoteError = new PostSubmissionError("Incomplete receipt", "0xabc");

      await handleRpcRequest(rpcRequest("aztec_createNote", [noteParams]), client, { audit });

      expect(logged.at(-1)?.status).toBe("unknown");
      expect(logged.at(-1)?.txHash).toBe("0xabc");
    });
  });

  describe("idempotency", () => {
    const noteParams = {
      recipient: VALID_ADDR,
      token: VALID_ADDR,
      amount: "3000",
      chainId: 1,
    };
    const send = (ctx: RpcContext) =>
      handleRpcRequest(rpcRequest("aztec_createNote", [noteParams]), client, ctx);

    let idempotency: IdempotencyStore;
    beforeEach(() => {
      idempotency = new IdempotencyStore();
    });

    // The failure this whole mechanism exists for: a transfer that may be on
    // chain, an error the caller cannot distinguish from a clean rejection,
    // and a retry that moves funds a second time.
    it("does not re-transfer when a retry replays a landed failure", async () => {
      client.createNoteError = new PostSubmissionError("Incomplete receipt", "0xabc");
      const ctx: RpcContext = { idempotency, idempotencyKey: "k1" };

      const first = await send(ctx);
      const callsAfterFirst = client.createNoteCalls;
      const second = await send(ctx);

      expect(client.createNoteCalls).toBe(callsAfterFirst);
      expect(second).toEqual(first);
    });

    it("replays a success without calling the client again", async () => {
      const ctx: RpcContext = { idempotency, idempotencyKey: "k1" };

      const first = await send(ctx);
      const second = await send(ctx);

      expect(client.createNoteCalls).toBe(1);
      expect(second).toEqual(first);
    });

    // The replay has to answer the request in front of it. Storing the whole
    // original response would have handed the first caller's id to the second.
    it("replays under the retrying request's own id", async () => {
      const ctx: RpcContext = { idempotency, idempotencyKey: "k1" };
      await send(ctx);

      const replayed = await handleRpcRequest(
        { jsonrpc: "2.0", id: "second-request", method: "aztec_createNote", params: [noteParams] },
        client,
        ctx,
      );

      expect(replayed.id).toBe("second-request");
      expect("result" in replayed && replayed.result).toEqual(client.createNoteResult);
    });

    // A retry after a definitive failure is legitimate: nothing moved, so the
    // key is free and the trade can still settle. Recording the error would
    // strand the caller with no way forward.
    it("lets a retry through after a clean failure", async () => {
      const ctx: RpcContext = { idempotency, idempotencyKey: "k1" };
      client.createNoteError = new Error("simulation reverted");
      await send(ctx);

      client.createNoteError = null;
      const retry = await send(ctx);

      expect(client.createNoteCalls).toBe(2);
      expect("result" in retry).toBe(true);
    });

    it("lets a retry through after the limits rejected it", async () => {
      const limits = new TransactionLimits({ maxAmount: 100n });
      const ctx: RpcContext = { idempotency, idempotencyKey: "k1", limits };

      expect("error" in (await send(ctx))).toBe(true);
      expect(client.createNoteCalls).toBe(0);

      // Same key, now under a limit that admits it.
      const allowed = await send({ idempotency, idempotencyKey: "k1" });
      expect("result" in allowed).toBe(true);
    });

    it("refuses a concurrent duplicate rather than running it twice", async () => {
      const ctx: RpcContext = { idempotency, idempotencyKey: "k1" };
      client.createNoteDelayMs = 20;

      const [a, b] = await Promise.all([send(ctx), send(ctx)]);

      expect(client.createNoteCalls).toBe(1);
      const messages = [a, b].map((r) => ("error" in r ? r.error.message : "ok"));
      expect(messages).toContain("ok");
      expect(messages.join(" ")).toContain("still in flight");
    });

    it("keeps distinct keys independent", async () => {
      await send({ idempotency, idempotencyKey: "k1" });
      await send({ idempotency, idempotencyKey: "k2" });

      expect(client.createNoteCalls).toBe(2);
    });

    // Unchanged behaviour for callers that send no header: every request runs.
    it("does not dedupe when no key is supplied", async () => {
      await send({ idempotency });
      await send({ idempotency });

      expect(client.createNoteCalls).toBe(2);
    });

    it("writes the intent record before the send", async () => {
      const logged: AuditEntry[] = [];
      const audit = { log: async (e: AuditEntry) => void logged.push(e) } as AuditLogger;

      await send({ idempotency, idempotencyKey: "k1", audit });

      // Ordering is the whole point: a crash between the two is recoverable
      // only because the first one is already on disk.
      expect(logged.map((e) => e.status)).toEqual(["submitting", "success"]);
      expect(logged.every((e) => e.idempotencyKey === "k1")).toBe(true);
    });

    // No key means no crash-window to protect, and the intent record only
    // exists to close that window.
    it("writes no intent record without a key", async () => {
      const logged: AuditEntry[] = [];
      const audit = { log: async (e: AuditEntry) => void logged.push(e) } as AuditLogger;

      await send({ idempotency, audit });

      expect(logged.map((e) => e.status)).toEqual(["success"]);
    });

    it("records the note effects so a replay after restart is faithful", async () => {
      const logged: AuditEntry[] = [];
      const audit = { log: async (e: AuditEntry) => void logged.push(e) } as AuditLogger;

      await send({ idempotency, idempotencyKey: "k1", audit });

      expect(logged.at(-1)?.noteHashes).toEqual(client.createNoteResult.noteHashes);
      expect(logged.at(-1)?.nullifiers).toEqual(client.createNoteResult.nullifiers);
    });
  });
});
