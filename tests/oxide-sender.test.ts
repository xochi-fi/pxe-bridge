import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { DAI, type OxideCapsConfig } from "../src/oxide/caps.js";
import { OxideJournal } from "../src/oxide/journal.js";
import { OxideSender, payoutNoteIndex, UnexpectedTokenOperation, type OxideSendOutcome } from "../src/oxide/sender.js";
import { OxidePinMismatch } from "../src/oxide/pins.js";
import { EnclaveTrustRefused } from "../src/oxide/enclave.js";
import {
  CAPS,
  clock,
  FakeBackend,
  fakeGate,
  FakeNode,
  noPreflight,
  RECIPIENT,
  request,
  SENDER,
  T0,
  tempJournalPath,
  noteNullifier,
  txBytesFor,
  type Step,
} from "./oxide-fixtures.js";

/** One process: a journal on `path`, a backend on the shared node, a gate. */
function boot(
  path: string,
  node: FakeNode,
  options: { gate?: ReturnType<typeof fakeGate>; caps?: OxideCapsConfig; c?: ReturnType<typeof clock>; preflight?: { assertPinned(): Promise<void> } } = {},
) {
  const c = options.c ?? clock();
  const journal = OxideJournal.open(path, { now: c.now });
  const backend = new FakeBackend(node);
  const gate = options.gate ?? fakeGate();
  const sender = new OxideSender({
    journal,
    backend,
    caps: options.caps ?? CAPS,
    preflight: options.preflight ?? noPreflight,
    mayBroadcast: gate.client,
    now: c.now,
  });
  return { journal, backend, sender, gate, c };
}

function observed(outcome: OxideSendOutcome) {
  if (outcome.kind !== "observed") throw new Error(`expected an observation, got ${outcome.kind}`);
  return outcome;
}

/** Lets a step that will never settle get there. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("OxideSender", () => {
  it("pays once and answers the payout identity the v2 rail needs", async () => {
    const node = new FakeNode();
    const { sender, backend } = boot(tempJournalPath(), node);
    const out = observed(await sender.send(request()));
    expect(out.observation.state).toBe("finalized");
    expect(backend.calls).toEqual(["simulate", "sign", "prove", "send"]);
    expect(node.sent).toHaveLength(1);
    expect(out.payout).toMatchObject({ txHash: node.sent[0], noteIndex: 1 });
    expect(out.payout?.noteRandomness).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.payout?.expirationTimestamp).toBe(backend.expiration.toString());

    // A repeat answers from the journal and the node; nothing is proven or sent again.
    const again = observed(await sender.send(request()));
    expect(again.observation.state).toBe("finalized");
    expect(again.payout).toEqual(out.payout);
    expect(node.sent).toHaveLength(1);
    expect(backend.calls).toHaveLength(4);
  });

  it("refuses the same operation id with other terms", async () => {
    const { sender } = boot(tempJournalPath(), new FakeNode());
    await sender.send(request());
    const out = await sender.send(request({ amount: (101n * DAI).toString() }));
    expect(out.kind).toBe("conflict");
  });

  describe("a crash at each step never pays twice", () => {
    for (const step of ["simulate", "sign", "prove"] as Step[]) {
      it(`before the journal: crash at ${step} re-runs the pipeline and sends once`, async () => {
        const path = tempJournalPath();
        const node = new FakeNode();
        const first = boot(path, node);
        first.backend.crashAt = step;
        void first.sender.send(request());
        await settle();
        expect(first.backend.calls.at(-1)).toBe(step);
        expect(first.journal.get("op-1")?.state).toBe("claimed");
        first.journal.close(); // the process died

        const second = boot(path, node);
        const out = observed(await second.sender.send(request()));
        expect(out.observation.state).toBe("finalized");
        expect(second.backend.calls).toEqual(["simulate", "sign", "prove", "send"]);
        expect(node.sent).toHaveLength(1);
      });
    }

    it("after the journal, before the mark: resends the exact journaled bytes once", async () => {
      const path = tempJournalPath();
      const node = new FakeNode();
      const first = boot(path, node, { gate: fakeGate("hang") });
      void first.sender.send(request());
      await settle();
      expect(first.journal.get("op-1")?.state).toBe("prepared");
      const [attempt] = first.journal.attempts("op-1");
      const bytes = first.journal.attemptBytes("op-1", 1);
      first.journal.close();

      const second = boot(path, node);
      const out = observed(await second.sender.send(request()));
      expect(out.observation.state).toBe("finalized");
      expect(second.backend.calls).toEqual(["send"]); // never re-simulated, re-signed or re-proven
      expect(node.sent).toEqual([attempt!.txHash]);
      expect(node.sentBytes[0]).toEqual(bytes);
      expect(second.gate.queries).toEqual([{ operationId: "op-1", fingerprint: out.fingerprint, txHash: attempt!.txHash }]);
    });

    it("after the mark, before the node saw it: never resent, held as submitted_unknown", async () => {
      const path = tempJournalPath();
      const node = new FakeNode();
      const first = boot(path, node);
      first.backend.crashAt = "send";
      first.backend.crashBeforeNode = true;
      void first.sender.send(request());
      await settle();
      expect(first.journal.get("op-1")?.state).toBe("may_broadcast");
      first.journal.close();

      const second = boot(path, node);
      const out = observed(await second.sender.send(request()));
      expect(out.observation).toMatchObject({ state: "submitted_unknown", reason: "node_reports_dropped_or_unknown" });
      expect(second.backend.calls).toEqual([]);
      expect(node.sent).toHaveLength(0);
    });

    it("after the send: observes only", async () => {
      const path = tempJournalPath();
      const node = new FakeNode();
      const first = boot(path, node);
      first.backend.crashAt = "send";
      void first.sender.send(request());
      await settle();
      expect(node.sent).toHaveLength(1);
      first.journal.close();

      const second = boot(path, node);
      const out = observed(await second.sender.send(request()));
      expect(out.observation.state).toBe("finalized");
      expect(second.backend.calls).toEqual([]);
      expect(node.sent).toHaveLength(1);
    });

    it("a failed send after the mark is held, and the retry does not resend", async () => {
      const node = new FakeNode();
      const { sender, backend } = boot(tempJournalPath(), node);
      backend.throwAt = "send";
      const out = observed(await sender.send(request()));
      expect(out.observation).toMatchObject({ state: "submitted_unknown", reason: "post_mark_failure" });
      backend.throwAt = undefined;
      const again = observed(await sender.send(request()));
      expect(again.observation.state).toBe("submitted_unknown");
      expect(backend.calls.filter((s) => s === "send")).toHaveLength(1);
    });
  });

  it("never resends journaled bytes that no longer hash to the journaled txHash", async () => {
    const path = tempJournalPath();
    const node = new FakeNode();
    const first = boot(path, node, { gate: fakeGate("unknown") });
    expect(observed(await first.sender.send(request())).observation).toMatchObject({ state: "prepared" });
    first.journal.close();
    const db = new Database(path);
    db.prepare("UPDATE attempts SET tx_bytes = ? WHERE operation_id = 'op-1'").run(txBytesFor([noteNullifier(7)]));
    db.close();

    const second = boot(path, node);
    expect(observed(await second.sender.send(request())).observation).toEqual({
      state: "unknown",
      reason: "journaled_bytes_mismatch",
    });
    expect(second.gate.queries).toEqual([]); // the gate is never asked about other bytes
    expect(second.journal.get("op-1")?.state).toBe("prepared");
    expect(node.sent).toEqual([]);
  });

  it("re-runs the preflight before resending a held attempt", async () => {
    const node = new FakeNode();
    const gate = fakeGate("unknown");
    let refusal: Error | undefined;
    const preflight = { assertPinned: () => (refusal ? Promise.reject(refusal) : Promise.resolve()) };
    const { sender, backend } = boot(tempJournalPath(), node, { gate, preflight });
    expect(observed(await sender.send(request())).observation).toMatchObject({ state: "prepared" });
    gate.state.decision = "allow";
    refusal = new EnclaveTrustRefused("portal_frozen", "frozen");
    expect(observed(await sender.send(request())).observation).toMatchObject({ state: "prepared", hold: "preflight_refused" });
    expect(gate.queries).toHaveLength(1); // not re-asked: nothing past the preflight ran
    expect(node.sent).toEqual([]);
    refusal = undefined;
    expect(observed(await sender.send(request())).observation.state).toBe("finalized");
    expect(backend.calls).toEqual(["simulate", "sign", "prove", "send"]);
  });

  it("a pipeline failure before the journal is not_submitted and retryable", async () => {
    const node = new FakeNode();
    const { sender, backend } = boot(tempJournalPath(), node);
    backend.throwAt = "sign";
    const out = observed(await sender.send(request()));
    expect(out.observation).toEqual({ state: "not_submitted", reason: "sign_failed", retryable: true });
    backend.throwAt = undefined;
    expect(observed(await sender.send(request())).observation.state).toBe("finalized");
    expect(node.sent).toHaveLength(1);
  });

  it("holds on deny and unknown, then resends the same bytes on allow", async () => {
    const node = new FakeNode();
    const gate = fakeGate("deny");
    const { sender, backend, journal } = boot(tempJournalPath(), node, { gate });
    expect(observed(await sender.send(request())).observation).toMatchObject({ state: "prepared", hold: "may_broadcast_denied" });
    gate.state.decision = "unknown";
    expect(observed(await sender.send(request())).observation).toMatchObject({ state: "prepared", hold: "may_broadcast_unknown" });
    gate.state.decision = "allow";
    expect(observed(await sender.send(request())).observation.state).toBe("finalized");
    expect(backend.calls).toEqual(["simulate", "sign", "prove", "send"]);
    expect(new Set(gate.queries.map((q) => q.txHash)).size).toBe(1);
    expect(journal.attempts("op-1")).toHaveLength(1);
  });

  it("a held attempt is refused for good once validUntil passes, never re-proved", async () => {
    const node = new FakeNode();
    const gate = fakeGate("unknown");
    const c = clock();
    const { sender, backend, journal } = boot(tempJournalPath(), node, { gate, c });
    backend.expiration = BigInt(Math.floor(T0 / 1000) + 1000);
    await sender.send(request({ validUntil: Math.floor(T0 / 1000) + 900 }));
    c.t += 1001_000;
    gate.state.decision = "allow";
    backend.expiration = BigInt(Math.floor(c.t / 1000) + 1000);
    // Expiry >= validUntil is enforced at prepare, so past the expiry validUntil has passed too.
    expect(observed(await sender.send(request({ validUntil: Math.floor(T0 / 1000) + 900 }))).observation).toEqual({
      state: "not_submitted",
      reason: "validity_bound_passed",
      retryable: false,
    });
    expect(journal.attempts("op-1")).toHaveLength(1);
    expect(node.sent).toHaveLength(0);
  });

  it("refuses a proof whose protocol expiry falls before validUntil", async () => {
    const node = new FakeNode();
    const { sender, backend } = boot(tempJournalPath(), node);
    backend.expiration = BigInt(Math.floor(T0 / 1000) + 300);
    const out = observed(await sender.send(request({ validUntil: Math.floor(T0 / 1000) + 600 })));
    expect(out.observation).toEqual({ state: "not_submitted", reason: "expiration_before_valid_until", retryable: false });
    expect(node.sent).toHaveLength(0);
  });

  it("never sends at or after validUntil", async () => {
    const { sender, backend } = boot(tempJournalPath(), new FakeNode());
    const out = observed(await sender.send(request({ validUntil: Math.floor(T0 / 1000) })));
    expect(out.observation).toMatchObject({ state: "not_submitted", reason: "validity_bound_passed" });
    expect(backend.calls).toEqual([]);
  });

  it("refuses a TokenOperation that does not pay exactly the recipient", async () => {
    const node = new FakeNode();
    const { sender, backend } = boot(tempJournalPath(), node);
    backend.recipientAmountOverride = 1n;
    const out = observed(await sender.send(request()));
    expect(out.observation).toEqual({ state: "not_submitted", reason: "token_operation_unexpected", retryable: false });
    expect(backend.calls).toEqual(["simulate"]); // the enclave never saw it
  });

  it("refuses to sign when the pins or the enclave do not verify", async () => {
    for (const [error, reason] of [
      [new OxidePinMismatch("manifest", ["gitSha"]), "oxide_pin_mismatch"],
      [new EnclaveTrustRefused("portal_frozen", "frozen"), "enclave_refused:portal_frozen"],
      [new Error("network"), "oxide_pin_unverified"],
    ] as const) {
      const { sender, backend } = boot(tempJournalPath(), new FakeNode(), {
        preflight: { assertPinned: () => Promise.reject(error) },
      });
      expect(observed(await sender.send(request())).observation).toEqual({ state: "not_submitted", reason, retryable: true });
      expect(backend.calls).toEqual([]);
    }
  });

  it("answers request_in_flight to a concurrent call for the same operation", async () => {
    const { sender, backend } = boot(tempJournalPath(), new FakeNode());
    backend.crashAt = "prove";
    void sender.send(request());
    await settle();
    expect(observed(await sender.send(request())).observation).toEqual({ state: "request_in_flight" });
  });
});

describe("one account, one set of notes", () => {
  it("refuses a second operation on the notes a held attempt spends, before the enclave sees it", async () => {
    const node = new FakeNode();
    const gate = fakeGate("deny");
    const { sender, backend } = boot(tempJournalPath(), node, { gate });
    expect(observed(await sender.send(request({ operationId: "op-1" }))).observation).toMatchObject({ state: "prepared" });
    backend.calls.length = 0;
    gate.state.decision = "allow";
    expect(observed(await sender.send(request({ operationId: "op-2" }))).observation).toEqual({
      state: "not_submitted",
      reason: "inputs_pending",
      retryable: true,
    });
    expect(backend.calls).toEqual(["simulate"]);
    // The held one lands, the PXE sees it, and the retry selects the next note.
    expect(observed(await sender.send(request({ operationId: "op-1" }))).observation.state).toBe("finalized");
    expect(observed(await sender.send(request({ operationId: "op-2" }))).observation.state).toBe("finalized");
    expect(node.sent).toHaveLength(2);
    expect(node.rejected).toEqual([]);
  });

  it("treats a mined attempt as live until the PXE has synced its block", async () => {
    const node = new FakeNode();
    node.pxeLag = 1;
    const { sender } = boot(tempJournalPath(), node);
    expect(observed(await sender.send(request({ operationId: "op-1" }))).observation.state).toBe("finalized");
    expect(observed(await sender.send(request({ operationId: "op-2" }))).observation).toMatchObject({ reason: "inputs_pending" });
    node.pxeLag = 0;
    expect(observed(await sender.send(request({ operationId: "op-2" }))).observation.state).toBe("finalized");
    expect(node.rejected).toEqual([]);
  });

  it("a marked attempt the node never saw holds its notes until its protocol expiry", async () => {
    const path = tempJournalPath();
    const node = new FakeNode();
    const c = clock();
    const first = boot(path, node, { c });
    first.backend.crashAt = "send";
    first.backend.crashBeforeNode = true;
    void first.sender.send(request({ operationId: "op-1" }));
    await settle();
    first.journal.close();

    const second = boot(path, node, { c });
    const late = Math.floor(T0 / 1000) + 86_400 + 600;
    expect(observed(await second.sender.send(request({ operationId: "op-2", validUntil: late }))).observation).toMatchObject({
      reason: "inputs_pending",
    });
    c.t = T0 + 86_400_000; // op-1's expiry: it can no longer land
    second.backend.expiration = BigInt(late + 86_400);
    expect(observed(await second.sender.send(request({ operationId: "op-2", validUntil: late }))).observation.state).toBe(
      "finalized",
    );
    expect(node.sent).toHaveLength(1);
    expect(node.rejected).toEqual([]);
  });

  it("concurrent sends never hand the node two spends of one note", async () => {
    const node = new FakeNode();
    const { sender } = boot(tempJournalPath(), node);
    const outcomes = await Promise.all(
      ["op-1", "op-2", "op-3", "op-4"].map((operationId) => sender.send(request({ operationId }))),
    );
    const states = outcomes.map((o) => observed(o).observation);
    for (const s of states) {
      expect(s.state === "finalized" || (s.state === "not_submitted" && s.reason === "inputs_pending")).toBe(true);
    }
    expect(states.filter((s) => s.state === "finalized").length).toBeGreaterThan(0);
    expect(node.rejected).toEqual([]);
    expect(states.some((s) => s.state === "submitted_unknown")).toBe(false);
  });
});

describe("payoutNoteIndex", () => {
  const payout = { recipient: RECIPIENT, amount: 5n, orderFingerprint: "0x" + "00".repeat(32) };
  const base = {
    nullifiers: [],
    anchorBlockNumber: 0,
    createdNotes: [
      { owner: SENDER, amount: 1n },
      { owner: RECIPIENT, amount: 5n },
    ],
    spentNoteOwners: [SENDER],
    depositRecipients: [SENDER],
    withdrawals: 0,
  };

  it("names the one recipient note", () => {
    expect(payoutNoteIndex(base, SENDER, payout)).toBe(1);
  });

  it.each([
    ["a withdrawal", { ...base, withdrawals: 1 }],
    ["a foreign spent note", { ...base, spentNoteOwners: [RECIPIENT] }],
    ["a foreign deposit", { ...base, depositRecipients: [RECIPIENT] }],
    ["two recipient notes", { ...base, createdNotes: [...base.createdNotes, { owner: RECIPIENT, amount: 5n }] }],
    ["the wrong amount", { ...base, createdNotes: [base.createdNotes[0]!, { owner: RECIPIENT, amount: 4n }] }],
    ["a third party note", { ...base, createdNotes: [...base.createdNotes, { owner: "0x" + "33".repeat(32), amount: 0n }] }],
  ])("refuses %s", (_, summary) => {
    expect(() => payoutNoteIndex(summary, SENDER, payout)).toThrow(UnexpectedTokenOperation);
  });

  it("refuses paying the sending account itself", () => {
    expect(() => payoutNoteIndex(base, SENDER, { ...payout, recipient: SENDER })).toThrow(UnexpectedTokenOperation);
  });
});
