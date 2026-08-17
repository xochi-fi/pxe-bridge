import { describe, it, expect } from "vitest";
import { IdempotencyStore, type IdempotentOutcome } from "../src/idempotency.js";
import type { CreateNoteResult } from "../src/types.js";

const RESULT: CreateNoteResult = {
  noteHashes: ["0xn1", "0xn2"],
  nullifiers: ["0xu1", "0xu2", "0xu3"],
  l2TxHash: "0xtx",
  noteCommitment: "0xn1",
  nullifierHash: "0xu1",
};

const settled: IdempotentOutcome = { kind: "result", result: RESULT };

describe("IdempotencyStore", () => {
  it("lets an unseen key through", () => {
    expect(new IdempotencyStore().begin("k1")).toEqual({ state: "fresh" });
  });

  // The claim is synchronous, so two requests arriving together cannot both be
  // told to proceed. Without that, the duplicate this class exists to stop is
  // exactly the one that races past it.
  it("claims a key on the first call", () => {
    const store = new IdempotencyStore();
    store.begin("k1");
    expect(store.begin("k1")).toEqual({ state: "in-flight" });
  });

  it("replays a settled outcome", () => {
    const store = new IdempotencyStore();
    store.begin("k1");
    store.settle("k1", settled);

    expect(store.begin("k1")).toEqual({ state: "settled", outcome: settled });
  });

  it("keeps replaying, not just once", () => {
    const store = new IdempotencyStore();
    store.begin("k1");
    store.settle("k1", settled);

    expect(store.begin("k1").state).toBe("settled");
    expect(store.begin("k1").state).toBe("settled");
  });

  it("keeps separate keys separate", () => {
    const store = new IdempotencyStore();
    store.begin("k1");
    store.settle("k1", settled);

    expect(store.begin("k2")).toEqual({ state: "fresh" });
  });

  // Deliberately not Stripe's semantics. A key guards against repeating a
  // TRANSFER, and a request the limits rejected has no transfer to repeat.
  // Recording it would strand the caller: every retry would replay the failure
  // and the trade could never settle.
  it("frees a key whose request moved nothing", () => {
    const store = new IdempotencyStore();
    store.begin("k1");
    store.abandon("k1");

    expect(store.begin("k1")).toEqual({ state: "fresh" });
  });

  it("holds a key across an abandon of a different one", () => {
    const store = new IdempotencyStore();
    store.begin("k1");
    store.settle("k1", settled);
    store.begin("k2");
    store.abandon("k2");

    expect(store.begin("k1").state).toBe("settled");
  });

  describe("restore", () => {
    it("seeds a key that replays immediately", () => {
      const store = new IdempotencyStore();
      const restored = store.restore([{ key: "k1", outcome: settled, timestamp: Date.now() }]);

      expect(restored).toBe(1);
      expect(store.begin("k1")).toEqual({ state: "settled", outcome: settled });
    });

    it("drops entries older than the window", () => {
      const store = new IdempotencyStore();
      const old = Date.now() - 25 * 60 * 60 * 1000;

      expect(store.restore([{ key: "k1", outcome: settled, timestamp: old }])).toBe(0);
      expect(store.begin("k1")).toEqual({ state: "fresh" });
    });

    // Startup replays the log into a store this process may already have
    // written to. A stale record must not displace a live claim, or a request
    // in flight would be reported as something it is not.
    it("does not displace a key this process already claimed", () => {
      const store = new IdempotencyStore();
      store.begin("k1");

      expect(store.restore([{ key: "k1", outcome: settled, timestamp: Date.now() }])).toBe(0);
      expect(store.begin("k1")).toEqual({ state: "in-flight" });
    });
  });
});
