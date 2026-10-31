import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { handleRpcRequest, type RpcContext, type SettlementContext } from "../src/rpc.js";
import { RPC_ERRORS, SUBMITTED_UNKNOWN_MESSAGE } from "../src/types.js";
import { SettlementJournal } from "../src/journal.js";
import { TransactionLimits } from "../src/limits.js";
import { SETTLEMENT_VERSION, fingerprintTerms, termsFrom, CreateNoteV1Schema } from "../src/settlement.js";
import type { MayBroadcastClient } from "../src/may-broadcast.js";
import {
  FakeAztecClient,
  bindingMayBroadcast,
  fakeMayBroadcast,
  openBoundJournal,
  rpcBody,
  readyLimits,
  readyObserver,
  settlementContext,
  tempJournalPath,
  v1Params,
  TOKEN,
  VALID_UNTIL,
  type FakeMayBroadcast,
} from "./settlement-fixtures.js";

interface Answer {
  result?: { observation: { state: string; txHash?: string }; fingerprint: string } & Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: { observation?: { state: string; reason?: string; hold?: string; txHash?: string } } & Record<
      string,
      unknown
    >;
  };
}

async function createNote(
  client: FakeAztecClient,
  ctx: RpcContext,
  params: Record<string, unknown> = v1Params(),
  key: string | undefined = String(params["operationId"]),
): Promise<Answer> {
  return (await handleRpcRequest(rpcBody("aztec_createNote", [params]), client, {
    limits: readyLimits(),
    ...ctx,
    idempotencyKey: key,
  })) as Answer;
}

interface Settlement {
  found: boolean;
  fingerprint?: string;
  terms?: Record<string, unknown>;
  state?: string;
  attempts?: { txHash: string; mayBroadcast: boolean }[];
  observation: { state: string; reason?: string; txHash?: string; receiptStatus?: string };
  journal: { writable: boolean; reason?: string };
}

async function getSettlement(
  client: FakeAztecClient,
  ctx: RpcContext,
  operationId = "op-1",
): Promise<Settlement> {
  const res = (await handleRpcRequest(
    rpcBody("aztec_getSettlement", [{ version: SETTLEMENT_VERSION, operationId }]),
    client,
    ctx,
  )) as { result: Settlement };
  return res.result;
}

let client: FakeAztecClient;
let journal: SettlementJournal;
let gate: FakeMayBroadcast;
let s: SettlementContext;
let ctx: RpcContext;

beforeEach(() => {
  client = new FakeAztecClient();
  journal = openBoundJournal();
  gate = fakeMayBroadcast("allow");
  s = settlementContext(journal, gate.client);
  ctx = { settlement: s, limits: readyLimits() };
});

describe("aztec_createNote: the versioned payload", () => {
  it("refuses legacy params by name and does no work", async () => {
    const res = await createNote(
      client,
      ctx,
      { recipient: "0x" + "2".repeat(64), token: TOKEN, amount: "1", chainId: 1 },
      "legacy",
    );
    expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS);
    expect(res.error?.data).toEqual({ reason: "legacy_params_refused" });
    expect(client.proofs).toBe(0);
  });

  it.each([
    ["unknown key", { extra: true }],
    ["zero recipient", { recipient: "0x" + "0".repeat(64) }],
    ["amount above 2^128 - 1", { amount: (1n << 128n).toString() }],
    ["leading-zero amount", { amount: "01" }],
    ["wrong version", { version: "pxe-bridge.settlement.v0" }],
    ["short rollup address", { network: { ...v1Params()["network"] as object, rollupAddress: "0x12" } }],
  ])("refuses %s", async (_name, override) => {
    const res = await createNote(client, ctx, v1Params(override));
    expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS);
    expect(client.proofs).toBe(0);
  });

  it("does not log rejected shielded request fields", async () => {
    const sentinel = "private-recipient-note-or-transaction-id";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await createNote(client, ctx, {
        ...v1Params(),
        accountMode: sentinel,
        [sentinel]: sentinel,
      });
      expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS);
      expect(log).toHaveBeenCalledWith("[rpc] Invalid createNote params");
      expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    } finally {
      log.mockRestore();
    }
  });

  it("requires the Idempotency-Key to equal the operation id", async () => {
    const res = await createNote(client, ctx, v1Params(), "some-other-key");
    expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS);
    expect(res.error?.data).toEqual({ reason: "operation_id_mismatch" });
    expect(client.proofs).toBe(0);
  });

  it("refuses with -32004 when no journal is configured", async () => {
    const res = await createNote(client, {});
    expect(res.error?.code).toBe(RPC_ERRORS.JOURNAL_UNAVAILABLE);
  });
});

  it("returns typed not-ready data before proving or reserving", async () => {
    s.readiness = readyObserver({
      ready: false,
      reasons: ["account_paused", "fee_runway_insufficient"],
      policy: {
        initialized: true,
        paused: true,
        allowlistRoot: "0x" + "c".repeat(64),
        configuredAllowlistRoot: "0x" + "c".repeat(64),
      },
    });
    const limits = new TransactionLimits({ maxAmount: 1000n, dailyLimit: 10_000n });
    const res = await createNote(client, { settlement: s, limits });

    expect(res.error?.code).toBe(RPC_ERRORS.NOT_READY);
    expect(res.error?.data).toMatchObject({
      reason: "bridge_not_ready",
      reasons: ["account_paused", "fee_runway_insufficient"],
      finalized: { blockNumber: "7" },
    });
    expect(res.error?.data?.observation).toEqual({
      state: "not_submitted",
      reason: "account_paused",
      retryableAfterRevalidation: true,
    });
    expect(client.proofs).toBe(0);
    expect(limits.windowStatus().reserved).toBe(0n);
  });

describe("aztec_createNote: capacity against the live window", () => {
  // One chain observation shared by both requests, as the server's
  // single-flight readiness hands it out.
  it("cannot admit two transfers into a contract window with room for one", async () => {
    s.readiness = readyObserver({
      rollingWindow: {
        committed: "0",
        reserved: "0",
        headroom: "1000",
        localHeadroom: "10000",
        onChainSpent: "9000",
        onChainHeadroom: "1000",
        inFlightTransfers: 0,
      },
    });
    const answers = await Promise.all([
      createNote(client, ctx, v1Params({ operationId: "op-a" })),
      createNote(client, ctx, v1Params({ operationId: "op-b" })),
    ]);

    expect(answers.filter((a) => a.result?.observation.state === "included")).toHaveLength(1);
    const refused = answers.find((a) => a.error !== undefined);
    expect(refused?.error?.code).toBe(RPC_ERRORS.NOT_READY);
    expect(refused?.error?.data?.["reasons"]).toEqual(["spend_window_exhausted"]);
    expect(client.proofs).toBe(1);
    expect(client.sends).toHaveLength(1);
  });

  it("cannot admit two transfers on fee juice for one", async () => {
    s.readiness = readyObserver({
      maxAmount: "1000",
      dailyLimit: "1000",
      feeRunway: {
        observed: "1000",
        required: "1000",
        perTransferFeeLimit: "1000",
        mayBroadcastTransfers: 0,
      },
    });
    const limits = new TransactionLimits({ maxAmount: 1000n, dailyLimit: 1000n });
    // Both fit the 1000 window; only one fee is covered.
    const answers = await Promise.all([
      createNote(client, { settlement: s, limits }, v1Params({ operationId: "op-a", amount: "400" })),
      createNote(client, { settlement: s, limits }, v1Params({ operationId: "op-b", amount: "400" })),
    ]);

    expect(answers.filter((a) => a.result?.observation.state === "included")).toHaveLength(1);
    const refused = answers.find((a) => a.error !== undefined);
    expect(refused?.error?.code).toBe(RPC_ERRORS.NOT_READY);
    expect(refused?.error?.data?.["reasons"]).toEqual(["fee_runway_insufficient"]);
    expect(client.sends).toHaveLength(1);
  });

  it("holds a resumed prepared attempt that inventory or fee juice cannot cover", async () => {
    gate.decision = "unknown";
    await createNote(client, ctx);
    const [attempt] = journal.attempts("op-1");
    gate.decision = "allow";

    s.readiness = readyObserver({
      inventory: { observed: "999", required: "10000", mayBroadcastPrincipal: "0" },
    });
    const shortInventory = await createNote(client, ctx);
    expect(shortInventory.error?.code).toBe(RPC_ERRORS.NOT_READY);
    expect(shortInventory.error?.data?.["reasons"]).toEqual(["operation_inventory_insufficient"]);
    expect(shortInventory.error?.data?.observation).toMatchObject({
      state: "prepared",
      txHash: attempt!.txHash,
    });

    s.readiness = readyObserver({
      feeRunway: {
        observed: "999",
        required: "10000",
        perTransferFeeLimit: "1000",
        mayBroadcastTransfers: 0,
      },
    });
    const shortFee = await createNote(client, ctx);
    expect(shortFee.error?.data?.["reasons"]).toEqual(["operation_fee_runway_insufficient"]);
    expect(client.sends).toEqual([]);
    expect(ctx.limits!.windowStatus().reserved).toBe(0n);
    expect(journal.get("op-1")).toMatchObject({ state: "prepared" });

    s.readiness = readyObserver();
    const sent = await createNote(client, ctx);
    expect(sent.result?.observation).toMatchObject({ state: "included", txHash: attempt!.txHash });
    expect(client.proofs).toBe(1);
  });
});

describe("aztec_createNote: the broadcast gate", () => {
  it("journals, asks, marks, then broadcasts once and returns the observation", async () => {
    const res = await createNote(client, ctx);
    const params = CreateNoteV1Schema.parse(v1Params());
    expect(res.result?.observation.state).toBe("included");
    expect(res.result?.fingerprint).toBe(fingerprintTerms(termsFrom(params)));
    expect(gate.calls).toEqual(["op-1"]);
    expect(client.sends).toHaveLength(1);
    const op = journal.get("op-1")!;
    expect(op.state).toBe("may_broadcast");
    expect(journal.attempts("op-1")).toEqual([
      expect.objectContaining({ txHash: client.sends[0], mayBroadcastAt: expect.any(Number) }),
    ]);
    expect(journal.spendsSince(0)).toEqual([{ amount: 1000n, timestamp: expect.any(Number) }]);
  });

  it.each([
    ["deny", "may_broadcast_denied"],
    ["unknown", "may_broadcast_unknown"],
  ] as const)("holds on %s: prepared, never broadcast, never refunded", async (decision, hold) => {
    gate.decision = decision;
    const res = await createNote(client, ctx);
    expect(res.error?.code).toBe(RPC_ERRORS.NOT_SUBMITTED);
    expect(res.error?.data?.observation).toMatchObject({ state: "prepared", hold });
    expect(client.sends).toHaveLength(0);
    expect(journal.get("op-1")).toMatchObject({ state: "prepared", hold });
    expect(journal.spendsSince(0)).toEqual([]);
  });

  it("treats a may-broadcast that throws as a hold, not as permission", async () => {
    gate.decision = "throw";
    const res = await createNote(client, ctx);
    expect(res.error?.code).toBe(RPC_ERRORS.NOT_SUBMITTED);
    expect(res.error?.data?.observation).toMatchObject({ state: "prepared", hold: "interrupted" });
    expect(client.sends).toHaveLength(0);
  });

  it("never broadcasts when the answer arrives after the deadline", async () => {
    let release: (decision: "allow") => void = () => undefined;
    const late: MayBroadcastClient = () =>
      new Promise((resolve) => {
        release = (decision) => resolve({ decision, detail: "late" });
      });
    const res = await createNote(client, { settlement: { ...s, mayBroadcast: late, timeoutMs: 50 } });
    expect(res.error?.code).toBe(RPC_ERRORS.NOT_SUBMITTED);
    expect(res.error?.data?.observation).toMatchObject({ state: "prepared", hold: "interrupted" });
    release("allow");
    await new Promise((r) => setImmediate(r));
    expect(client.sends).toHaveLength(0);
    expect(journal.get("op-1")?.state).toBe("prepared");
  });

  it("resumes a held operation with the SAME prepared transaction once allowed", async () => {
    gate.decision = "deny";
    await createNote(client, ctx);
    const held = journal.attempts("op-1")[0]!.txHash;
    gate.decision = "allow";
    const res = await createNote(client, ctx);
    expect(res.result?.observation).toMatchObject({ state: "included", txHash: held });
    expect(client.proofs).toBe(1);
    expect(client.sends).toEqual([held]);
  });

  it.each([
    ["denied", "deny", "may_broadcast_denied"],
    ["unknown", "unknown", "may_broadcast_unknown"],
  ] as const)(
    "preserves a %s prepared attempt through a per-operation hold and recovery",
    async (_name, decision, hold) => {
      gate.decision = decision;
      await createNote(client, ctx);
      const beforeOperation = journal.get("op-1")!;
      const beforeAttempts = journal.attempts("op-1");
      const beforeBytes = journal.attemptBytes("op-1", beforeOperation.currentAttempt!);
      const beforeGeneration = journal.meta().generation;
      expect(beforeOperation).toMatchObject({
        fingerprint: fingerprintTerms(termsFrom(CreateNoteV1Schema.parse(v1Params()))),
        terms: { recipient: v1Params()["recipient"] },
        state: "prepared",
        hold,
        currentAttempt: 1,
      });

      s.readiness = readyObserver({
        ready: false,
        reasons: ["account_paused"],
        policy: {
          initialized: true,
          paused: true,
          allowlistRoot: "0x" + "c".repeat(64),
          configuredAllowlistRoot: "0x" + "c".repeat(64),
        },
      });
      const refused = await createNote(client, ctx);
      expect(refused.error?.code).toBe(RPC_ERRORS.NOT_READY);
      expect(refused.error?.data?.["reasons"]).toEqual(["account_paused"]);
      expect(refused.error?.data?.observation).toEqual({
        state: "prepared",
        txHash: beforeAttempts[0]!.txHash,
        expirationTimestamp: beforeAttempts[0]!.expirationTimestamp,
        hold,
      });
      expect(journal.meta().generation).toBe(beforeGeneration);
      expect(journal.get("op-1")).toEqual(beforeOperation);
      expect(journal.attempts("op-1")).toEqual(beforeAttempts);
      expect(journal.attemptBytes("op-1", beforeOperation.currentAttempt!)).toEqual(beforeBytes);
      expect(client.proofs).toBe(1);
      expect(client.sends).toEqual([]);

      const readWhileNotReady = await getSettlement(client, ctx);
      expect(readWhileNotReady).toMatchObject({
        fingerprint: beforeOperation.fingerprint,
        terms: { recipient: beforeOperation.terms.recipient },
        state: "prepared",
        observation: { state: "prepared", txHash: beforeAttempts[0]!.txHash, hold },
      });

      s.readiness = readyObserver();
      gate.decision = "allow";
      const recovered = await createNote(client, ctx);
      expect(recovered.result?.observation).toMatchObject({
        state: "included",
        txHash: beforeAttempts[0]!.txHash,
      });
      expect(client.proofs).toBe(1);
      expect(client.sends).toEqual([beforeAttempts[0]!.txHash]);
      expect(journal.attemptBytes("op-1", beforeOperation.currentAttempt!)).toEqual(beforeBytes);
      expect(journal.get("op-1")).toMatchObject({
        fingerprint: beforeOperation.fingerprint,
        terms: { recipient: beforeOperation.terms.recipient },
        currentAttempt: beforeOperation.currentAttempt,
      });
    },
  );

  it("preserves a prepared attempt when readiness observation reaches the request deadline", async () => {
    gate.decision = "unknown";
    await createNote(client, ctx);
    const beforeOperation = journal.get("op-1")!;
    const beforeAttempts = journal.attempts("op-1");
    const beforeBytes = journal.attemptBytes("op-1", beforeOperation.currentAttempt!);
    const beforeGeneration = journal.meta().generation;

    s.readiness = { observe: () => new Promise(() => undefined) };
    const refused = await createNote(client, { settlement: { ...s, timeoutMs: 50 } });
    expect(refused.error?.code).toBe(RPC_ERRORS.NOT_READY);
    expect(refused.error?.data?.observation).toEqual({
      state: "prepared",
      txHash: beforeAttempts[0]!.txHash,
      expirationTimestamp: beforeAttempts[0]!.expirationTimestamp,
      hold: "may_broadcast_unknown",
    });
    expect(journal.meta().generation).toBe(beforeGeneration);
    expect(journal.get("op-1")).toEqual(beforeOperation);
    expect(journal.attempts("op-1")).toEqual(beforeAttempts);
    expect(journal.attemptBytes("op-1", beforeOperation.currentAttempt!)).toEqual(beforeBytes);

    s.readiness = readyObserver();
    gate.decision = "allow";
    const recovered = await createNote(client, ctx);
    expect(recovered.result?.observation).toMatchObject({
      state: "included",
      txHash: beforeAttempts[0]!.txHash,
    });
    expect(client.proofs).toBe(1);
    expect(client.sends).toEqual([beforeAttempts[0]!.txHash]);
  });
  it("resumes a prepared attempt when readiness observation fails", async () => {
    gate.decision = "unknown";
    await createNote(client, ctx);
    const prepared = journal.attempts("op-1")[0]!;

    s.readiness = {
      observe: () => Promise.reject(new Error("readiness transport unavailable")),
    };
    gate.decision = "allow";
    const recovered = await createNote(client, ctx);

    expect(recovered.result?.observation).toMatchObject({
      state: "included",
      txHash: prepared.txHash,
    });
    expect(client.proofs).toBe(1);
    expect(client.sends).toEqual([prepared.txHash]);
  });


  it("refuses a same-id request with changed terms and does no work", async () => {
    await createNote(client, ctx);
    const res = await createNote(client, ctx, v1Params({ amount: "999" }));
    expect(res.error?.code).toBe(RPC_ERRORS.OPERATION_CONFLICT);
    expect(res.error?.data).toMatchObject({ operationId: "op-1" });
    expect(client.proofs).toBe(1);
  });

  it("answers a concurrent duplicate with -32001", async () => {
    gate.decision = "hang";
    const first = createNote(client, { settlement: { ...s, timeoutMs: 100 } });
    const second = await createNote(client, ctx);
    expect(second.error?.code).toBe(RPC_ERRORS.REQUEST_IN_FLIGHT);
    expect(second.error?.data?.observation).toEqual({ state: "request_in_flight" });
    await first;
  });

  it.each([
    ["corridor_mismatch", () => ({ corridor: { ...(v1Params()["corridor"] as object), corridorRevision: 2 } })],
    ["account_mode_mismatch", () => ({ accountMode: "standard" })],
  ])("refuses %s before preparing", async (reason, override) => {
    const res = await createNote(client, ctx, v1Params(override()));
    expect(res.error?.code).toBe(RPC_ERRORS.NOT_SUBMITTED);
    expect(res.error?.data?.observation).toMatchObject({ state: "not_submitted", reason });
    expect(client.proofs).toBe(0);
  });

  it("refuses a request for a network other than authoritative readiness", async () => {
    const projected = await readyObserver().observe();
    s.readiness = readyObserver({
      network: { ...projected.network, rollupContract: "0x" + "9".repeat(40) },
    });
    const res = await createNote(client, ctx);
    expect(res.error?.data?.observation).toMatchObject({ reason: "network_mismatch" });
    expect(client.proofs).toBe(0);
  });

  it("refuses a token other than the readiness-pinned one", async () => {
    s.readiness = readyObserver({ token: "0x" + "e".repeat(64) });
    const res = await createNote(client, ctx);
    expect(res.error?.data?.observation).toMatchObject({ reason: "token_mismatch" });
  });

  it("refuses when no may-broadcast endpoint is configured", async () => {
    s.readiness = readyObserver({
      ready: false,
      reasons: ["may_broadcast_unconfigured"],
    });
    const res = await createNote(client, { settlement: { ...s, mayBroadcast: undefined } });
    expect(res.error?.code).toBe(RPC_ERRORS.NOT_READY);
    expect(res.error?.data?.observation).toMatchObject({ reason: "may_broadcast_unconfigured" });
    expect(client.proofs).toBe(0);
  });

  it("refuses an operation past its validity bound, permanently", async () => {
    const res = await createNote(client, ctx, v1Params({ validUntil: 1 }));
    expect(res.error?.data?.observation).toEqual({
      state: "not_submitted",
      reason: "validity_bound_passed",
      retryableAfterRevalidation: false,
    });
  });

  it("frees a failed proof for a retry under the same operation", async () => {
    client.behaviour = "fail_before_gate";
    const first = await createNote(client, ctx);
    expect(first.error?.data?.observation).toMatchObject({
      state: "not_submitted",
      reason: "prepare_failed",
      retryableAfterRevalidation: true,
    });
    client.behaviour = "land";
    const second = await createNote(client, ctx);
    expect(second.result?.observation.state).toBe("included");
    expect(client.sends).toHaveLength(1);
  });

  it("counts the spend at the mark, not before, and releases a hold", async () => {
    const limits = new TransactionLimits({ maxAmount: 5000n, dailyLimit: 1500n });
    gate.decision = "deny";
    await createNote(client, { settlement: s, limits });
    expect(limits.windowStatus().committed).toBe(0n);
    expect(limits.windowStatus().reserved).toBe(0n);
    gate.decision = "allow";
    await createNote(client, { settlement: s, limits });
    expect(limits.windowStatus().committed).toBe(1000n);
    const over = await createNote(client, { settlement: s, limits }, v1Params({ operationId: "op-2" }));
    expect(over.error?.data?.observation).toMatchObject({ state: "not_submitted" });
    expect(client.sends).toHaveLength(1);
  });

  it("keeps recovering an admitted prepared attempt while new admission is closed", async () => {
    gate.decision = "deny";
    await createNote(client, ctx);
    const held = journal.attempts("op-1")[0]!.txHash;
    s.readiness = readyObserver({
      ready: false,
      reasons: ["fee_runway_insufficient", "finalized_tip_stale"],
    });

    const fresh = await createNote(client, ctx, v1Params({ operationId: "op-2" }));
    expect(fresh.error?.code).toBe(RPC_ERRORS.NOT_READY);
    expect(client.proofs).toBe(1);

    gate.decision = "allow";
    const recovered = await createNote(client, ctx);
    expect(recovered.result?.observation).toMatchObject({ state: "included", txHash: held });
    expect(client.proofs).toBe(1);
    expect(client.sends).toEqual([held]);
  });

  it("holds a resumed prepared attempt the window cannot take, never re-proving it", async () => {
    const limits = new TransactionLimits({ maxAmount: 5000n, dailyLimit: 1500n });
    gate.decision = "deny";
    await createNote(client, { settlement: s, limits });
    const held = journal.attempts("op-1")[0]!.txHash;
    gate.decision = "allow";
    await createNote(client, { settlement: s, limits }, v1Params({ operationId: "op-2" }));
    expect(limits.windowStatus().committed).toBe(1000n);

    const denied = await createNote(client, { settlement: s, limits });
    expect(denied.error?.code).toBe(RPC_ERRORS.NOT_SUBMITTED);
    expect(denied.error?.data?.observation).toMatchObject({ state: "prepared", txHash: held });
    expect(journal.get("op-1")?.state).toBe("prepared");
    expect(journal.attempts("op-1")).toHaveLength(1);
    expect(client.proofs).toBe(2);

    const nextWindow = new TransactionLimits({ maxAmount: 5000n, dailyLimit: 1500n });
    const recovered = await createNote(client, { settlement: s, limits: nextWindow });
    expect(recovered.result?.observation).toMatchObject({ state: "included", txHash: held });
    expect(client.proofs).toBe(2);
  });

  it("reports a mined revert as `reverted`, not as a failure", async () => {
    client.revert = true;
    const res = await createNote(client, ctx);
    expect(res.result?.observation).toMatchObject({ state: "reverted", executionResult: "reverted" });
  });
});

describe("ambiguity after the mark is submitted_unknown, never a retryable error", () => {
  it("keeps -32002 with the transaction hash when the response is lost", async () => {
    client.behaviour = "lose_response";
    const res = await createNote(client, ctx);
    expect(res.error?.code).toBe(RPC_ERRORS.SUBMITTED_UNKNOWN);
    expect(res.error?.message).toBe(SUBMITTED_UNKNOWN_MESSAGE);
    expect(res.error?.data?.["txHash"]).toBe(client.sends[0]);
    expect(res.error?.data?.observation).toMatchObject({
      state: "submitted_unknown",
      reason: "post_mark_failure",
    });
  });

  it("keeps -32002 when the deadline passes after the broadcast", async () => {
    client.behaviour = "hang_after_broadcast";
    const res = await createNote(client, { settlement: { ...s, timeoutMs: 50 } });
    expect(res.error?.code).toBe(RPC_ERRORS.SUBMITTED_UNKNOWN);
    expect(res.error?.data?.observation).toMatchObject({ reason: "response_deadline" });
  });

  it("keeps the first observedAt across polls and answers lookups from the committed row", async () => {
    client.behaviour = "lose_response";
    await createNote(client, ctx);
    let clock = 1_000_000;
    const timed = { settlement: { ...s, now: () => clock } };

    const first = await getSettlement(client, timed);
    expect(first.observation).toMatchObject({ state: "included", observedAt: 1_000 });
    clock = 2_000_000;
    expect(journal.get("op-1")?.observation).toMatchObject({ observedAt: 1_000 });
    expect((await getSettlement(client, timed)).observation).toMatchObject({
      state: "included",
      observedAt: 1_000,
    });

    client.finalizeAll();
    const settled = await getSettlement(client, timed);
    expect(settled.state).toBe("finalized");
    expect(settled.observation).toMatchObject({ state: "finalized" });
  });

  it("recovers a lost response through aztec_getSettlement, and a retry does not send again", async () => {
    client.behaviour = "lose_response";
    await createNote(client, ctx);
    const read = await getSettlement(client, ctx);
    expect(read).toMatchObject({
      found: true,
      state: "may_broadcast",
      observation: { state: "included", txHash: client.sends[0] },
      journal: { writable: true },
    });
    expect(read.terms).toMatchObject({ amount: "1000", recipient: v1Params()["recipient"] });
    client.behaviour = "land";
    const retry = await createNote(client, ctx);
    expect(retry.result?.observation.state).toBe("included");
    expect(client.sends).toHaveLength(1);
    expect(client.credits()).toBe(1);
  });

  it("never replays when the process died between mark and send", async () => {
    client.behaviour = "die_after_mark";
    const first = await createNote(client, ctx);
    expect(first.error?.code).toBe(RPC_ERRORS.SUBMITTED_UNKNOWN);
    expect(client.sends).toHaveLength(0);
    const marked = journal.attempts("op-1")[0]!.txHash;
    s.readiness = readyObserver({
      ready: false,
      reasons: ["finalized_history_unavailable"],
    });
    expect((await getSettlement(client, ctx)).observation).toMatchObject({
      state: "submitted_unknown",
      txHash: marked,
      reason: "node_reports_dropped_or_unknown",
    });
    client.behaviour = "land";
    const retry = await createNote(client, ctx);
    expect(retry.error?.code).toBe(RPC_ERRORS.SUBMITTED_UNKNOWN);
    expect(retry.error?.data?.observation).toMatchObject({
      state: "submitted_unknown",
      txHash: marked,
      reason: "node_reports_dropped_or_unknown",
    });
    expect(client.sends).toHaveLength(0);
    expect(client.proofs).toBe(1);
    expect(client.credits()).toBe(0);
    expect(gate.calls).toEqual(["op-1"]);
  });

  it("keeps a marked attempt ambiguous past validUntil without replay", async () => {
    client.behaviour = "die_after_mark";
    await createNote(client, ctx);
    const marked = journal.attempts("op-1")[0]!.txHash;
    client.behaviour = "land";
    // Past the operation's own bound, still inside the protocol expiry.
    const late = { settlement: { ...s, now: () => (VALID_UNTIL + 1) * 1000 } };
    expect(BigInt(VALID_UNTIL + 1)).toBeLessThan(client.expiration);
    const retry = await createNote(client, late);
    expect(retry.error?.code).toBe(RPC_ERRORS.SUBMITTED_UNKNOWN);
    expect(retry.error?.data?.observation).toMatchObject({
      state: "submitted_unknown",
      txHash: marked,
      reason: "node_reports_dropped_or_unknown",
    });
    expect(client.sends).toHaveLength(0);
    expect(journal.get("op-1")?.state).toBe("may_broadcast");
    expect((await getSettlement(client, late)).observation.state).toBe("submitted_unknown");
  });

  it("keeps marked observation available when journal writes are lost", async () => {
    const path = tempJournalPath();
    const first = openBoundJournal(path);
    client.behaviour = "die_after_mark";
    await createNote(client, { settlement: settlementContext(first, gate.client) });
    first.close();
    const db = new Database(path);
    db.exec("DELETE FROM spends");
    db.close();

    const reopened = SettlementJournal.open(path);
    reopened.bindAccount(client.getAddress()!, false);
    expect(reopened.health()).toMatchObject({ writable: false, reason: "journal_inconsistent" });
    client.behaviour = "land";
    const retry = await createNote(client, { settlement: settlementContext(reopened, gate.client) });
    expect(retry.error?.code).toBe(RPC_ERRORS.SUBMITTED_UNKNOWN);
    expect(retry.error?.data?.observation).toMatchObject({
      state: "submitted_unknown",
      reason: "node_reports_dropped_or_unknown",
    });
    expect(client.sends).toHaveLength(0);
    expect(client.proofs).toBe(1);
  });

  it("survives a restart: a reopened journal answers and the retry sends nothing", async () => {
    const path = tempJournalPath();
    const first = openBoundJournal(path);
    client.behaviour = "lose_response";
    await createNote(client, { settlement: settlementContext(first, gate.client) });
    first.close();

    const reopened = SettlementJournal.open(path);
    reopened.bindAccount(client.getAddress()!, true);
    expect(reopened.health()).toEqual({ writable: true });
    const after = { settlement: settlementContext(reopened, gate.client) };
    client.behaviour = "land";
    const retry = await createNote(client, after);
    expect(retry.result?.observation.state).toBe("included");
    expect(client.sends).toHaveLength(1);
    expect(client.credits()).toBe(1);
  });
});

describe("the gate is the last word on both bounds", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  let clock: number;
  let timed: SettlementContext;
  let asked: number;

  beforeEach(() => {
    clock = Date.now();
    asked = 0;
    timed = { ...s, now: () => clock };
  });

  /** Allows, but only after the clock has moved to `toMs` during the wait. */
  const allowAt = (toMs: () => number): MayBroadcastClient => async (query) => {
    asked += 1;
    clock = toMs();
    return gate.client(query);
  };

  it("refuses to mark when validUntil passes during the may-broadcast wait", async () => {
    const res = await createNote(client, {
      settlement: { ...timed, mayBroadcast: allowAt(() => (VALID_UNTIL + 1) * 1000) },
    });
    expect(res.error?.data?.observation).toEqual({
      state: "not_submitted",
      reason: "validity_bound_passed",
      retryableAfterRevalidation: false,
    });
    expect(client.sends).toHaveLength(0);
    expect(journal.attempts("op-1")[0]?.mayBroadcastAt).toBeNull();
    expect(journal.spendsSince(0)).toEqual([]);
  });

  it("makes a post-allow expiration terminal for the operation: Riddler has bound that hash", async () => {
    const riddler = bindingMayBroadcast();
    const bound = { ...timed, mayBroadcast: riddler.client };
    client.expiration = BigInt(nowSec() + 100);
    const first = await createNote(client, {
      settlement: {
        ...bound,
        mayBroadcast: async (query) => {
          const answer = await riddler.client(query);
          clock = (nowSec() + 200) * 1000;
          return answer;
        },
      },
    });
    expect(first.error?.data?.observation).toEqual({
      state: "not_submitted",
      reason: "expired_after_allow",
      retryableAfterRevalidation: false,
    });
    expect(riddler.answers).toEqual(["allow"]);
    expect(client.sends).toHaveLength(0);
    expect(journal.spendsSince(0)).toEqual([]);

    // A retry of the same operation proves nothing: a fresh proof would carry
    // a new hash, which the binding denies forever.
    client.expiration = BigInt(nowSec() + 86_400);
    const retry = await createNote(client, { settlement: bound });
    expect(retry.error?.data?.observation).toMatchObject({
      state: "not_submitted",
      reason: "expired_after_allow",
      retryableAfterRevalidation: false,
    });
    expect(client.proofs).toBe(1);
    expect(riddler.answers).toEqual(["allow"]);

    // Which is what it would do: a new hash for the same operation is denied.
    const stale = journal.attempts("op-1")[0]!.txHash;
    const fresh = "0x" + "e".repeat(64);
    expect(fresh).not.toBe(stale);
    const fingerprint = journal.get("op-1")!.fingerprint;
    expect((await riddler.client({ operationId: "op-1", fingerprint, txHash: fresh })).decision).toBe("deny");

    // The remedy is a requote under a NEW operation id.
    const requoted = await createNote(client, { settlement: bound }, v1Params({ operationId: "op-2" }));
    expect(requoted.result?.observation.state).toBe("included");
    expect(client.sends).toHaveLength(1);
  });

  it.each([
    ["validUntil", "validity_bound_passed", () => (VALID_UNTIL + 1) * 1000],
    ["the protocol expiration", "expiration_passed", () => (nowSec() + 200) * 1000],
  ] as const)("does not send when %s passes inside the mark: submitted_unknown, never not_submitted", async (
    _bound,
    reason,
    toMs,
  ) => {
    client.expiration = BigInt(nowSec() + 100);
    const mark = journal.markMayBroadcast.bind(journal);
    journal.markMayBroadcast = (...args) => {
      mark(...args);
      clock = toMs(); // the fsync crossed the bound
    };
    const res = await createNote(client, { settlement: timed });
    expect(res.error?.code).toBe(RPC_ERRORS.SUBMITTED_UNKNOWN);
    expect(res.error?.data?.observation).toMatchObject({ state: "submitted_unknown", reason });
    expect(client.sends).toHaveLength(0);
    expect(journal.get("op-1")?.state).toBe("may_broadcast");
    expect(journal.spendsSince(0)).toHaveLength(1);
  });


  it.each([
    ["validUntil", "validity_bound_passed", false, () => (VALID_UNTIL + 1) * 1000],
    ["the protocol expiration", "expiration_passed", true, () => (nowSec() + 200) * 1000],
  ] as const)(
    "does not ask again for a held attempt when %s passes while its bytes are reconstructed",
    async (_bound, reason, retryable, toMs) => {
      client.expiration = BigInt(nowSec() + 100);
      gate.decision = "deny";
      await createNote(client, { settlement: timed });
      gate.decision = "allow";
      const before = gate.calls.length;
      client.beforeGate = () => {
        clock = toMs();
      };
      const res = await createNote(client, { settlement: timed });
      expect(res.error?.data?.observation).toEqual({
        state: "not_submitted",
        reason,
        retryableAfterRevalidation: retryable,
      });
      expect(gate.calls.length).toBe(before);
      expect(client.sends).toHaveLength(0);
      expect(asked).toBe(0);
    },
  );
});

describe("one deadline for the whole request", () => {
  it("counts the cooldown against it: a cooldown past the deadline proves nothing", async () => {
    const limits = new TransactionLimits({
      maxAmount: 1000n,
      dailyLimit: 10_000n,
      cooldownThreshold: 1n,
      cooldownDelayMs: 300,
    });
    const res = await createNote(client, { settlement: { ...s, timeoutMs: 50 }, limits });
    expect(res.error?.data?.observation).toEqual({
      state: "not_submitted",
      reason: "response_deadline",
      retryableAfterRevalidation: true,
    });
    expect(client.proofs).toBe(0);
    expect(limits.windowStatus().reserved).toBe(0n);
    // Nothing was started, so nothing can finish after the cooldown either.
    expect(client.sends).toHaveLength(0);
    expect(gate.calls).toEqual([]);
  });

  it("counts readiness observation against the request deadline", async () => {
    s.readiness = { observe: () => new Promise(() => undefined) };
    const res = await createNote(client, { settlement: { ...s, timeoutMs: 50 } });
    expect(res.error?.data?.observation).toMatchObject({
      state: "not_submitted",
      reason: "response_deadline",
    });
    expect(client.proofs).toBe(0);
  });

  it("closes the gate when the HTTP deadline aborts, so a later allow cannot mark", async () => {
    let release: (decision: "allow") => void = () => undefined;
    let asked: () => void = () => undefined;
    const askedOnce = new Promise<void>((r) => (asked = r));
    const late: MayBroadcastClient = () => {
      asked();
      return new Promise((resolve) => {
        release = (decision) => resolve({ decision, detail: "late" });
      });
    };
    const http = new AbortController();
    const pending = createNote(client, {
      settlement: { ...s, mayBroadcast: late, timeoutMs: 60_000 },
      signal: http.signal,
    });
    await askedOnce;
    http.abort();
    const res = await pending;
    expect(res.error?.data?.observation).toMatchObject({ state: "prepared", hold: "interrupted" });
    release("allow");
    await new Promise((r) => setImmediate(r));
    expect(client.sends).toHaveLength(0);
    expect(journal.get("op-1")?.state).toBe("prepared");
    expect(journal.spendsSince(0)).toEqual([]);
  });

  it("starts nothing when the HTTP deadline has already passed", async () => {
    const http = new AbortController();
    http.abort();
    const res = await createNote(client, { settlement: s, signal: http.signal });
    expect(res.error?.data?.observation).toMatchObject({ state: "not_submitted", reason: "response_deadline" });
    expect(client.proofs).toBe(0);
    expect(gate.calls).toEqual([]);
  });
});

describe("aztec_getSettlement", () => {
  it("answers unknown, never 'safe', for an operation it does not hold", async () => {
    const read = await getSettlement(client, ctx, "nobody");
    expect(read).toEqual({
      version: SETTLEMENT_VERSION,
      operationId: "nobody",
      found: false,
      observation: { state: "unknown", reason: "operation_not_journaled" },
      journal: { writable: true },
    });
  });

  it("records a finalized outcome durably and serves it without the node", async () => {
    await createNote(client, ctx);
    client.finalizeAll();
    expect((await getSettlement(client, ctx)).observation.state).toBe("finalized");
    expect(journal.get("op-1")?.state).toBe("finalized");
    client.observeError = new Error("node down");
    const read = await getSettlement(client, ctx);
    expect(read.observation).toMatchObject({ state: "finalized", receiptStatus: "finalized" });
  });

  it("reports a node that cannot be read as submitted_unknown", async () => {
    await createNote(client, ctx);
    client.observeError = new Error("node down");
    expect((await getSettlement(client, ctx)).observation).toMatchObject({
      state: "submitted_unknown",
      reason: "node_read_failed",
    });
  });

  it("lists every attempt, and which one may have broadcast", async () => {
    gate.decision = "deny";
    await createNote(client, ctx);
    const read = await getSettlement(client, ctx);
    expect(read.attempts).toEqual([
      expect.objectContaining({ attempt: 1, mayBroadcast: false }),
    ]);
    expect(read.observation).toMatchObject({ state: "prepared", hold: "may_broadcast_denied" });
  });

  it("keeps serving settlement reads while a malformed high-water mark halts writes", async () => {
    await createNote(client, ctx);
    const path = journal.path;
    journal.close();
    writeFileSync(`${path}.hwm`, "null");
    const reopened = SettlementJournal.open(path);
    expect(reopened.health()).toMatchObject({ writable: false, reason: "rollback_detected" });
    const readOnly = { settlement: settlementContext(reopened, gate.client) };
    const write = await createNote(client, readOnly, v1Params({ operationId: "op-2" }));
    expect(write.error?.code).toBe(RPC_ERRORS.JOURNAL_UNAVAILABLE);
    expect(write.error?.data).toMatchObject({ journal: { writable: false, reason: "rollback_detected" } });
    const read = await getSettlement(client, readOnly);
    expect(read).toMatchObject({
      found: true,
      observation: { state: "included" },
      journal: { writable: false, reason: "rollback_detected" },
    });
  });
});
