/**
 * bb.js Schnorr verification in a worker thread, so run.ts can bound each call:
 * BarretenbergSync runs synchronously, and a call that never returned would
 * otherwise block run.ts's timer as well. Answers each request with the
 * verdict or the message of whatever was thrown.
 */
import { parentPort } from "node:worker_threads";

import { Fr } from "@aztec/aztec.js/fields";
import { Schnorr, SchnorrSignature } from "@aztec/foundation/crypto/schnorr";
import { Point } from "@aztec/foundation/curves/grumpkin";

export interface BbRequest {
  id: number;
  x: bigint;
  y: bigint;
  message: bigint;
  signature: Uint8Array;
}
export type BbReply = { id: number; valid: boolean } | { id: number; error: string };

const port = parentPort!;
port.on("message", async (r: BbRequest) => {
  let reply: BbReply;
  try {
    const valid = await new Schnorr().verifySignature(
      new Fr(r.message),
      new Point(new Fr(r.x), new Fr(r.y)),
      new SchnorrSignature(Buffer.from(r.signature)),
    );
    reply = { id: r.id, valid };
  } catch (err) {
    reply = { id: r.id, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(reply);
});
