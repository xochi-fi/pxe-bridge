import { describe, expect, it } from "vitest";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import type { MayBroadcastClient, MayBroadcastQuery } from "../src/may-broadcast.js";
import { OxideJournal } from "../src/oxide/journal.js";
import { oxideSiloedNoteHash, oxideUniqueNoteHash } from "../src/oxide/payout-proof.js";
import { OXIDE_V6_MAINNET } from "../src/oxide/pins.js";
import { OxideSender } from "../src/oxide/sender.js";
import { handleRpcRequest, type SettlementContext } from "../src/rpc.js";
import { CreateNoteSchema, SETTLEMENT_VERSION, fingerprintTerms, termsFrom } from "../src/settlement.js";
import type { JsonRpcResponse } from "../src/types.js";
import {
  CAPS,
  clock,
  fakeAdmission,
  FakeBackend,
  fakeGate,
  FakeNode,
  noPreflight,
  OXIDE_NETWORK,
  oxideParams,
  PAYOUT_NOTE_HASH_INDEX,
  settle,
  tempJournalPath,
} from "./oxide-fixtures.js";
import { FakeAztecClient, openBoundJournal, rpcBody, settlementContext, settlementParams } from "./settlement-fixtures.js";

/**
 * `aztec_createNote` / `aztec_getSettlement` with `sendMode: "oxide"` through
 * the JSON-RPC layer (pxe-bridge#84): the Oxide sender on a real Oxide
 * journal, a fake node that publishes the payout's real unique note hash, and
 * the v2 wire answer.
 */

/** A may-broadcast answer the test releases, to act while the gate is pending. */
function heldGate() {
  const queries: MayBroadcastQuery[] = [];
  let release!: (decision: "allow" | "deny" | "unknown") => void;
  const decided = new Promise<"allow" | "deny" | "unknown">((resolve) => (release = resolve));
  const client: MayBroadcastClient = async (query) => {
    queries.push(query);
    return { decision: await decided, detail: "test" };
  };
  return { client, queries, release: (decision: "allow" | "deny" | "unknown") => release(decision) };
}

interface BridgeOptions {
  path?: string;
  node?: FakeNode;
  gate?: { client: MayBroadcastClient };
  admission?: ReturnType<typeof fakeAdmission>;
  timeoutMs?: number;
  preflight?: { assertPinned(): Promise<void> };
}

/** One Oxide-mode bridge process: Oxide journal, sender, settlement context and a node client. */
function bridge(options: BridgeOptions = {}) {
  const path = options.path ?? tempJournalPath();
  const node = options.node ?? new FakeNode();
  const c = clock();
  const journal = OxideJournal.open(path, { now: c.now });
  const backend = new FakeBackend(node);
  const gate = options.gate ?? fakeGate();
  const admission = options.admission ?? fakeAdmission();
  const sender = new OxideSender({
    journal,
    backend,
    caps: CAPS,
    preflight: options.preflight ?? noPreflight,
    admission: admission.admission,
    mayBroadcast: gate.client,
    now: c.now,
  });
  const settlementJournal = openBoundJournal();
  const s: SettlementContext = settlementContext(settlementJournal, gate.client, {
    oxide: sender,
    readiness: undefined,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  const client = new FakeAztecClient();
  client.mode = "standard";
  client.network = { ...OXIDE_NETWORK };
  const createNote = (params: Record<string, unknown>, signal?: AbortSignal) =>
    handleRpcRequest(rpcBody("aztec_createNote", [params]), client, {
      settlement: s,
      idempotencyKey: String(params["operationId"]),
      ...(signal ? { signal } : {}),
    });
  const getSettlement = (operationId: string) =>
    handleRpcRequest(rpcBody("aztec_getSettlement", [{ version: SETTLEMENT_VERSION, operationId }]), client, {
      settlement: s,
    });
  return { journal, backend, sender, node, s, client, settlementJournal, admission, createNote, getSettlement };
}

type Mined = {
  state: string;
  txHash: string;
  partialNoteRandomness: string | null;
  payoutNoteHashIndex?: number | null;
  effects: { noteHashes: string[]; nullifiers: string[] };
};

function result(response: JsonRpcResponse): { fingerprint: string; observation: Mined } {
  if (!("result" in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  return response.result as { fingerprint: string; observation: Mined };
}

function error(response: JsonRpcResponse): { code: number; data: Record<string, unknown> } {
  if (!("error" in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  return response.error as { code: number; data: Record<string, unknown> };
}

const fingerprintOf = (params: Record<string, unknown>) => fingerprintTerms(termsFrom(CreateNoteSchema.parse(params)));

/** What a consumer checks: the note recomputed from the signed terms is the published note hash at the index. */
async function provesPayout(observation: Mined, params: Record<string, unknown>): Promise<boolean> {
  const index = observation.payoutNoteHashIndex;
  if (typeof index !== "number" || observation.partialNoteRandomness === null) return false;
  const siloed = await oxideSiloedNoteHash({
    recipient: String(params["recipient"]),
    token: String(params["token"]),
    amount: BigInt(String(params["amount"])),
    randomness: observation.partialNoteRandomness,
  });
  const unique = await oxideUniqueNoteHash(siloed, Fr.fromString(observation.effects.nullifiers[0]!), index);
  return unique.toString() === observation.effects.noteHashes[index];
}

describe("aztec_createNote with sendMode oxide", () => {
  it("pays once and answers the v2 observation with the payout's note hash index", async () => {
    const gate = fakeGate();
    const b = bridge({ gate });
    const params = oxideParams();
    const fingerprint = fingerprintOf(params);

    const first = result(await b.createNote(params));
    expect(first.fingerprint).toBe(fingerprint);
    expect(first.observation).toMatchObject({ state: "finalized", payoutNoteHashIndex: PAYOUT_NOTE_HASH_INDEX });
    const evidence = b.journal.attemptEvidence("op-1", 1);
    expect(first.observation.partialNoteRandomness).toBe(evidence.createdNotes[evidence.recipientNoteIndex]!.randomness);
    expect(await provesPayout(first.observation, params)).toBe(true);
    expect(await provesPayout(first.observation, { ...params, amount: "1" })).toBe(false);

    // The v2 fingerprint is what may-broadcast is asked about and what the transfer carries.
    expect(gate.queries).toEqual([{ operationId: "op-1", fingerprint, txHash: first.observation.txHash }]);
    expect(b.backend.simulated.map((p) => p.orderFingerprint)).toEqual([fingerprint]);

    const again = result(await b.createNote(params));
    expect(again).toEqual(first);
    expect(b.node.sent).toHaveLength(1);
  });

  it("answers aztec_getSettlement for the oxide operation from the Oxide journal", async () => {
    const b = bridge();
    const params = oxideParams();
    const paid = result(await b.createNote(params));
    const response = await b.getSettlement("op-1");
    if (!("result" in response)) throw new Error(JSON.stringify(response));
    expect(response.result).toMatchObject({
      version: SETTLEMENT_VERSION,
      found: true,
      fingerprint: paid.fingerprint,
      terms: { sendMode: "oxide", accountMode: "standard", token: OXIDE_V6_MAINNET.bridge.l2Token },
      state: "finalized",
      attempts: [{ attempt: 1, txHash: paid.observation.txHash, mayBroadcast: true }],
      observation: paid.observation,
      journal: { writable: true },
    });
  });

  it("carries payoutNoteHashIndex null on a reverted payout whose note the effects do not carry", async () => {
    const node = new FakeNode();
    node.executionResult = "reverted";
    node.payoutNoteHash = "absent";
    const b = bridge({ node });
    const out = result(await b.createNote(oxideParams()));
    expect(out.observation).toMatchObject({ state: "reverted", payoutNoteHashIndex: null });
    expect(out.observation.partialNoteRandomness).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // Fund safety (review M1): a "revert" whose effects still carry the payout
  // note is a contradiction, never a clean revert a consumer could refund on.
  for (const shown of ["published", "duplicated", "unavailable"] as const) {
    it(`answers unknown for a reverted payout whose note is ${shown} in the effects`, async () => {
      const node = new FakeNode();
      node.executionResult = "reverted";
      node.payoutNoteHash = shown;
      const b = bridge({ node });
      expect(error(await b.createNote(oxideParams())).data["observation"]).toEqual({
        state: "unknown",
        reason: "payout_note_hash_unresolved",
      });
      expect(b.node.sent).toHaveLength(1);
    });
  }

  // Review F6: a deployment check that cannot pass (zk.money CDN, L1 or portal
  // down) refuses new sends but never recovery reads or held resends.
  it("serves recovery while the Oxide pins cannot be verified", async () => {
    const path = tempJournalPath();
    const node = new FakeNode();
    const first = bridge({ path, node, gate: fakeGate("unknown") });
    expect(error(await first.createNote(oxideParams())).data["observation"]).toMatchObject({
      state: "prepared",
      hold: "may_broadcast_unknown",
    });
    first.journal.close();

    const down = { assertPinned: () => Promise.reject(new Error("profile CDN unreachable")) };
    const second = bridge({ path, node, preflight: down });
    const read = await second.getSettlement("op-1");
    if (!("result" in read)) throw new Error(JSON.stringify(read));
    expect(read.result).toMatchObject({ found: true, state: "prepared", observation: { state: "prepared" } });
    expect(error(await second.createNote(oxideParams())).data["observation"]).toMatchObject({
      state: "prepared",
      hold: "interrupted",
    });
    expect(error(await second.createNote(oxideParams({ operationId: "op-2" }))).data["observation"]).toMatchObject({
      state: "not_submitted",
      reason: "oxide_pin_unverified",
      retryableAfterRevalidation: true,
    });
    expect(node.sent).toEqual([]);
  });

  // Fund safety: a mined observation the consumer could not prove is never
  // answered; the payout is held (unknown), never resent, never refundable.
  for (const shown of ["absent", "duplicated"] as const) {
    it(`holds the payout as unknown when its note hash is ${shown} in the mined effects`, async () => {
      const node = new FakeNode();
      node.payoutNoteHash = shown;
      const b = bridge({ node });
      const answer = error(await b.createNote(oxideParams()));
      expect(answer.code).toBe(-32002);
      expect(answer.data["observation"]).toEqual({ state: "unknown", reason: "payout_note_hash_unresolved" });
      const read = await b.getSettlement("op-1");
      if (!("result" in read)) throw new Error(JSON.stringify(read));
      expect(read.result).toMatchObject({
        state: "finalized",
        observation: { state: "unknown", reason: "payout_note_hash_unresolved" },
      });
      expect(error(await b.createNote(oxideParams())).data["observation"]).toMatchObject({ state: "unknown" });
      expect(b.node.sent).toHaveLength(1);
    });
  }

  it("holds the payout while its effects are unavailable and proves it once the node serves them", async () => {
    const node = new FakeNode();
    node.payoutNoteHash = "unavailable";
    const b = bridge({ node });
    expect(error(await b.createNote(oxideParams())).data["observation"]).toEqual({
      state: "unknown",
      reason: "payout_note_hash_unresolved",
    });
    expect(b.journal.get("op-1")?.state).toBe("may_broadcast");
    node.payoutNoteHash = "published";
    expect(result(await b.createNote(oxideParams())).observation).toMatchObject({
      state: "finalized",
      payoutNoteHashIndex: PAYOUT_NOTE_HASH_INDEX,
    });
    expect(b.node.sent).toHaveLength(1);
  });

  it("refuses, before anything is claimed, every send mode or token this bridge does not serve", async () => {
    const b = bridge();
    const cases: [Record<string, unknown>, string | undefined][] = [
      [settlementParams({ operationId: "op-1" }), "send_mode_unsupported"],
      [oxideParams({ sendMode: "design_a" }), undefined],
      [oxideParams({ sendMode: undefined }), undefined],
      [oxideParams({ accountMode: "spending_limit" }), undefined],
      [oxideParams({ token: "0x" + "0".repeat(63) + "5" }), "token_mismatch"],
    ];
    for (const [params, reason] of cases) {
      if (params["sendMode"] === undefined) delete params["sendMode"];
      const answer = error(await b.createNote(params));
      expect(answer.code).toBe(-32602);
      if (reason) expect(answer.data["reason"]).toBe(reason);
    }
    expect(b.journal.get("op-1")).toBeUndefined();
    expect(b.settlementJournal.get("op-1")).toBeUndefined();
    expect(b.backend.calls).toEqual([]);
  });

  it("refuses sendMode oxide on a spending_limit bridge", async () => {
    const journal = openBoundJournal();
    const s = settlementContext(journal);
    const client = new FakeAztecClient();
    const params = oxideParams();
    const answer = error(
      await handleRpcRequest(rpcBody("aztec_createNote", [params]), client, { settlement: s, idempotencyKey: "op-1" }),
    );
    expect(answer).toMatchObject({ code: -32602, data: { reason: "send_mode_unsupported", served: "spending_limit" } });
    expect(journal.get("op-1")).toBeUndefined();
  });

  it("is a conflict to reuse an operation id with other v2 terms, in either journal", async () => {
    const b = bridge();
    const params = oxideParams();
    await b.createNote(params);
    const other = oxideParams({ amount: "1000000000000000000" });
    expect(error(await b.createNote(other))).toMatchObject({
      code: -32003,
      data: { fingerprint: fingerprintOf(other), storedFingerprint: fingerprintOf(params) },
    });

    const spending = termsFrom(CreateNoteSchema.parse(settlementParams({ operationId: "op-2" })));
    b.settlementJournal.claim("op-2", fingerprintTerms(spending), spending);
    expect(error(await b.createNote(oxideParams({ operationId: "op-2" })))).toMatchObject({
      code: -32003,
      data: { storedFingerprint: fingerprintTerms(spending) },
    });
    expect(b.journal.get("op-2")).toBeUndefined();
    expect(b.node.sent).toHaveLength(1);
  });

  it("journals terms this bridge cannot serve as not_submitted, with the spending_limit reasons", async () => {
    const b = bridge();
    const corridor = error(
      await b.createNote(oxideParams({ corridor: { ...(oxideParams()["corridor"] as object), corridorRevision: 9 } })),
    );
    expect(corridor).toMatchObject({
      code: -32005,
      data: { observation: { state: "not_submitted", reason: "corridor_mismatch", retryableAfterRevalidation: true } },
    });
    b.client.network = { ...OXIDE_NETWORK, protocolVersion: "1" };
    const network = error(await b.createNote(oxideParams({ operationId: "op-2" })));
    expect(network.data["observation"]).toMatchObject({ reason: "network_mismatch" });
    expect(b.backend.calls).toEqual([]);
    expect(b.admission.asked).toEqual([]);
  });

  it("answers the admission verdict: not ready (-32006) or refused (-32005), never simulating", async () => {
    const admission = fakeAdmission({ kind: "not_ready", reasons: ["private_balance_insufficient"] });
    const b = bridge({ admission });
    expect(error(await b.createNote(oxideParams()))).toMatchObject({
      code: -32006,
      data: {
        reason: "bridge_not_ready",
        reasons: ["private_balance_insufficient"],
        observation: { state: "not_submitted", reason: "private_balance_insufficient", retryableAfterRevalidation: true },
      },
    });
    admission.state.verdict = { kind: "refused", reason: "recipient_not_allowlisted", retryable: false };
    expect(error(await b.createNote(oxideParams()))).toMatchObject({
      code: -32005,
      data: { observation: { state: "not_submitted", reason: "recipient_not_allowlisted", retryableAfterRevalidation: false } },
    });
    // Permanent: the journaled refusal answers every retry, admission is not asked again.
    expect(error(await b.createNote(oxideParams())).data["observation"]).toMatchObject({ reason: "recipient_not_allowlisted" });
    expect(admission.asked).toHaveLength(2);
    expect(b.backend.calls).toEqual([]);
  });

  // OX-6: a process that dies after journaling the proven transaction and
  // before the mark resends exactly those bytes once, never a second payout.
  it("resumes an interrupted send from the journal without paying twice", async () => {
    const path = tempJournalPath();
    const node = new FakeNode();
    const first = bridge({ path, node, gate: fakeGate("hang"), timeoutMs: 200 });
    expect(error(await first.createNote(oxideParams()))).toMatchObject({
      code: -32001,
      data: { observation: { state: "request_in_flight" } },
    });
    expect(first.journal.get("op-1")?.state).toBe("prepared");
    const [attempt] = first.journal.attempts("op-1");
    const bytes = first.journal.attemptBytes("op-1", 1);
    first.journal.close(); // the process died

    const second = bridge({ path, node });
    const out = result(await second.createNote(oxideParams()));
    expect(out.observation).toMatchObject({ state: "finalized", txHash: attempt!.txHash });
    expect(second.backend.calls).toEqual(["send"]);
    expect(node.sent).toEqual([attempt!.txHash]);
    expect(node.sentBytes).toEqual([bytes]);
    expect(second.admission.asked).toEqual([]);
  });

  // The response deadline closes the gate: an allow that arrives after the
  // caller was answered never marks; the retry resends the same bytes.
  it("never marks after the request deadline answered the caller", async () => {
    const gate = heldGate();
    const node = new FakeNode();
    const b = bridge({ node, gate, timeoutMs: 200 });
    expect(error(await b.createNote(oxideParams())).data["observation"]).toEqual({ state: "request_in_flight" });
    gate.release("allow");
    await settle();
    expect(b.journal.get("op-1")).toMatchObject({ state: "prepared", hold: "interrupted" });
    expect(node.sent).toEqual([]);
    const held = await b.getSettlement("op-1");
    if (!("result" in held)) throw new Error(JSON.stringify(held));
    expect(held.result).toMatchObject({ state: "prepared", observation: { state: "prepared", hold: "interrupted" } });

    const retried = result(await b.createNote(oxideParams()));
    expect(retried.observation).toMatchObject({ state: "finalized", txHash: gate.queries[0]!.txHash });
    expect(node.sent).toHaveLength(1);
  });
});
