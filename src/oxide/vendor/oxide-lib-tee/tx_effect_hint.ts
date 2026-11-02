import { decodeTxStartMarker, encodePrivateLogsBlobFields } from '@aztec-labs/blob-lib/encoding';
import { DomainSeparator, PRIVATE_LOG_SIZE_IN_FIELDS } from '@aztec-labs/constants';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { PrivateLog } from '@aztec-labs/stdlib/logs';
import { type TxEffect, TxHash, computeTxEffectsTreeLeaf } from '@aztec-labs/stdlib/tx';

import type { TxEffectHintData } from './types.js';

/** The fields of a tx effect that the enclave reads. */
export type TeeTxEffect = Pick<TxEffect, 'txHash' | 'noteHashes' | 'nullifiers' | 'l2ToL1Msgs' | 'privateLogs'>;

/** Hashes one tx effect category as stdlib does. An empty category hashes to zero. */
export function computeTxEffectCategoryHash(preimage: Fr[]): Promise<Fr> {
  return preimage.length === 0
    ? Promise.resolve(Fr.ZERO)
    : poseidon2HashWithSeparator(preimage, DomainSeparator.TX_EFFECT_CATEGORY_HASH);
}

/** Decodes a hint to the fields that the enclave reads. Throws if a count does not match the tx start marker. */
export function decodeTxEffectHint(data: TxEffectHintData): TeeTxEffect {
  const marker = decodeTxStartMarker(data.txStartMarker);
  const requireCount = (name: string, sent: number, declared: number) => {
    if (sent !== declared) {
      throw new Error(`${name}: ${sent} sent, tx start marker declares ${declared}`);
    }
  };
  requireCount('noteHashes', data.noteHashes.length, marker.numNoteHashes);
  requireCount('nullifiers', data.nullifiers.length, marker.numNullifiers);
  requireCount('l2ToL1Msgs', data.l2ToL1Msgs.length, marker.numL2ToL1Msgs);
  requireCount('privateLogs', data.privateLogs.length, marker.numPrivateLogs);
  const privateLogsLength = data.privateLogs.reduce((acc, log) => acc + log.length, 0);
  requireCount('privateLogs fields', privateLogsLength, marker.privateLogsLength);
  for (const log of data.privateLogs) {
    if (log.length > PRIVATE_LOG_SIZE_IN_FIELDS) {
      throw new Error(`private log has ${log.length} fields, maximum is ${PRIVATE_LOG_SIZE_IN_FIELDS}`);
    }
  }
  return {
    txHash: TxHash.fromField(data.txHash),
    noteHashes: data.noteHashes,
    nullifiers: data.nullifiers,
    l2ToL1Msgs: data.l2ToL1Msgs,
    privateLogs: data.privateLogs.map(fields => PrivateLog.fromBlobFields(fields.length, fields)),
  };
}

/** Computes the tx effects tree leaf of a hint, as `TxEffect.computeTxEffectsTreeLeaf` does. */
export async function computeTxEffectLeafFromHint(data: TxEffectHintData): Promise<Fr> {
  const [noteHashes, nullifiers, l2ToL1Msgs, privateLogs] = await Promise.all([
    computeTxEffectCategoryHash(data.noteHashes),
    computeTxEffectCategoryHash(data.nullifiers),
    computeTxEffectCategoryHash(data.l2ToL1Msgs),
    computeTxEffectCategoryHash(encodePrivateLogsBlobFields(data.privateLogs)),
  ]);
  const categoriesHash = await poseidon2HashWithSeparator(
    [
      data.txStartMarker,
      data.transactionFee,
      noteHashes,
      nullifiers,
      l2ToL1Msgs,
      data.publicDataWritesHash,
      privateLogs,
      data.publicLogsHash,
      data.contractClassLogHash,
    ],
    DomainSeparator.TX_EFFECT_CATEGORIES_HASH,
  );
  return computeTxEffectsTreeLeaf(TxHash.fromField(data.txHash), categoriesHash);
}
