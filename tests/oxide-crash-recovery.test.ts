import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Interrupted-send recovery across a real process death (xochi#748 OX-6).
 * tests/oxide-sender.test.ts proves the same points in one process; this run
 * kills the bridge process (SIGKILL) at each point and restarts it on the
 * same journal file, so what is proven is the on-disk journal, the SQLite
 * lock's release and the resume path as a redeploy sees them.
 */
const CHILD = fileURLToPath(new URL("./fixtures/oxide-crash-child.ts", import.meta.url));

interface Event {
  run: string;
  event: string;
  state?: string;
  reason?: string | null;
  hold?: string | null;
  journalState?: string;
  attempts?: number;
  pipeline?: string[];
  transfersOnChain?: number;
  transfers?: number;
  txHash?: string;
}

function bridge(run: string, env: Record<string, string>): { events: Event[]; signal: string | null; status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
    env: { ...process.env, OXIDE_CRASH_RUN: run, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  const events = r.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Event);
  return { events, signal: r.signal, status: r.status, stderr: r.stderr };
}

/** The whole run as the evidence excerpt: one line per event, no secrets involved. */
function excerpt(label: string, ...runs: { events: Event[]; signal: string | null; status: number | null }[]): string {
  const lines = [`== ${label}`];
  for (const run of runs) {
    for (const e of run.events) lines.push(JSON.stringify(e));
    lines.push(`-- process ended: ${run.signal ?? `exit ${run.status}`}`);
  }
  return lines.join("\n");
}

describe("interrupted-send recovery across a process kill (OX-6)", { timeout: 300_000 }, () => {
  function fresh() {
    const dir = mkdtempSync(join(tmpdir(), "oxide-crash-"));
    return { OXIDE_CRASH_JOURNAL: join(dir, "oxide.sqlite"), OXIDE_CRASH_NODE: join(dir, "node.json") };
  }

  it("killed while awaiting the allow: the restart resends the journaled bytes once, never re-proves", () => {
    const env = fresh();
    const first = bridge("1", { ...env, OXIDE_CRASH_AT: "awaiting_allow" });
    expect(first.signal).toBe("SIGKILL");
    const asked = first.events.find((e) => e.event === "may-broadcast asked");
    expect(asked?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.events.at(-1)?.event).toBe("crash: prepared, awaiting the allow");

    const second = bridge("2", env);
    console.log(excerpt("awaiting_allow", first, second));
    expect(second.status).toBe(0);
    const opened = second.events.find((e) => e.event === "journal opened");
    expect(opened).toMatchObject({ state: "prepared", hold: null, attempts: 1, transfersOnChain: 0 });
    // The same transaction is put to the gate again: the hash the journal holds.
    expect(second.events.find((e) => e.event === "may-broadcast asked")?.txHash).toBe(asked?.txHash);
    expect(second.events.at(-1)).toMatchObject({
      event: "answered",
      state: "finalized",
      journalState: "finalized",
      attempts: 1,
      pipeline: ["send"],
      transfersOnChain: 1,
    });
  });

  it("killed after the allow was marked, before the node took the bytes: never resent, held as submitted_unknown", () => {
    const env = fresh();
    const first = bridge("1", { ...env, OXIDE_CRASH_AT: "after_allow_before_send" });
    expect(first.signal).toBe("SIGKILL");
    expect(first.events.at(-1)?.event).toBe("crash: mark durable, bytes not handed to the node");

    const second = bridge("2", env);
    console.log(excerpt("after_allow_before_send", first, second));
    expect(second.status).toBe(0);
    expect(second.events.find((e) => e.event === "journal opened")).toMatchObject({
      state: "may_broadcast",
      attempts: 1,
      transfersOnChain: 0,
    });
    // An allow that may have reached the wire is never resent blindly: the
    // restart only observes, and the node not knowing the hash is not proof
    // it never landed.
    expect(second.events.at(-1)).toMatchObject({
      event: "answered",
      state: "submitted_unknown",
      reason: "node_reports_dropped_or_unknown",
      journalState: "may_broadcast",
      pipeline: [],
      transfersOnChain: 0,
    });
    expect(second.events.some((e) => e.event === "may-broadcast asked")).toBe(false);
  });

  it("killed after the send, before the receipt: the restart observes the mined transfer and sends nothing", () => {
    const env = fresh();
    const first = bridge("1", { ...env, OXIDE_CRASH_AT: "after_send_before_receipt" });
    expect(first.signal).toBe("SIGKILL");
    expect(first.events.find((e) => e.event === "node accepted the transfer")).toMatchObject({ transfers: 1 });
    expect(first.events.at(-1)?.event).toBe("crash: sent, receipt not read");

    const second = bridge("2", env);
    console.log(excerpt("after_send_before_receipt", first, second));
    expect(second.status).toBe(0);
    expect(second.events.find((e) => e.event === "journal opened")).toMatchObject({
      state: "may_broadcast",
      attempts: 1,
      transfersOnChain: 1,
    });
    expect(second.events.at(-1)).toMatchObject({
      event: "answered",
      state: "finalized",
      journalState: "finalized",
      pipeline: [],
      transfersOnChain: 1,
    });
    expect(second.events.some((e) => e.event === "may-broadcast asked")).toBe(false);
  });
});
