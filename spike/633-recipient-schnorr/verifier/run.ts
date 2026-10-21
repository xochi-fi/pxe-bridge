/**
 * Exercises verifier/schnorr-grumpkin.ts and cross-checks it against the SDK's
 * own bb.js implementation. The bb.js imports are here and in bb-reference.ts
 * only, as a reference; the verifier module itself imports neither.
 *
 *   1. Poseidon2 (pure JS) == bb.js poseidon2Hash on 20 random inputs;
 *   2. the Noir library's pinned DST derivation;
 *   3. digestToField(digest) == the message field the recipient's PXE signed,
 *      for each recipient signature; digestToField refuses 31 and 33 bytes;
 *   4. every case in cases.ts: the pure-JS verifier (request.ts parse, then
 *      verifySchnorrGrumpkin) must give the case's `expect`, and bb.js the
 *      case's `bb` (its verdict, or the exact refusal). bb.js runs in a worker
 *      thread with a per-call deadline, so a hang fails the case.
 *
 * workerd-check.ts runs the same table inside workerd.
 *
 *   npx tsx spike/633-recipient-schnorr/verifier/run.ts
 */
import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";

import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash as bbPoseidon2 } from "@aztec/foundation/crypto/poseidon";
import { poseidon2Hash } from "@zkpassport/poseidon2";

import { readPublic } from "../common.js";
import type { BbReply, BbRequest } from "./bb-reference.js";
import { buildCases, PublicSchema, type Verdict } from "./cases.js";
import { MalformedRequest, parseRequest, type ParsedRequest } from "./request.js";
import {
  digestToField,
  FIELD_MODULUS,
  SCHNORR_CHALLENGE_DST,
  verifySchnorrGrumpkin,
} from "./schnorr-grumpkin.js";

const BB_CALL_TIMEOUT_MS = 30_000;

let ok = true;
const check = (label: string, pass: boolean): void => {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  ok &&= pass;
};

// 1. Poseidon2 parity
let parity = true;
for (let i = 0; i < 20; i++) {
  const len = 1 + (i % 7);
  const inputs = Array.from({ length: len }, () => BigInt(`0x${randomBytes(32).toString("hex")}`) % FIELD_MODULUS);
  const bb = (await bbPoseidon2(inputs.map((v) => new Fr(v)))).toBigInt();
  parity &&= poseidon2Hash(inputs) === bb;
}
check("poseidon2 pure-JS == bb.js on 20 random inputs (lengths 1..7)", parity);

// 2. Noir-pinned DST
let packed = 0n;
let mul = 1n;
for (const b of Buffer.from("schnorr_grumpkin_poseidon2")) {
  packed += BigInt(b) * mul;
  mul *= 256n;
}
check("SCHNORR_CHALLENGE_DST == poseidon2([pack('schnorr_grumpkin_poseidon2')])", poseidon2Hash([packed]) === SCHNORR_CHALLENGE_DST);

// 3. Digest reduction
const pub = readPublic();
for (const [i, v] of PublicSchema.parse(pub).recipientSignatures.entries()) {
  const field = digestToField(Buffer.from(v.digest.slice(2), "hex"));
  check(`sig[${i}] digestToField(digest) == signer's message field (${v.digest.slice(0, 10)}..)`, field === BigInt(v.messageField));
}
for (const len of [31, 33]) {
  let threw = false;
  try {
    digestToField(new Uint8Array(len));
  } catch {
    threw = true;
  }
  check(`digestToField refuses a ${len}-byte digest`, threw);
}

// 4. The case table
const bbWorker = new Worker(new URL("./bb-reference.ts", import.meta.url));
let nextId = 0;
async function bbVerify(r: Omit<BbRequest, "id">): Promise<BbReply | "timeout"> {
  const id = nextId++;
  let timer: NodeJS.Timeout | undefined;
  const reply = new Promise<BbReply>((resolve) => {
    const onMessage = (m: BbReply): void => {
      if (m.id !== id) return;
      bbWorker.off("message", onMessage);
      resolve(m);
    };
    bbWorker.on("message", onMessage);
  });
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BB_CALL_TIMEOUT_MS);
  });
  bbWorker.postMessage({ id, ...r } satisfies BbRequest);
  const out = await Promise.race([reply, deadline]);
  clearTimeout(timer);
  return out;
}

const cases = buildCases(pub);
let ran = 0;
for (const c of cases) {
  let js: Verdict;
  let bbSeen: string;
  let bbPass: boolean;
  let parsed: ParsedRequest | undefined;
  let bbHung = false;
  try {
    parsed = parseRequest(c.body);
  } catch (err) {
    if (!(err instanceof MalformedRequest)) throw err;
  }
  if (!parsed) {
    js = "malformed";
    bbSeen = "n/a";
    bbPass = c.bb === "n/a";
  } else {
    const { publicKey, message, signature } = parsed;
    js = verifySchnorrGrumpkin(publicKey, message, signature) ? "valid" : "invalid";
    const bb = await bbVerify({ x: publicKey.x, y: publicKey.y, message, signature });
    if (bb === "timeout") {
      bbSeen = `no answer in ${BB_CALL_TIMEOUT_MS} ms`;
      bbPass = false;
      bbHung = true;
    } else if ("error" in bb) {
      bbSeen = `threw "${bb.error.slice(0, 70)}"`;
      bbPass = typeof c.bb === "object" && c.bb.throws.test(bb.error);
    } else {
      bbSeen = bb.valid ? "valid" : "invalid";
      bbPass = bbSeen === c.bb;
    }
  }
  const bbExpect = typeof c.bb === "string" ? c.bb : `throws ${c.bb.throws}`;
  check(`case ${c.label}: pure-JS=${js} (expect ${c.expect}) bb.js=${bbSeen} (expect ${bbExpect})`, js === c.expect && bbPass);
  ran++;
  // The worker is stuck in a synchronous call; nothing after this can be asked.
  if (bbHung) break;
}
check(`ran all ${cases.length} cases`, ran === cases.length);
await bbWorker.terminate();
process.exit(ok ? 0 : 1);
