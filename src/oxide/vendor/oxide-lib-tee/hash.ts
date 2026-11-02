import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { DomainSeparator } from '@aztec-labs/constants';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { siloNoteHash, siloNullifier } from '@aztec-labs/stdlib/hash';
import { computeAppNullifierHidingKey } from '@aztec-labs/stdlib/keys';
import { L1Actor, L1ToL2Message, L2Actor } from '@aztec-labs/stdlib/messaging';

import { getRegisterSignerContentHash } from './content_hash.js';
import {
  BALANCES_STORAGE_SLOT,
  PORTAL_CONSTANT_SECRET_HASH,
  TEE_REGISTRY_L2_RECIPIENT,
} from './oxide_constants.gen.js';
import type { PortalDomain, SecpPublicKey } from './types.js';

export async function computeSiloedNoteHash(args: {
  amount: bigint;
  owner: AztecAddress;
  randomness: Fr;
  l2Token: AztecAddress;
}) {
  const innerNoteHash = await poseidon2HashWithSeparator(
    [new Fr(args.amount), args.owner, BALANCES_STORAGE_SLOT, args.randomness],
    DomainSeparator.NOTE_HASH,
  );
  return siloNoteHash(args.l2Token, innerNoteHash);
}

export async function computeNoteNullifier(
  provenNoteHash: Fr,
  contractAddress: AztecAddress,
  masterNullifierHidingKey: GrumpkinScalar,
): Promise<Fr> {
  const appNullifierHidingKey = await computeAppNullifierHidingKey(masterNullifierHidingKey, contractAddress);
  const innerNullifier = await poseidon2HashWithSeparator(
    [provenNoteHash, appNullifierHidingKey],
    DomainSeparator.NOTE_NULLIFIER,
  );
  return await siloNullifier(contractAddress, innerNullifier);
}

export function computeSignerRegistrationMessageHash(
  portalDomain: Pick<PortalDomain, 'teeRegistry' | 'l1ChainId' | 'rollupVersion'>,
  publicKey: SecpPublicKey,
  leafIndex: Fr,
): Fr {
  return new L1ToL2Message(
    new L1Actor(portalDomain.teeRegistry, Number(portalDomain.l1ChainId)),
    new L2Actor(AztecAddress.fromBigIntUnsafe(TEE_REGISTRY_L2_RECIPIENT), Number(portalDomain.rollupVersion)),
    getRegisterSignerContentHash(publicKey),
    new Fr(PORTAL_CONSTANT_SECRET_HASH),
    leafIndex,
  ).hash();
}
