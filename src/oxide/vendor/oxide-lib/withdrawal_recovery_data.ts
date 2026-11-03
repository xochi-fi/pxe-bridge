import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { BufferReader } from '@aztec-labs/foundation/serialize';

import { BYTES_PER_FIELD, packBytesToFields, unpackFieldsToBytesStrict } from './field_bytes.js';
import {
  type WithdrawalFinalizationData,
  encodeFinalizationData,
  encodeLengthPrefixed,
  readFinalizationData,
  readLengthPrefixed,
} from './withdrawal_finalization_data.js';

/** Application fields in a private event for the pinned Aztec release. */
export const RECOVERY_CHUNK_FIELDS = 10;
export const RECOVERY_CHUNK_BYTES = RECOVERY_CHUNK_FIELDS * BYTES_PER_FIELD;

/** The data that a withdrawal emits, encrypted, to its owner. */
export interface WithdrawalRecoveryData {
  finalizationData: WithdrawalFinalizationData;
  memo: Buffer;
}

/** Split the recovery data of a withdrawal into the chunks of its `WithdrawalRecoveryChunk` events. */
export function chunkRecoveryData({ finalizationData, memo }: WithdrawalRecoveryData): Fr[][] {
  const bytes = Buffer.concat([
    encodeFinalizationData(finalizationData),
    encodeLengthPrefixed(memo, 'Withdrawal recovery memo'),
  ]);
  const chunks: Fr[][] = [];
  for (let offset = 0; offset < bytes.length; offset += RECOVERY_CHUNK_BYTES) {
    chunks.push(packBytesToFields(bytes.subarray(offset, offset + RECOVERY_CHUNK_BYTES), RECOVERY_CHUNK_FIELDS));
  }
  return chunks;
}

export function assembleRecoveryData(chunks: Fr[][]): WithdrawalRecoveryData[] {
  const reader = new BufferReader(Buffer.concat(chunks.map(unpackChunk)));
  const assembled: WithdrawalRecoveryData[] = [];
  while (!reader.isEmpty()) {
    const finalizationData = readFinalizationData(reader);
    assembled.push({ finalizationData, memo: readLengthPrefixed(reader) });
    // All chunks have the same length, so the remainder is the padding to the end of this chunk.
    const padding = reader.readBytes(reader.remainingBytes() % RECOVERY_CHUNK_BYTES);
    if (padding.some(byte => byte !== 0)) {
      throw new Error('Withdrawal recovery data has non-zero padding.');
    }
  }
  return assembled;
}

function unpackChunk(fields: Fr[]): Buffer {
  if (fields.length !== RECOVERY_CHUNK_FIELDS) {
    throw new Error(`A recovery chunk must contain ${RECOVERY_CHUNK_FIELDS} fields.`);
  }
  return unpackFieldsToBytesStrict(fields);
}
