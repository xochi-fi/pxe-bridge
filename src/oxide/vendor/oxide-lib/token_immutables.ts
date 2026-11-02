import { Fr } from '@aztec-labs/aztec.js/fields';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import { DOM_SEP__TOKEN_IMMUTABLES } from './oxide_constants.gen.js';

export interface OxideTokenImmutables {
  portal: EthAddress;
  teeRegistry: EthAddress;
  /** At most 31 bytes of UTF-8. */
  name: string;
  /** At most 31 bytes of UTF-8. */
  symbol: string;
  decimals: number;
  /** The largest amount one note can hold. */
  maxNoteAmount: bigint;
}

/** The token instance's immutables hash. */
export async function computeTokenImmutablesHash(immutables: OxideTokenImmutables): Promise<Fr> {
  return await poseidon2HashWithSeparator(serializeTokenImmutables(immutables), DOM_SEP__TOKEN_IMMUTABLES);
}

/** The `store_immutables` argument in the ABI encoder's shape. */
export function tokenImmutablesAbiArg(immutables: OxideTokenImmutables) {
  return {
    portal: immutables.portal,
    // eslint-disable-next-line camelcase
    tee_registry: immutables.teeRegistry,
    name: { value: toFieldCompressedString(immutables.name) },
    symbol: { value: toFieldCompressedString(immutables.symbol) },
    decimals: immutables.decimals,
    // eslint-disable-next-line camelcase
    max_note_amount: immutables.maxNoteAmount,
  };
}

const FIELD_COMPRESSED_STRING_MAX_BYTES = 31;

/** Encodes `value` as a Noir `FieldCompressedString`. */
function toFieldCompressedString(value: string): Fr {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > FIELD_COMPRESSED_STRING_MAX_BYTES) {
    throw new Error(`"${value}" is ${bytes.length} bytes, more than ${FIELD_COMPRESSED_STRING_MAX_BYTES}`);
  }
  const padded = Buffer.alloc(Fr.SIZE_IN_BYTES);
  bytes.copy(padded, Fr.SIZE_IN_BYTES - FIELD_COMPRESSED_STRING_MAX_BYTES);
  return Fr.fromBuffer(padded);
}

function serializeTokenImmutables(immutables: OxideTokenImmutables): Fr[] {
  assertImmutablesShape(immutables);
  return [
    immutables.portal.toField(),
    immutables.teeRegistry.toField(),
    toFieldCompressedString(immutables.name),
    toFieldCompressedString(immutables.symbol),
    new Fr(immutables.decimals),
    new Fr(immutables.maxNoteAmount),
  ];
}

function assertImmutablesShape(immutables: OxideTokenImmutables) {
  if (!Number.isInteger(immutables.decimals) || immutables.decimals < 0 || immutables.decimals > 0xff) {
    throw new Error(`Token decimals ${immutables.decimals} do not fit in a u8`);
  }
  if (immutables.maxNoteAmount < 0n || immutables.maxNoteAmount >= 1n << 128n) {
    throw new Error(`Token max note amount ${immutables.maxNoteAmount} does not fit in a u128`);
  }
}
