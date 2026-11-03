// The conversion from a tx effect to its hint, which the wallet uses. The rest of this module is in `@oxide/oxide-lib-tee/tx_effect_hint.js`, which this module re-exports.
// The enclave does not use this code, so a change here does not change the enclave PCR0.
import { encodePublicDataWritesBlobFields, encodeTxStartMarker } from '@aztec-labs/blob-lib/encoding';
import type { TxEffect } from '@aztec-labs/stdlib/tx';

import { computeTxEffectCategoryHash } from '../oxide-lib-tee/tx_effect_hint.js';
import type { TxEffectHintData } from '../oxide-lib-tee/types.js';

export * from '../oxide-lib-tee/tx_effect_hint.js';

/**
 * Converts a tx effect to the hint that the wallet sends. The public data writes, the public logs and the contract
 * class logs are sent only as their category hashes.
 */
export async function toTxEffectHintData(effect: TxEffect): Promise<TxEffectHintData> {
  const blob = effect.toTxBlobData();
  // The class log category hash is over the log hash, not over the blob fields of the log.
  const contractClassLogPreimage = (
    await Promise.all(effect.contractClassLogs.map(async log => [log.contractAddress.toField(), await log.hash()]))
  ).flat();
  const [publicDataWritesHash, publicLogsHash, contractClassLogHash] = await Promise.all([
    computeTxEffectCategoryHash(encodePublicDataWritesBlobFields(blob.publicDataWrites)),
    computeTxEffectCategoryHash(blob.publicLogs),
    computeTxEffectCategoryHash(contractClassLogPreimage),
  ]);
  return {
    txStartMarker: encodeTxStartMarker(blob.txStartMarker),
    txHash: blob.txHash,
    transactionFee: blob.transactionFee,
    noteHashes: blob.noteHashes,
    nullifiers: blob.nullifiers,
    l2ToL1Msgs: blob.l2ToL1Msgs,
    privateLogs: blob.privateLogs,
    publicDataWritesHash,
    publicLogsHash,
    contractClassLogHash,
  };
}
