import { describe, expect, it } from "vitest";
import {
  capRefusal,
  capsFromEnv,
  DAI,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_MAX_PER_TX,
  OxideCaps,
  validateCaps,
  WINDOW_MS,
} from "../src/oxide/caps.js";
import { OxideJournal } from "../src/oxide/journal.js";
import { OxideSender, type OxideSendOutcome } from "../src/oxide/sender.js";
import { CAPS, clock, FakeBackend, fakeGate, FakeNode, noPreflight, request, T0, tempJournalPath } from "./oxide-fixtures.js";

const NOTE_MAX = 5_166n * DAI;

function observation(outcome: OxideSendOutcome) {
  if (outcome.kind !== "observed") throw new Error(outcome.kind);
  return outcome.observation;
}

function boot(path: string, c: ReturnType<typeof clock>, node = new FakeNode(), caps = CAPS) {
  const journal = OxideJournal.open(path, { now: c.now });
  const backend = new FakeBackend(node);
  backend.expiration = BigInt(Math.floor(T0 / 1000) + 10 * 86_400);
  const sender = new OxideSender({
    journal,
    backend,
    caps,
    preflight: noPreflight,
    mayBroadcast: fakeGate().client,
    now: c.now,
  });
  return { journal, sender, node };
}

/** validUntil two days out, so a request (and its retry) stays inside its bound as the clock moves. */
const req = (_c: ReturnType<typeof clock>, operationId: string, amount: bigint) =>
  request({ operationId, amount: amount.toString(), validUntil: Math.floor(T0 / 1000) + 2 * 86_400 });

describe("Oxide caps", () => {
  it("defaults to 1,000 DAI per tx and 10,000 DAI per 24h, under the 5,166 DAI note max", () => {
    const caps = capsFromEnv({});
    expect(caps).toEqual({ maxPerTx: DEFAULT_MAX_PER_TX, dailyLimit: DEFAULT_DAILY_LIMIT, maxNoteAmount: NOTE_MAX });
    expect(DEFAULT_MAX_PER_TX).toBe(1_000n * DAI);
    expect(DEFAULT_DAILY_LIMIT).toBe(10_000n * DAI);
  });

  it("reads overrides and refuses nonsense", () => {
    expect(capsFromEnv({ PXE_BRIDGE_OXIDE_MAX_PER_TX: "5", PXE_BRIDGE_OXIDE_DAILY_LIMIT: "10" })).toMatchObject({
      maxPerTx: 5n,
      dailyLimit: 10n,
    });
    expect(() => capsFromEnv({ PXE_BRIDGE_OXIDE_MAX_PER_TX: "1e3" })).toThrow(/positive decimal/);
    expect(() => capsFromEnv({ PXE_BRIDGE_OXIDE_MAX_PER_TX: "0" })).toThrow(/positive decimal/);
    expect(() => capsFromEnv({ PXE_BRIDGE_OXIDE_MAX_PER_TX: "11", PXE_BRIDGE_OXIDE_DAILY_LIMIT: "10" })).toThrow(/cannot exceed/);
    expect(() => validateCaps({ ...CAPS, maxNoteAmount: NOTE_MAX + 1n })).toThrow(/maxNoteAmount/);
  });

  it("per-tx boundary: the cap itself passes, one wei more is refused", () => {
    expect(capRefusal(CAPS, 1_000n * DAI, 0n)).toBeUndefined();
    expect(capRefusal(CAPS, 1_000n * DAI + 1n, 0n)?.reason).toBe("amount_over_per_tx_cap");
    expect(capRefusal(CAPS, 0n, 0n)?.reason).toBe("amount_not_positive");
  });

  it("the note max binds even when the per-tx cap is raised past it", () => {
    const loose = { maxPerTx: 10_000n * DAI, dailyLimit: 10_000n * DAI, maxNoteAmount: NOTE_MAX };
    expect(capRefusal(loose, NOTE_MAX, 0n)).toBeUndefined();
    expect(capRefusal(loose, NOTE_MAX + 1n, 0n)?.reason).toBe("amount_over_note_max");
  });

  it("daily boundary: filling the window exactly passes, one wei more is refused", () => {
    expect(capRefusal(CAPS, 1_000n * DAI, 9_000n * DAI)).toBeUndefined();
    expect(capRefusal(CAPS, 1n, 10_000n * DAI)?.reason).toBe("daily_cap_exhausted");
    expect(capRefusal(CAPS, 1_000n * DAI, 9_000n * DAI + 1n)?.reason).toBe("daily_cap_exhausted");
  });

  it("admission counts in-flight reservations until released", () => {
    let spent = 0n;
    const caps = new OxideCaps(CAPS, () => spent);
    for (let i = 0; i < 10; i++) caps.admit(`op-${i}`, 1_000n * DAI);
    expect(() => caps.admit("op-10", 1n)).toThrow(/daily_cap_exhausted/);
    caps.release("op-0");
    caps.admit("op-10", 1n);
    spent = 9_000n * DAI;
    expect(() => caps.admit("op-11", 1_000n * DAI)).toThrow(/daily_cap_exhausted/);
  });

  it("refuses over-cap amounts before anything is simulated", async () => {
    const c = clock();
    const { sender, node } = boot(tempJournalPath(), c);
    expect(observation(await sender.send(req(c, "big", 1_000n * DAI + 1n)))).toEqual({
      state: "not_submitted",
      reason: "cap:amount_over_per_tx_cap",
      retryable: false,
    });
    const loose = { maxPerTx: 10_000n * DAI, dailyLimit: 10_000n * DAI, maxNoteAmount: NOTE_MAX };
    const other = boot(tempJournalPath(), c, node, loose);
    expect(observation(await other.sender.send(req(c, "huge", NOTE_MAX + 1n)))).toMatchObject({
      reason: "cap:amount_over_note_max",
      retryable: false,
    });
    expect(node.sent).toHaveLength(0);
  });

  it("rolling window: a spend counts for exactly 24h, then frees its budget", async () => {
    const c = clock();
    const { sender, node } = boot(tempJournalPath(), c);
    for (let i = 0; i < 10; i++) {
      expect(observation(await sender.send(req(c, `op-${i}`, 1_000n * DAI))).state).toBe("finalized");
    }
    const refused = observation(await sender.send(req(c, "op-10", 1n)));
    expect(refused).toEqual({ state: "not_submitted", reason: "cap:daily_cap_exhausted", retryable: true });

    c.t = T0 + WINDOW_MS; // the first spends are exactly 24h old: still inside
    expect(observation(await sender.send(req(c, "op-10", 1n))).state).toBe("not_submitted");
    c.t = T0 + WINDOW_MS + 1;
    expect(observation(await sender.send(req(c, "op-10", 1n))).state).toBe("finalized");
    expect(node.sent).toHaveLength(11);
  });

  it("survives a restart: the window is rebuilt from durable spend rows", async () => {
    const path = tempJournalPath();
    const c = clock();
    const node = new FakeNode();
    const first = boot(path, c, node);
    for (let i = 0; i < 10; i++) await first.sender.send(req(c, `op-${i}`, 1_000n * DAI));
    first.journal.close();

    c.t += 60_000;
    const second = boot(path, c, node);
    expect(second.journal.spentSince(c.t - WINDOW_MS)).toBe(10_000n * DAI);
    expect(observation(await second.sender.send(req(c, "after-restart", 1n)))).toMatchObject({
      reason: "cap:daily_cap_exhausted",
    });
    expect(node.sent).toHaveLength(10);
  });

  it("the mark re-checks the durable window, so a lost reservation cannot overspend", async () => {
    // In-memory reservations end with the call (and with the process). A
    // prepared attempt held at the gate holds no budget, so another operation
    // can take the window's last 1,000 DAI before the held one is allowed.
    const path = tempJournalPath();
    const c = clock();
    const node = new FakeNode();
    const gate = fakeGate("unknown");
    const journal = OxideJournal.open(path, { now: c.now });
    const backend = new FakeBackend(node);
    backend.expiration = BigInt(Math.floor(T0 / 1000) + 10 * 86_400);
    const sender = new OxideSender({
      journal,
      backend,
      caps: CAPS,
      preflight: noPreflight,
      mayBroadcast: gate.client,
      now: c.now,
    });
    for (let i = 0; i < 9; i++) {
      gate.state.decision = "allow";
      await sender.send(req(c, `op-${i}`, 1_000n * DAI));
    }
    gate.state.decision = "unknown";
    // Admitted against 9,000 spent: fits. Held before the mark.
    expect(observation(await sender.send(req(c, "held", 1_000n * DAI)))).toMatchObject({ state: "prepared" });
    gate.state.decision = "allow";
    // Another operation, spending a note the held one does not (the account
    // holds several), takes the last 1,000 DAI first.
    backend.forceNote = 99;
    expect(observation(await sender.send(req(c, "other", 1_000n * DAI))).state).toBe("finalized");
    backend.forceNote = undefined;
    // The held attempt's exact bytes are re-asked and allowed, but the mark
    // refuses: the durable window is full. Not marked, not sent, still prepared.
    expect(observation(await sender.send(req(c, "held", 1_000n * DAI)))).toMatchObject({
      state: "prepared",
      hold: "cap_window_full",
    });
    expect(journal.get("held")?.state).toBe("prepared");
    expect(journal.spentSince(c.t - WINDOW_MS)).toBe(10_000n * DAI);
    expect(node.sent).toHaveLength(10);
  });
});
