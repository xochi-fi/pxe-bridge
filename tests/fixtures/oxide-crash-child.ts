/**
 * One bridge process for the interrupted-send recovery run (xochi#748 OX-6):
 * the real Oxide journal on disk, the real OxideSender, the fake PXE/enclave/
 * node boundary of tests/oxide-fixtures.ts with the node's state persisted to
 * a file so it survives this process. `OXIDE_CRASH_AT` kills the process
 * (SIGKILL, no cleanup) at one point of the send:
 *
 * - `awaiting_allow`: the proven transfer is journaled `prepared`, the
 *   may-broadcast query is out, no answer yet;
 * - `after_allow_before_send`: the allow was marked durably, the bytes were
 *   not handed to the node;
 * - `after_send_before_receipt`: the node took the bytes, no receipt was read.
 *
 * Unset, the process runs the same operation to its answer and exits 0. Every
 * line on stdout is one JSON event, written synchronously so a kill cannot
 * lose it. Driven by tests/oxide-crash-recovery.test.ts; no secrets.
 */
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { OxideJournal } from "../../src/oxide/journal.js";
import { OxideSender } from "../../src/oxide/sender.js";
import type { MayBroadcastClient } from "../../src/may-broadcast.js";
import { CAPS, FakeBackend, FakeNode, fakeAdmission, noPreflight, request } from "../oxide-fixtures.js";

type CrashPoint = "awaiting_allow" | "after_allow_before_send" | "after_send_before_receipt";

const run = process.env["OXIDE_CRASH_RUN"] ?? "?";
const crashAt = process.env["OXIDE_CRASH_AT"] as CrashPoint | undefined;
const journalPath = process.env["OXIDE_CRASH_JOURNAL"];
const nodeFile = process.env["OXIDE_CRASH_NODE"];
if (!journalPath || !nodeFile) throw new Error("OXIDE_CRASH_JOURNAL and OXIDE_CRASH_NODE are required");

function log(event: string, extra: Record<string, unknown> = {}): void {
  writeSync(1, `${JSON.stringify({ run, pid: process.pid, event, ...extra })}\n`);
}

/** Dies here, as a power loss would: nothing after this line runs. */
function die(event: string): Promise<never> {
  log(event, { signal: "SIGKILL" });
  process.kill(process.pid, "SIGKILL");
  return new Promise<never>(() => {});
}

/** The fake node with its chain on disk: what it took in one process is what the next one observes. */
class PersistentNode extends FakeNode {
  constructor(private readonly file: string) {
    super();
    if (!existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      block: number;
      sent: string[];
      mined: [string, { block: number; nullifiers: string[]; noteHashes: string[]; duplicatedNoteHashes: string[] }][];
    };
    this.block = saved.block;
    this.sent.push(...saved.sent);
    for (const [hash, tx] of saved.mined) this.mined.set(hash, tx);
  }

  override sendTx(txBytes: Buffer): void {
    super.sendTx(txBytes);
    writeFileSync(this.file, JSON.stringify({ block: this.block, sent: this.sent, mined: [...this.mined.entries()] }));
  }
}

const node = new PersistentNode(nodeFile);
const backend = new FakeBackend(node);
const originalSend = backend.send.bind(backend);
backend.send = async (txBytes: Buffer): Promise<void> => {
  if (crashAt === "after_allow_before_send") await die("crash: mark durable, bytes not handed to the node");
  await originalSend(txBytes);
  log("node accepted the transfer", { transfers: node.sent.length });
  if (crashAt === "after_send_before_receipt") await die("crash: sent, receipt not read");
};

const gate: MayBroadcastClient = async (query) => {
  log("may-broadcast asked", { txHash: query.txHash });
  if (crashAt === "awaiting_allow") await die("crash: prepared, awaiting the allow");
  return { decision: "allow", detail: "harness" };
};

const journal = OxideJournal.open(journalPath, { allowCreate: run === "1" });
const before = journal.get("op-1");
log("journal opened", {
  state: before?.state ?? "absent",
  hold: before?.hold ?? null,
  attempts: before ? journal.attempts("op-1").length : 0,
  transfersOnChain: node.sent.length,
});

const sender = new OxideSender({
  journal,
  backend,
  caps: CAPS,
  preflight: noPreflight,
  admission: fakeAdmission().admission,
  mayBroadcast: gate,
});

const outcome = await sender.send(request());
if (outcome.kind !== "observed") throw new Error(`unexpected outcome ${outcome.kind}`);
const after = journal.get("op-1");
log("answered", {
  state: outcome.observation.state,
  reason: "reason" in outcome.observation ? outcome.observation.reason : null,
  journalState: after?.state ?? "absent",
  attempts: journal.attempts("op-1").length,
  pipeline: backend.calls,
  transfersOnChain: node.sent.length,
});
journal.close();
