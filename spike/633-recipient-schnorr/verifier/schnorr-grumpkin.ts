/**
 * Standalone verifier for the SchnorrAccount signature scheme (Schnorr over
 * Grumpkin with a Poseidon2 challenge), in plain TypeScript: no PXE, no
 * @aztec/* import, no bb.js, no WASM. Two dependencies, both pure JS:
 * @noble/curves (Grumpkin as a short-Weierstrass curve) and
 * @zkpassport/poseidon2 (BN254 Poseidon2, t = 4).
 *
 * Mirrors noir-lang/schnorr v0.4.0 `verify_signature`, the function the
 * SchnorrAccount artifact (aztec 5.2.0) calls from `is_valid_impl`:
 *
 *   R = s*G + e*P,  accept iff P on curve, s != 0, e != 0, R != O and
 *   Poseidon2([SCHNORR_CHALLENGE_DST, R.x, P.x, P.y, message]) == e
 *
 * Deliberately STRICTER than the circuit on encodings, never looser: it
 * refuses s >= n, e >= r, message >= r and coordinates >= r, which the honest
 * signer never produces. Reading lib.nr: in-circuit, s feeds multi_scalar_mul
 * mod n, so s and s + n give the same R and both verify; e is compared to the
 * challenge as lo + hi * 2^128 in Field, so e + r passes that comparison but
 * also changes e*P. Do not use signature bytes as an identifier. Every strict
 * branch is a case in cases.ts, with bb.js's verdict on the same input.
 */
import { weierstrassN } from "@noble/curves/abstract/weierstrass";
import { poseidon2Hash } from "@zkpassport/poseidon2";

/** BN254 scalar field r = Grumpkin base field = Noir `Field`. */
export const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
/** BN254 base field q = Grumpkin group order. */
export const GRUMPKIN_ORDER = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

/** y^2 = x^3 - 17 over Fr, generator (1, sqrt(-16)) = Noir EmbeddedCurvePoint::generator(). */
export const Grumpkin = weierstrassN({
  p: FIELD_MODULUS,
  n: GRUMPKIN_ORDER,
  h: 1n,
  a: 0n,
  b: FIELD_MODULUS - 17n,
  Gx: 1n,
  Gy: 0x0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272cn,
});

/** poseidon2_hash_bytes("schnorr_grumpkin_poseidon2"), pinned in the Noir library. */
export const SCHNORR_CHALLENGE_DST =
  0x024c76938ed06b8ec1d9094b1013d190baa4011372f0604643bda812a63b832en;

export interface GrumpkinPoint {
  x: bigint;
  y: bigint;
}

/**
 * @param publicKey the account's signing key, i.e. the SchnorrAccount
 *   constructor arguments (signing_pub_key_x, signing_pub_key_y)
 * @param message a field element < r
 * @param signature 64 bytes, s || e, each big-endian
 */
export function verifySchnorrGrumpkin(
  publicKey: GrumpkinPoint,
  message: bigint,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64 || message < 0n || message >= FIELD_MODULUS) return false;
  let s = 0n;
  let e = 0n;
  for (let i = 0; i < 32; i++) {
    s = (s << 8n) | BigInt(signature[i]!);
    e = (e << 8n) | BigInt(signature[32 + i]!);
  }
  if (s === 0n || e === 0n || s >= GRUMPKIN_ORDER || e >= FIELD_MODULUS) return false;

  let P;
  try {
    P = Grumpkin.fromAffine(publicKey);
    P.assertValidity();
  } catch {
    return false;
  }
  const R = Grumpkin.BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(e));
  if (R.is0()) return false;
  const challenge = poseidon2Hash([
    SCHNORR_CHALLENGE_DST,
    R.toAffine().x,
    publicKey.x,
    publicKey.y,
    message,
  ]);
  return challenge === e;
}

/**
 * PROVISIONAL reduction of a 32-byte digest (e.g. an EIP-712 digest) into the
 * message field: big-endian integer mod r. Matches Fr.fromBufferReduce in
 * @aztec/foundation, which is what the spike's signer used. Throws unless the
 * digest is exactly 32 bytes, so 00 || d never maps to the same field as d.
 */
export function digestToField(digest: Uint8Array): bigint {
  if (digest.length !== 32) throw new Error(`digest must be 32 bytes, got ${digest.length}`);
  let v = 0n;
  for (const b of digest) v = (v << 8n) | BigInt(b);
  return v % FIELD_MODULUS;
}
