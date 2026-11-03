import { Fr } from '@aztec-labs/aztec.js/fields';

/** Bytes packed per field; 31 keeps every chunk below the BN254 modulus. */
export const BYTES_PER_FIELD = 31;

/**
 * Pack bytes into big-endian 31-byte field chunks. The exact byte length is not recoverable from the fields alone
 * (the final chunk is zero-padded), so it must travel alongside them. When `fieldCount` is given the result is
 * zero-padded up to it — the fixed array length a Noir broadcast argument needs; oversize input throws.
 */
export function packBytesToFields(bytes: Buffer, fieldCount?: number): Fr[] {
  const fields: Fr[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTES_PER_FIELD) {
    const chunk = Buffer.alloc(32);
    bytes.copy(chunk, 1, offset, Math.min(offset + BYTES_PER_FIELD, bytes.length));
    fields.push(Fr.fromBuffer(chunk));
  }
  if (fieldCount !== undefined) {
    if (fields.length > fieldCount) {
      throw new Error(`${bytes.length} bytes need ${fields.length} fields, over the ${fieldCount}-field capacity.`);
    }
    while (fields.length < fieldCount) {
      fields.push(Fr.ZERO);
    }
  }
  return fields;
}

/** Inverse of {@link packBytesToFields}: read `bytesLen` bytes back. `fields` may include the zero padding or omit it. */
export function unpackFieldsToBytes(bytesLen: number, fields: Fr[]): Buffer {
  const usedFields = Math.ceil(bytesLen / BYTES_PER_FIELD);
  if (fields.length < usedFields) {
    throw new Error(`a payload of ${bytesLen} bytes needs ${usedFields} fields, got ${fields.length}.`);
  }
  const bytes = Buffer.alloc(usedFields * BYTES_PER_FIELD);
  for (let i = 0; i < usedFields; i++) {
    fields[i].toBuffer().copy(bytes, i * BYTES_PER_FIELD, 1);
  }
  return bytes.subarray(0, bytesLen);
}

/**
 * Strict inverse of {@link packBytesToFields} for data that must round-trip exactly. Every field must have a zero high
 * byte. Returns all packed bytes, including the zero padding, so the caller checks where the payload ends.
 */
export function unpackFieldsToBytesStrict(fields: Fr[]): Buffer {
  const packed = Buffer.alloc(fields.length * BYTES_PER_FIELD);
  fields.forEach((field, i) => {
    const word = field.toBuffer();
    if (word[0] !== 0) {
      throw new Error(`Packed field ${i} has a non-zero high byte.`);
    }
    word.copy(packed, i * BYTES_PER_FIELD, 1);
  });
  return packed;
}
