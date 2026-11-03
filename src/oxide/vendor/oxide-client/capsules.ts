import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX } from '@aztec-labs/constants';
import { padArrayEnd } from '@aztec-labs/foundation/collection';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { sha256ToField } from '@aztec-labs/foundation/crypto/sha256';
import type { BlockHash } from '@aztec-labs/stdlib/block';
import { Capsule } from '@aztec-labs/stdlib/tx';

import type { K1NoteSignature } from '../oxide-lib/types.js';
import { TEEMetadata, ZERO_K1_NOTE_SIGNATURE } from '../oxide-lib/types.js';
import { type WithdrawalRecoveryData, chunkRecoveryData } from '../oxide-lib/withdrawal_recovery_data.js';

import type { RegisteredSignTokenOperationOutput } from './types.js';

const SEED_CAPSULE_SLOT = sha256ToField([Buffer.from('OXIDE_TOKEN::RANDOMNESS_SEED')]);
const NOTE_SIGNATURE_CAPSULE_SLOT = sha256ToField([Buffer.from('OXIDE_TOKEN::NOTE_SIGNATURE')]);
const STRICT_MODE_CAPSULE_SLOT = sha256ToField([Buffer.from('OXIDE_TOKEN::STRICT_MODE_CAPSULE_SLOT')]);
const RECOVERY_CHUNKS_CAPSULE_SLOT = sha256ToField([Buffer.from('OXIDE_TOKEN::RECOVERY_CHUNKS')]);
const TEE_NOTES_DA_CAPSULE_KEY = sha256ToField([Buffer.from('oxideTeeNotesCapsuleKey')]);
const TEE_REQUIRED_NULLIFIERS_DA_CAPSULE_KEY = sha256ToField([Buffer.from('oxideTeeRequiredNullifiersCapsuleKey')]);
const TEE_METADATA_DA_CAPSULE_KEY = sha256ToField([Buffer.from('oxideTeeMetadataCapsuleKey')]);
const TEE_WITHDRAWAL_MESSAGE_HASHES_DA_CAPSULE_KEY = sha256ToField([
  Buffer.from('oxideTeeWithdrawalMessageHashesCapsuleKey'),
]);

export function buildSeedCapsule(contractAddress: AztecAddress): Capsule {
  return new Capsule(contractAddress, SEED_CAPSULE_SLOT, [Fr.random()]);
}

export async function buildNoteSignatureCapsule(
  contractAddress: AztecAddress,
  noteRandomness: Fr,
  signature: K1NoteSignature,
): Promise<Capsule> {
  const slot = await poseidon2Hash([NOTE_SIGNATURE_CAPSULE_SLOT, noteRandomness]);
  return new Capsule(contractAddress, slot, [signature.sLo, signature.sHi, signature.rLo, signature.rHi]);
}

/**
 * The note signature capsules of a send: the TEE signature of each created note, and a zero signature for each squashed
 * transient note. The contract still loads a signature for a transient note, but nothing checks it.
 */
export function buildNoteSignatureCapsules(
  contractAddress: AztecAddress,
  notes: { createdNotes: { randomness: Fr }[]; squashedTransientNotes: { randomness: Fr }[] },
  signatures: K1NoteSignature[],
): Promise<Capsule[]> {
  return Promise.all([
    ...notes.createdNotes.map((note, i) => buildNoteSignatureCapsule(contractAddress, note.randomness, signatures[i])),
    ...notes.squashedTransientNotes.map(note =>
      buildNoteSignatureCapsule(contractAddress, note.randomness, ZERO_K1_NOTE_SIGNATURE),
    ),
  ]);
}

/**
 * Strict-mode capsule: when present, the contract aborts if a per-note signature capsule is missing instead of
 * silently substituting zeros. Attach this on tx submission so a misconfigured TEE flow fails loudly; omit it on the
 * pre-submit simulate that we use to collect offchain effects (signatures aren't known yet).
 */
export function buildStrictModeCapsule(contractAddress: AztecAddress): Capsule {
  return new Capsule(contractAddress, STRICT_MODE_CAPSULE_SLOT, [Fr.ONE]);
}

/**
 * Builds the capsules of the recovery chunks of a tx's withdrawals. The chunks of the k-th withdrawal form a
 * `CapsuleArray` at `poseidon2([RECOVERY_CHUNKS_CAPSULE_SLOT, k])`.
 */
export async function buildRecoveryChunkCapsules(
  contractAddress: AztecAddress,
  recoveryData: WithdrawalRecoveryData[],
): Promise<Capsule[]> {
  const capsules = await Promise.all(
    recoveryData.map(async (data, k) =>
      buildCapsuleArray(
        contractAddress,
        await poseidon2Hash([RECOVERY_CHUNKS_CAPSULE_SLOT, new Fr(k)]),
        chunkRecoveryData(data),
      ),
    ),
  );
  return capsules.flat();
}

/** Lays out `elements` as aztec-nr's `CapsuleArray`: the length at `baseSlot`, and element `i` at `baseSlot + 1 + i`. */
function buildCapsuleArray(contractAddress: AztecAddress, baseSlot: Fr, elements: Fr[][]): Capsule[] {
  return [
    new Capsule(contractAddress, baseSlot, [new Fr(elements.length)]),
    ...elements.map((element, i) => new Capsule(contractAddress, baseSlot.add(new Fr(1 + i)), element)),
  ];
}

export function buildTeeNotesCapsule(contractAddress: AztecAddress, teeNotes: Fr[]): Capsule {
  return new Capsule(contractAddress, TEE_NOTES_DA_CAPSULE_KEY, [
    ...padArrayEnd(teeNotes, Fr.zero(), MAX_NOTE_HASHES_PER_TX),
    new Fr(teeNotes.length),
  ]);
}

export function buildTeeRequiredNullifiersCapsule(contractAddress: AztecAddress, requiredNullifiers: Fr[]): Capsule {
  return new Capsule(contractAddress, TEE_REQUIRED_NULLIFIERS_DA_CAPSULE_KEY, [
    ...padArrayEnd(requiredNullifiers, Fr.zero(), MAX_NULLIFIERS_PER_TX),
    new Fr(requiredNullifiers.length),
  ]);
}

export function buildTeeMetadataCapsule(contractAddress: AztecAddress, metadata: TEEMetadata): Capsule {
  return new Capsule(contractAddress, TEE_METADATA_DA_CAPSULE_KEY, metadata.toFields());
}

export function buildTeeWithdrawalMessageHashesCapsule(
  contractAddress: AztecAddress,
  withdrawalMessageHashes: Fr[],
): Capsule {
  return new Capsule(contractAddress, TEE_WITHDRAWAL_MESSAGE_HASHES_DA_CAPSULE_KEY, [
    ...padArrayEnd(withdrawalMessageHashes, Fr.zero(), MAX_L2_TO_L1_MSGS_PER_TX),
    new Fr(withdrawalMessageHashes.length),
  ]);
}

/** The capsules of the `publish_da` call: the DA components that the TEE signed, and its metadata. */
export function buildPublishDaCapsules(
  contractAddress: AztecAddress,
  signOutput: RegisteredSignTokenOperationOutput,
  anchorBlockHash: BlockHash,
): Capsule[] {
  return [
    buildTeeNotesCapsule(contractAddress, signOutput.teeNotes),
    buildTeeRequiredNullifiersCapsule(contractAddress, signOutput.requiredNullifiers),
    buildTeeMetadataCapsule(
      contractAddress,
      TEEMetadata.fromPublicKey(signOutput.publicKey, anchorBlockHash, new Fr(signOutput.registrationLeafIndex)),
    ),
    buildTeeWithdrawalMessageHashesCapsule(contractAddress, signOutput.withdrawalMessageHashes),
  ];
}
