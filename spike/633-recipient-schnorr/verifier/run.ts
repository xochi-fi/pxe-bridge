/**
 * Exercises verifier/schnorr-grumpkin.ts and cross-checks it against the SDK's
 * own bb.js implementation. The bb.js imports are HERE only, as a reference;
 * the verifier module itself imports neither.
 *
 *   1. Poseidon2 (pure JS) == bb.js poseidon2Hash on random inputs;
 *   2. the Noir library's own pinned constants: the DST derivation and the two
 *      pinned signature vectors (independent of bb.js and of this spike);
 *   3. the recipient's signatures from `public.json` (made in its own PXE
 *      process through the account's auth-witness provider): accepted under
 *      the descriptor's signing key, rejected under a wrong key, a wrong
 *      message and a tampered signature -- and bb.js agrees on every case.
 *
 *   npx tsx spike/633-recipient-schnorr/verifier/run.ts
 */
import { randomBytes } from "node:crypto";

import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash as bbPoseidon2 } from "@aztec/foundation/crypto/poseidon";
import { Schnorr, SchnorrSignature } from "@aztec/foundation/crypto/schnorr";
import { Point } from "@aztec/foundation/curves/grumpkin";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { z } from "zod";

import { readPublic } from "../common.js";
import {
  digestToField,
  FIELD_MODULUS,
  Grumpkin,
  SCHNORR_CHALLENGE_DST,
  verifySchnorrGrumpkin,
  type GrumpkinPoint,
} from "./schnorr-grumpkin.js";

let ok = true;
const check = (label: string, pass: boolean): void => {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  ok &&= pass;
};
const hex = (v: bigint, bytes = 32): string => v.toString(16).padStart(bytes * 2, "0");
const sigBytes = (s: bigint, e: bigint): Uint8Array => Buffer.from(hex(s) + hex(e), "hex");

/** The same question, asked of bb.js through @aztec/foundation. */
async function bbVerify(pk: GrumpkinPoint, message: bigint, sig: Uint8Array): Promise<boolean> {
  return new Schnorr().verifySignature(
    new Fr(message),
    new Point(new Fr(pk.x), new Fr(pk.y)),
    new SchnorrSignature(Buffer.from(sig)),
  );
}

async function both(label: string, pk: GrumpkinPoint, message: bigint, sig: Uint8Array, expect: boolean) {
  const js = verifySchnorrGrumpkin(pk, message, sig);
  const bb = await bbVerify(pk, message, sig);
  check(`${label}: standalone=${js} bb.js=${bb} expected=${expect}`, js === expect && bb === expect);
}

// 1. Poseidon2 parity
for (let i = 0; i < 20; i++) {
  const len = 1 + (i % 7);
  const inputs = Array.from({ length: len }, () => BigInt(`0x${randomBytes(32).toString("hex")}`) % FIELD_MODULUS);
  const bb = (await bbPoseidon2(inputs.map((v) => new Fr(v)))).toBigInt();
  if (poseidon2Hash(inputs) !== bb) check(`poseidon2 parity len=${len}`, false);
}
check("poseidon2 pure-JS == bb.js on 20 random inputs (lengths 1..7)", ok);

// 2. Noir-pinned constants
let packed = 0n;
let mul = 1n;
for (const b of Buffer.from("schnorr_grumpkin_poseidon2")) {
  packed += BigInt(b) * mul;
  mul *= 256n;
}
check("SCHNORR_CHALLENGE_DST == poseidon2([pack('schnorr_grumpkin_poseidon2')])", poseidon2Hash([packed]) === SCHNORR_CHALLENGE_DST);

const limbs = (lo: bigint, hi: bigint) => (hi << 128n) | lo;
const small = {
  pk: {
    x: 0x2c39bbbde2d0ffcb5c4317dcbfa1771cf554a2f33c647446632fa707a5bf5f3fn,
    y: 0x2b9c81935298af5ebe22f1a7279bb76781e6cadba3fb6c5c41ed942392dc687cn,
  },
  sig: sigBytes(
    limbs(0x5fd1ac0ad411110674830c54cb506212n, 0x281906862cdb4e0efec7226d757fe803n),
    limbs(0x6c368959f958e525d761d06c47fd2ad6n, 0x013f6a902c6c0efafdadbd4de409690dn),
  ),
  msg: 0x2bcn,
};
const large = {
  pk: {
    x: 0x065812e335a97c2108ea8cf4ccfe2f9dd6b117a0714f5e18461575be93f61da6n,
    y: 0x1a915003e8ec534f9a15d926a7ded478e178468ccc4f28e236e67450a55ac622n,
  },
  sig: sigBytes(
    limbs(0xf3bc3b7147acb9c621fd9f72dbf15ffan, 0x08599f379f0301dfefdbd0272554454dn),
    limbs(0x97065383ebbbd76620398792bd259bc2n, 0x2ceaee87f45b7a417f0ffb05451a8c92n),
  ),
  msg: 0x0123456789abcdef0fedcba9876543210123456789abcdef0fedcba987654321n,
};
await both("noir pinned_vector_small", small.pk, small.msg, small.sig, true);
await both("noir pinned_vector_large", large.pk, large.msg, large.sig, true);
await both("noir pinned_vector_large, message + 1", large.pk, large.msg + 1n, large.sig, false);
await both("noir pinned_vector_small sig under large key", large.pk, small.msg, small.sig, false);

// 3. The recipient's signatures
const hexStr = z.string().regex(/^0x[0-9a-f]+$/i);
const pub = z
  .object({
    recipientDescriptor: z.object({ constructorArgs: z.tuple([hexStr, hexStr]) }),
    recipientSignatures: z.array(z.object({ digest: hexStr, messageField: hexStr, signature: hexStr })).min(1),
  })
  .parse(readPublic());
const pk = {
  x: BigInt(pub.recipientDescriptor.constructorArgs[0]),
  y: BigInt(pub.recipientDescriptor.constructorArgs[1]),
};
const wrongKey = Grumpkin.BASE.multiply(BigInt(`0x${randomBytes(31).toString("hex")}`)).toAffine();
for (const [i, v] of pub.recipientSignatures.entries()) {
  const digest = Buffer.from(v.digest.slice(2), "hex");
  const field = digestToField(digest);
  check(`sig[${i}] digestToField(digest) == signer's message field (${v.digest.slice(0, 10)}..)`, field === BigInt(v.messageField));
  const sig = Buffer.from(v.signature.slice(2), "hex");
  await both(`sig[${i}] recipient key, right message`, pk, field, sig, true);
  await both(`sig[${i}] WRONG key`, wrongKey, field, sig, false);
  await both(`sig[${i}] WRONG message (field + 1)`, pk, (field + 1n) % FIELD_MODULUS, sig, false);
  const tampered = Uint8Array.from(sig);
  tampered[40]! ^= 1;
  await both(`sig[${i}] tampered e byte`, pk, field, tampered, false);
  // The digest itself (unreduced) is a different message whenever digest >= r.
  const raw = BigInt(v.digest);
  if (raw >= FIELD_MODULUS) {
    check(`sig[${i}] unreduced digest >= r is refused as a message (not silently reduced)`, !verifySchnorrGrumpkin(pk, raw, sig));
  }
}
const [a, b] = pub.recipientSignatures;
if (a && b) {
  await both("sig[0] checked against sig[1]'s message", pk, BigInt(b.messageField), Buffer.from(a.signature.slice(2), "hex"), false);
}

process.exit(ok ? 0 : 1);
