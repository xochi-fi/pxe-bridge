import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { GrumpkinScalar, type Point } from '@aztec-labs/foundation/curves/grumpkin';

import type { GrumpkinPoseidonSignature } from './types.js';

const TWO_POW_128 = 1n << 128n;

/**
 * Domain-separation tag from `noir-lang/schnorr`.
 */
export const SCHNORR_CHALLENGE_DST = Fr.fromString(
  '0x024c76938ed06b8ec1d9094b1013d190baa4011372f0604643bda812a63b832e',
);

/**
 * Verify a Grumpkin-Schnorr-Poseidon2 signature over `message` under `publicKey`.
 *
 * Mirrors `schnorr::assert_valid_signature` of `noir-lang/schnorr`.
 */
export async function verifyGrumpkinPoseidonSignature(
  publicKey: Point,
  signature: GrumpkinPoseidonSignature,
  message: Fr,
): Promise<boolean> {
  const sBig = signature.sLo.toBigInt() + signature.sHi.toBigInt() * TWO_POW_128;
  const eBig = signature.eLo.toBigInt() + signature.eHi.toBigInt() * TWO_POW_128;
  const sigS = new GrumpkinScalar(sBig);
  const sigE = new GrumpkinScalar(eBig);

  // R = s*G + e*PK
  const sG = await Grumpkin.mul(Grumpkin.generator, sigS);
  const ePK = await Grumpkin.mul(publicKey, sigE);
  const R = await Grumpkin.add(sG, ePK);

  const ePrime = await poseidon2Hash([SCHNORR_CHALLENGE_DST, R.x, publicKey.x, publicKey.y, message]);
  return ePrime.toBigInt() === eBig;
}
