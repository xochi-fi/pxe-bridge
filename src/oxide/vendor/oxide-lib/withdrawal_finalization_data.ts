import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { BufferReader } from '@aztec-labs/foundation/serialize';

import { getUserPayloadHash, getWithdrawContentHash } from './content_hash.js';
import type { K1NoteSignature, OutboxWithdrawal } from './types.js';

/**
 * The preimage of the withdrawal message and the TEE signature from the initiation. The L2 to L1 message content is
 * only the hash of the preimage (`getWithdrawContentHash`), so the client also sends the encoded values in:
 * - a finalization request: the calldata of an L1 operation in the initiation tx, public for relayers and provers;
 * - recovery data (`withdrawal_recovery_data.ts`): encrypted to the owner.
 */
export interface WithdrawalFinalizationData {
  executor: EthAddress;
  amount: bigint;
  proverTip: bigint;
  randomness: Fr;
  /** The TEE signature of the withdrawal, from the initiation. */
  withdrawalSignature: K1NoteSignature;
  userPayload: Buffer;
}

export function toOutboxWithdrawal(data: WithdrawalFinalizationData): OutboxWithdrawal {
  return {
    executor: data.executor,
    userPayloadHash: getUserPayloadHash(data.userPayload),
    amount: data.amount,
    proverTip: data.proverTip,
    randomness: data.randomness,
  };
}

export function getFinalizationDataContentHash(data: WithdrawalFinalizationData): Fr {
  const w = toOutboxWithdrawal(data);
  return getWithdrawContentHash(w.executor, w.userPayloadHash, w.amount, w.proverTip, w.randomness);
}

/** Fixed-width integers keep the encoded size unchanged when the TEE supplies randomness and a signature. */
export function encodeFinalizationData(data: WithdrawalFinalizationData): Buffer {
  assertFinalizationDataValues(data);
  const { sLo, sHi, rLo, rHi } = data.withdrawalSignature;
  return Buffer.concat([
    data.executor.toBuffer(),
    encodeUint128(data.amount),
    encodeUint128(data.proverTip),
    data.randomness.toBuffer(),
    ...[sLo, sHi, rLo, rHi].map(half => encodeUint128(half.toBigInt())),
    encodeLengthPrefixed(data.userPayload, 'Withdrawal user payload'),
  ]);
}

export function decodeFinalizationData(bytes: Buffer): WithdrawalFinalizationData {
  const reader = new BufferReader(bytes);
  const data = readFinalizationData(reader);
  if (!reader.isEmpty()) {
    throw new Error('Trailing bytes in withdrawal finalization data.');
  }
  return data;
}

/** Read one encoding and stop at its end. The encoding gives its own length, so more data can follow it. */
export function readFinalizationData(reader: BufferReader): WithdrawalFinalizationData {
  const data = {
    executor: EthAddress.fromBuffer(reader.readBytes(20)),
    amount: reader.readUInt128(),
    proverTip: reader.readUInt128(),
    randomness: Fr.fromBuffer(reader.readBytes(32)),
    withdrawalSignature: {
      sLo: new Fr(reader.readUInt128()),
      sHi: new Fr(reader.readUInt128()),
      rLo: new Fr(reader.readUInt128()),
      rHi: new Fr(reader.readUInt128()),
    },
    userPayload: readLengthPrefixed(reader),
  };
  assertFinalizationDataValues(data);
  return data;
}

/** Length-prefixed bytes, at most 65535: a big-endian u16 length, then the bytes. `label` names them in the error. */
export function encodeLengthPrefixed(bytes: Buffer, label: string): Buffer {
  if (bytes.length > 0xffff) {
    throw new Error(`${label} must fit in 65535 bytes.`);
  }
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** Read the bytes that {@link encodeLengthPrefixed} writes. */
export function readLengthPrefixed(reader: BufferReader): Buffer {
  return reader.readBytes(reader.readUInt16());
}

function assertFinalizationDataValues(data: WithdrawalFinalizationData): void {
  if (data.executor.equals(EthAddress.ZERO)) {
    throw new Error('Withdrawal executor must not be zero.');
  }
  if (data.proverTip < 0n || data.proverTip > data.amount) {
    throw new Error('Withdrawal prover tip exceeds the amount.');
  }
}

function encodeUint128(value: bigint): Buffer {
  if (value < 0n || value >= 1n << 128n) {
    throw new Error('Withdrawal integer must fit in 128 bits.');
  }
  return new Fr(value).toBuffer().subarray(16);
}
