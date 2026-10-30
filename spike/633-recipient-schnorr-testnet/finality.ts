/**
 * Waits for the recipient's deploy tx to reach L2 `finalized` on the public
 * testnet, then checks the account's initialization nullifier against the
 * node's nullifier tree at that finalized block. Fails (exit 1) unless all of
 * it holds before the deadline:
 *
 *   1. the receipt reaches `finalized` and the chain's finalized tip is at or
 *      past the tx's block (the testnet proves epochs and Sepolia finalizes on
 *      its own; nothing is mined here, unlike the sandbox run);
 *   2. the siloed private initialization nullifier, recomputed from the
 *      descriptor's address and initializationHash, is in the tx's effects;
 *   3. it is a member of the nullifier tree at the finalized tip and at the
 *      tx's own block, and absent at the block before, so this tx emitted it.
 *
 * The public initialization nullifier is looked up and reported too; whether
 * SchnorrAccount emits one depends on its public functions' init checks.
 *
 *   npx tsx spike/633-recipient-schnorr-testnet/finality.ts <txHash> [seconds]
 */
import { setTimeout as sleep } from "node:timers/promises";

import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { BlockNumber, Fr } from "@aztec-labs/aztec.js/fields";
import {
  computeSiloedPrivateInitializationNullifier,
  computeSiloedPublicInitializationNullifier,
} from "@aztec-labs/stdlib/hash";
import { TxHash, TxStatus } from "@aztec-labs/stdlib/tx";
import { z } from "zod";

import { bounded, nodeClient, readPublic } from "./common.js";

const txHash = TxHash.fromString(process.argv[2]!);
const seconds = Number(process.argv[3] ?? "5400");
const started = Date.now();
const deadline = started + seconds * 1000;
setTimeout(() => {
  console.log(`FAIL watchdog: ${txHash} not finalized within ${seconds}s`);
  process.exit(1);
}, seconds * 1000).unref();

const pub = z
  .object({
    recipientAddress: z.string(),
    recipientDescriptor: z.object({ initializationHash: z.string() }).passthrough(),
  })
  .passthrough()
  .parse(readPublic());
const address = AztecAddress.fromStringUnsafe(pub.recipientAddress);
const initializationHash = Fr.fromString(pub.recipientDescriptor.initializationHash);

const node = nodeClient();
let ok = true;
const check = (label: string, pass: boolean, detail = ""): void => {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  ok &&= pass;
};

let last = "";
let status: TxStatus | undefined;
let finalizedTip = 0;
while (Date.now() < deadline) {
  try {
    const r = await bounded("getTxReceipt", node.getTxReceipt(txHash));
    const t = await bounded("getChainTips", node.getChainTips());
    status = r.status;
    finalizedTip = t.finalized.block.number;
    const line =
      `status=${r.status} block=${r.blockNumber} L2 proposed=${t.proposed.number} checkpointed=${t.checkpointed.block.number} ` +
      `proven=${t.proven.block.number} finalized=${t.finalized.block.number}`;
    if (line !== last) console.log(`+${Math.round((Date.now() - started) / 1000)}s ${line}`);
    last = line;
    if (status === TxStatus.FINALIZED) break;
  } catch (err) {
    // A slow or failed poll is retried until the deadline, never treated as progress.
    console.log(`+${Math.round((Date.now() - started) / 1000)}s poll error: ${String(err)}`);
  }
  await sleep(15_000);
}
check(`${txHash} receipt status finalized`, status === TxStatus.FINALIZED, `last status ${status}`);
if (status !== TxStatus.FINALIZED) process.exit(1);

const receipt = await bounded("getTxReceipt(includeTxEffect)", node.getTxReceipt(txHash, { includeTxEffect: true }));
if (!receipt.isMined()) throw new Error(`receipt for ${txHash} is not mined after finalized: ${receipt.status}`);
const txBlock = receipt.blockNumber;
check("chain finalized tip >= deploy tx block", finalizedTip >= txBlock, `tip ${finalizedTip}, tx block ${txBlock}`);

const privateInit = await computeSiloedPrivateInitializationNullifier(address, initializationHash);
const publicInit = await computeSiloedPublicInitializationNullifier(address);
console.log(`siloed private initialization nullifier ${privateInit.toString()}`);
console.log(`siloed public initialization nullifier  ${publicInit.toString()}`);
if (!receipt.txEffect) throw new Error(`receipt for ${txHash} carries no txEffect despite includeTxEffect`);
const effectNullifiers = receipt.txEffect.nullifiers;
console.log(`deploy tx nullifiers (${effectNullifiers.length}): ${effectNullifiers.map((n) => n.toString()).join(", ")}`);
check("private initialization nullifier is in the deploy tx effects", effectNullifiers.some((n) => n.equals(privateInit)));
console.log(`public initialization nullifier in the deploy tx effects: ${effectNullifiers.some((n) => n.equals(publicInit))}`);

const atFinalized = await bounded(
  "nullifier witness @finalized tip",
  node.getNullifierMembershipWitness(BlockNumber(finalizedTip), privateInit),
);
check(
  `private initialization nullifier is a member of the nullifier tree at finalized block ${finalizedTip}`,
  atFinalized !== undefined && atFinalized.leafPreimage.getKey() === privateInit.toBigInt(),
  atFinalized ? `leaf index ${atFinalized.index}` : "no witness",
);
const atTxBlock = await bounded("nullifier witness @tx block", node.getNullifierMembershipWitness(txBlock, privateInit));
check(`... and at the deploy tx's block ${txBlock}`, atTxBlock !== undefined, atTxBlock ? `leaf index ${atTxBlock.index}` : "no witness");
const before = await bounded(
  "nullifier witness @tx block - 1",
  node.getNullifierMembershipWitness(BlockNumber(txBlock - 1), privateInit),
);
check(`... and absent at block ${txBlock - 1}, before the deploy`, before === undefined);

process.exit(ok ? 0 : 1);
