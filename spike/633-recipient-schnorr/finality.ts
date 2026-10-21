/**
 * Drives one tx to L2 `finalized` on the sandbox, failing (exit 1) unless it
 * gets there before the deadline:
 *
 *   1. wait until the receipt is `proven` (the proof is on L1);
 *   2. mine MINE_L1_BLOCKS L1 blocks (anvil_mine). The sandbox mines L1 only
 *      on demand and anvil reports `finalized` 64 blocks behind head, so L2
 *      `finalized` never moves on its own;
 *   3. wait until the receipt is `finalized`.
 *
 * Logs every change of receipt status and chain tips, with the L1 head and L1
 * finalized block. Each node and L1 call is bounded by RPC_TIMEOUT_MS, and a
 * watchdog exits 1 at the deadline even if a call never settles.
 *
 *   npx tsx spike/633-recipient-schnorr/finality.ts <txHash> [seconds]
 */
import { setTimeout as sleep } from "node:timers/promises";

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { TxHash, TxStatus } from "@aztec/stdlib/tx";
import { z } from "zod";

import { NODE_URL } from "./common.js";

const RPC_TIMEOUT_MS = 15_000;
const MINE_L1_BLOCKS = 70;
const L1 = process.env["L1_RPC_URL"] ?? "http://localhost:8545";

const txHash = TxHash.fromString(process.argv[2]!);
const seconds = Number(process.argv[3] ?? "300");
const started = Date.now();
const deadline = started + seconds * 1000;
setTimeout(() => {
  console.log(`FAIL watchdog: ${txHash} not finalized within ${seconds}s`);
  process.exit(1);
}, seconds * 1000);

async function l1(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(L1, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`L1 ${method}: HTTP ${res.status}`);
  const body = z.object({ result: z.unknown(), error: z.unknown() }).partial().parse(await res.json());
  if (body.error !== undefined) throw new Error(`L1 ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function l1Block(tag: string): Promise<number> {
  const block = z.object({ number: z.string() }).nullable().parse(await l1("eth_getBlockByNumber", [tag, false]));
  return block ? parseInt(block.number, 16) : -1;
}

/** The node client takes no abort signal; race each call against the same bound. */
async function bounded<T>(what: string, call: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${RPC_TIMEOUT_MS} ms`)), RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const node = createAztecNodeClient(NODE_URL);
let last = "";
async function waitFor(targets: TxStatus[]): Promise<TxStatus | undefined> {
  let status: TxStatus | undefined;
  while (Date.now() < deadline) {
    const r = await bounded("getTxReceipt", node.getTxReceipt(txHash));
    const t = await bounded("getChainTips", node.getChainTips());
    status = r.status;
    const line =
      `status=${r.status} block=${r.blockNumber} L2 proposed=${t.proposed.number} proven=${t.proven.block.number} ` +
      `finalized=${t.finalized.block.number} | L1 latest=${await l1Block("latest")} finalized=${await l1Block("finalized")}`;
    if (line !== last) console.log(`+${Math.round((Date.now() - started) / 1000)}s ${line}`);
    last = line;
    if (targets.includes(status)) return status;
    await sleep(3000);
  }
  return status;
}

const proven = await waitFor([TxStatus.PROVEN, TxStatus.FINALIZED]);
if (proven !== TxStatus.PROVEN && proven !== TxStatus.FINALIZED) {
  console.log(`FAIL ${txHash} not proven within ${seconds}s (last status ${proven})`);
  process.exit(1);
}
await l1("anvil_mine", [`0x${MINE_L1_BLOCKS.toString(16)}`]);
console.log(`mined ${MINE_L1_BLOCKS} L1 blocks`);
const final = await waitFor([TxStatus.FINALIZED]);
console.log(`${final === TxStatus.FINALIZED ? "PASS" : "FAIL"} ${txHash} final status ${final}`);
process.exit(final === TxStatus.FINALIZED ? 0 : 1);
