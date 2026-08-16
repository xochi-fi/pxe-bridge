import { describe, it, expect } from "vitest";
import { createSerializer } from "../src/aztec-client.js";

/** Resolves after `ms`, so overlapping calls genuinely interleave without it. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createSerializer", () => {
  it("runs calls one at a time even when they overlap", async () => {
    const serialize = createSerializer();
    const events: string[] = [];

    const task = (name: string, ms: number) =>
      serialize(async () => {
        events.push(`${name}:start`);
        await sleep(ms);
        events.push(`${name}:end`);
        return name;
      });

    // The first sleeps longest. Without serialization b and c would both start
    // before a finished, which is the interleaving that clobbers the binding.
    const results = await Promise.all([task("a", 30), task("b", 10), task("c", 1)]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("preserves call order rather than completion order", async () => {
    const serialize = createSerializer();
    const order: number[] = [];

    await Promise.all(
      [50, 5, 20, 1].map((ms, i) =>
        serialize(async () => {
          await sleep(ms);
          order.push(i);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("keeps running later calls after one rejects", async () => {
    const serialize = createSerializer();
    const ran: string[] = [];

    const failing = serialize(async () => {
      ran.push("first");
      throw new Error("boom");
    });
    const following = serialize(async () => {
      ran.push("second");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ok");
    expect(ran).toEqual(["first", "second"]);
  });

  it("reports each call's own outcome", async () => {
    const serialize = createSerializer();

    const results = await Promise.allSettled([
      serialize(async () => "one"),
      serialize(async () => {
        throw new Error("two failed");
      }),
      serialize(async () => "three"),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("does not leave an unhandled rejection behind a failing call", async () => {
    const serialize = createSerializer();

    // Deliberately not awaited until after the next call settles: the queue
    // stores its own error-swallowing continuation, so this must not surface
    // as an unhandled rejection in the meantime.
    const failing = serialize(async () => {
      throw new Error("ignored for now");
    });
    await expect(serialize(async () => "after")).resolves.toBe("after");
    await expect(failing).rejects.toThrow("ignored for now");
  });
});
