// Mirror of `noir-projects/refund_lib/src/migration_signature.nr`
import { Fr } from '@aztec-labs/aztec.js/fields';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import type { Point } from '@aztec-labs/foundation/curves/grumpkin';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { type PublicKeys, hashPublicKey } from '@aztec-labs/stdlib/keys';

import {
  type AccountInstancePreimage,
  type PasskeyPublicKey,
  type WebAuthnAuth,
  computeAccountAddress,
  computePasskeyHash,
  computePasskeySetImmutablesHash,
  verifyWebAuthnAuth,
} from './account_address.js';
import { verifyGrumpkinPoseidonSignature } from './grumpkin_schnorr_signature.js';
import { DOM_SEP__MIGRATION } from './oxide_constants.gen.js';
import type { GrumpkinPoseidonSignature } from './types.js';

export function computeRefundCommitment(executor: EthAddress, userPayloadHash: Fr): Promise<Fr> {
  return poseidon2Hash([new Fr(DOM_SEP__MIGRATION), executor.toField(), userPayloadHash]);
}

export interface PasskeyMigrationSignature {
  kind: 'passkey';
  passkey: PasskeyPublicKey;
  passkeySet: Fr[];
  webauthn: WebAuthnAuth;
}

export interface FallbackKeyMigrationSignature {
  kind: 'fallbackKey';
  fbpkM: Point;
  fallbackSignature: GrumpkinPoseidonSignature;
}

export type MigrationSignature = PasskeyMigrationSignature | FallbackKeyMigrationSignature;

/** Mirrors `refund_lib::assert_valid_migration_signature`, with the same error messages. */
export async function assertValidMigrationSignature(
  owner: AztecAddress,
  publicKeys: PublicKeys,
  instance: AccountInstancePreimage,
  executor: EthAddress,
  userPayloadHash: Fr,
  signature: MigrationSignature,
): Promise<void> {
  // 1. Constrain that correct mode is used against the owner address
  const immutablesHash =
    signature.kind === 'passkey' ? await computePasskeySetImmutablesHash(signature.passkeySet) : Fr.ZERO;
  if (!(await computeAccountAddress(publicKeys, instance, immutablesHash)).equals(owner)) {
    throw new Error('migration signature does not match owner address');
  }

  // 2. Verify the signature using the relevant mode
  const refundCommitment = await computeRefundCommitment(executor, userPayloadHash);
  if (signature.kind === 'passkey') {
    // 2.a Verify pass key signature

    // 2.a.1 Check the pass key public key is part of address preimage
    const passkeyHash = await computePasskeyHash(signature.passkey);
    if (!signature.passkeySet.some(slot => slot.equals(passkeyHash))) {
      throw new Error("passkey is not in the owner's passkey set");
    }

    // 2.a.2 Verify the pass key signature
    if (!(await verifyWebAuthnAuth(signature.passkey, refundCommitment, signature.webauthn))) {
      throw new Error('invalid WebAuthn signature');
    }
  } else {
    // 2.b Check correct key was used and verify the signature over refund commitment
    if (!(await hashPublicKey(signature.fbpkM)).equals(publicKeys.fbpkMHash)) {
      throw new Error("fbpk_m does not match owner's fbpk_m_hash");
    }
    if (!(await verifyGrumpkinPoseidonSignature(signature.fbpkM, signature.fallbackSignature, refundCommitment))) {
      throw new Error('invalid fallback-key signature');
    }
  }
}
