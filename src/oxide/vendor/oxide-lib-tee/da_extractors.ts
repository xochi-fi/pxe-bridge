import { Fr } from '@aztec-labs/aztec.js/fields';
import { MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX } from '@aztec-labs/constants';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { BlockHash } from '@aztec-labs/stdlib/block';
import { SiloedTag, Tag } from '@aztec-labs/stdlib/logs';

import {
  TEE_METADATA_DA_TAG,
  TEE_NOTES_DA_TAG,
  TEE_REQUIRED_NULLIFIERS_DA_TAG,
  TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
} from './oxide_constants.gen.js';
import type { TeeTxEffect } from './tx_effect_hint.js';
import { TEEMetadata } from './types.js';

/** Layout of each private log carrying a DA component (mirrors da.nr):
 *   fields[0]: DA tag, siloed by the protocol with the emitting contract
 *   fields[1..]: payload
 */
const DA_TAG_INDEX = 0;
export const DA_PAYLOAD_OFFSET = 1;

// TEEMetadata: pubKeyXHi, pubKeyXLo, pubKeyYHi, pubKeyYLo, anchorBlockHash, registrationLeafIndex — see types.ts.
const METADATA_SERIALIZED_LEN = 6;

export async function computeSiloedDaTag(contractAddress: AztecAddress, daTag: bigint): Promise<Fr> {
  return (await SiloedTag.computeFromTagAndApp(new Tag(new Fr(daTag)), contractAddress)).value;
}

/**
 * Finds the unique private log in `effect` carrying `daTag` siloed by `contractAddress`. Throws if zero or more
 * than one match is found, since we mirror the Noir contract's "exactly one" invariant.
 */
async function findTaggedDaComponentIndex(
  effect: TeeTxEffect,
  contractAddress: AztecAddress,
  daTag: bigint,
): Promise<number> {
  const siloedDaTag = await computeSiloedDaTag(contractAddress, daTag);
  let count = 0;
  let index = -1;
  for (let i = 0; i < effect.privateLogs.length; i++) {
    const log = effect.privateLogs[i];
    // The tag must sit in the emitted (blob-committed) prefix; a tag in unauthenticated padding does not count.
    if (log.emittedLength > DA_TAG_INDEX && log.fields[DA_TAG_INDEX].equals(siloedDaTag)) {
      count += 1;
      index = i;
    }
  }
  if (count !== 1) {
    throw new Error(`Expected exactly one DA component tagged ${siloedDaTag}, found ${count}`);
  }
  return index;
}

async function findAllTaggedDaComponents(
  effect: TeeTxEffect,
  contractAddress: AztecAddress,
  daTag: bigint,
): Promise<Fr[]> {
  const siloedTag = await computeSiloedDaTag(contractAddress, daTag);
  return effect.privateLogs
    .filter(log => log.emittedLength > DA_TAG_INDEX && log.fields[DA_TAG_INDEX].equals(siloedTag))
    .map(log => log.fields.slice(DA_PAYLOAD_OFFSET, log.emittedLength))
    .flat();
}

/** Returns tee notes emitted by `l2Token` in the effect.
 * @throws if more than MAX_NOTE_HASHES_PER_TX tee notes are emitted.
 */
export async function extractTeeNotes(effect: TeeTxEffect, l2Token: AztecAddress): Promise<Fr[]> {
  const notes = await findAllTaggedDaComponents(effect, l2Token, TEE_NOTES_DA_TAG);
  if (notes.length > MAX_NOTE_HASHES_PER_TX) {
    throw new Error(`Too many tee notes: ${notes.length} > ${MAX_NOTE_HASHES_PER_TX}`);
  }
  return notes;
}

/** Returns required nullifiers emitted by `l2Token` in the effect.
 * @throws if more than MAX_NULLIFIERS_PER_TX required nullifiers are emitted.
 */
export async function extractRequiredNullifiers(effect: TeeTxEffect, l2Token: AztecAddress): Promise<Fr[]> {
  const nullifiers = await findAllTaggedDaComponents(effect, l2Token, TEE_REQUIRED_NULLIFIERS_DA_TAG);
  if (nullifiers.length > MAX_NULLIFIERS_PER_TX) {
    throw new Error(`Too many required nullifiers: ${nullifiers.length} > ${MAX_NULLIFIERS_PER_TX}`);
  }
  return nullifiers;
}

/** Returns withdrawal message hashes emitted by `l2Token` in the effect.
 * @throws if more than MAX_L2_TO_L1_MSGS_PER_TX withdrawal message hashes are emitted.
 */
export async function extractWithdrawalMessageHashes(effect: TeeTxEffect, l2Token: AztecAddress): Promise<Fr[]> {
  const hashes = await findAllTaggedDaComponents(effect, l2Token, TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG);
  if (hashes.length > MAX_L2_TO_L1_MSGS_PER_TX) {
    throw new Error(`Too many withdrawal message hashes: ${hashes.length} > ${MAX_L2_TO_L1_MSGS_PER_TX}`);
  }
  return hashes;
}

export async function extractMetadata(effect: TeeTxEffect, l2Token: AztecAddress): Promise<TEEMetadata> {
  const index = await findTaggedDaComponentIndex(effect, l2Token, TEE_METADATA_DA_TAG);
  const log = effect.privateLogs[index];
  // The full payload must be emitted, otherwise we would read metadata from unauthenticated padding.
  if (log.emittedLength < DA_PAYLOAD_OFFSET + METADATA_SERIALIZED_LEN) {
    throw new Error(
      `Metadata DA log emits ${log.emittedLength} fields, need at least ${DA_PAYLOAD_OFFSET + METADATA_SERIALIZED_LEN}`,
    );
  }
  const [pubKeyXHi, pubKeyXLo, pubKeyYHi, pubKeyYLo, anchorBlockHash, registrationLeafIndex] = log.fields.slice(
    DA_PAYLOAD_OFFSET,
    DA_PAYLOAD_OFFSET + METADATA_SERIALIZED_LEN,
  );
  for (const half of [pubKeyXHi, pubKeyXLo, pubKeyYHi, pubKeyYLo]) {
    assertCanonicalKeyHalf(half);
  }
  return new TEEMetadata(
    pubKeyXHi,
    pubKeyXLo,
    pubKeyYHi,
    pubKeyYLo,
    new BlockHash(anchorBlockHash),
    registrationLeafIndex,
  );
}

/**
 * A published key half must fit the 16 bytes it was split into.
 */
function assertCanonicalKeyHalf(half: Fr): void {
  if (half.toBigInt() >> 128n !== 0n) {
    throw new Error(`Metadata DA public key half exceeds 16 bytes: ${half}`);
  }
}
