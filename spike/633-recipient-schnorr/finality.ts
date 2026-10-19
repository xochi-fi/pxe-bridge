/**
 * Polls the node until the given tx reaches `finalized` (or a deadline),
 * printing every change of receipt status and chain tips, plus the L1 head
 * and L1 finalized block it is waiting on.
 *
 *   npx tsx spike/633-recipient-schnorr/finality.ts <txHash> [seconds]
 */
import { setTimeout as sleep } from "node:timers/promises";

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { TxHash, TxStatus } from "@aztec/stdlib/tx";
import { z } from "zod";

import { NODE_URL } from "./common.js";

const L1 = process.env["L1_RPC_URL"] ?? "http://localhost:8545";
const l1Block = async (tag: string): Promise<number> => {
  const res = await fetch(L1, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [tag, false] }),
  });
  const { result } = z
    .object({ result: z.object({ number: z.string() }).nullable() })
    .parse(await res.json());
  return result ? parseInt(result.number, 16) : -1;
};

const node = createAztecNodeClient(NODE_URL);
const txHash = TxHash.fromString(process.argv[2]!);
const deadline = Date.now() + Number(process.argv[3] ?? "300") * 1000;
const started = Date.now();
let last = "";
let status: TxStatus | undefined;
while (Date.now() < deadline) {
  const r = await node.getTxReceipt(txHash);
  const t = await node.getChainTips();
  status = r.status;
  const line =
    `status=${r.status} block=${r.blockNumber} L2 proposed=${t.proposed.number} proven=${t.proven.block.number} ` +
    `finalized=${t.finalized.block.number} | L1 latest=${await l1Block("latest")} finalized=${await l1Block("finalized")}`;
  if (line !== last) console.log(`+${Math.round((Date.now() - started) / 1000)}s ${line}`);
  last = line;
  if (status === TxStatus.FINALIZED) break;
  await sleep(3000);
}
console.log(`final status ${status}`);
process.exit(status === TxStatus.FINALIZED ? 0 : 1);
