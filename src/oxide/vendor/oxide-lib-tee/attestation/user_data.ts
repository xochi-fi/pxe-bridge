// TS mirror of `TEERegistrationLib._userDataDigest` in
// `l1-contracts/src/core/lib/TEERegistrationLib.sol`.
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { sha256 } from '@aztec-labs/foundation/crypto/sha256';
import { zodFor } from '@aztec-labs/foundation/schemas';
import { isHex } from '@aztec-labs/foundation/string';

import { z } from 'zod4';

/// 12 bytes ASCII. Must match `TEERegistrationLib.ATTESTATION_USER_DATA_DOMAIN`.
export const ATTESTATION_USER_DATA_DOMAIN = Buffer.from('oxide-tee/v1', 'ascii');

export interface UserData {
  /** Secp256k1 pubkey X coordinate (32 bytes BE). */
  publicKeyX: Buffer32;
  /** Secp256k1 pubkey Y coordinate (32 bytes BE). */
  publicKeyY: Buffer32;
  /** P-256 encryption pubkey X coordinate (32 bytes BE). */
  encPubKeyX: Buffer32;
  /** P-256 encryption pubkey Y coordinate (32 bytes BE). */
  encPubKeyY: Buffer32;
}

export function serializeUserData(userData: UserData): Buffer {
  return Buffer.concat([
    ATTESTATION_USER_DATA_DOMAIN,
    userData.publicKeyX.toBuffer(),
    userData.publicKeyY.toBuffer(),
    userData.encPubKeyX.toBuffer(),
    userData.encPubKeyY.toBuffer(),
  ]);
}

/**
 * Compute the SHA-256 commitment the enclave is expected to publish in `user_data`. Pass the
 * result as `expectedUserData` to `verifyNitroAttestation`, or compare it directly to a parsed
 * Nitro attestation's `user_data` field. `verifyTeeAttestation` calls this internally.
 */
export function computeAttestationUserData(userData: UserData): Buffer {
  return sha256(serializeUserData(userData));
}

// TODO(alvaro): `schemas.Buffer32` upstream is `z.string().transform(Buffer32.fromString)`. `Buffer32.fromString`
// reads `this.SIZE`, so zod calling it unbound as `effect.transform(...)` makes `this` the effect
// descriptor and the length check always blows up with "Expected NaN characters long". Wrap the
// static call in an arrow so the class context is preserved. Drop this and use `schemas.Buffer32`
// once upstream switches to `Buffer32.SIZE` (or a bound reference).
const buffer32Schema = z
  .string()
  .refine(isHex, 'Not a valid hex string')
  .transform(s => Buffer32.fromString(s));

export const userDataSchema = zodFor<UserData>()(
  z.object({
    publicKeyX: buffer32Schema,
    publicKeyY: buffer32Schema,
    encPubKeyX: buffer32Schema,
    encPubKeyY: buffer32Schema,
  }),
);
