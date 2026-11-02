// TS mirror of the content hashes in `oxide_token_lib/src/content_hash.nr`.
import { keccak256 } from '@aztec-labs/foundation/crypto/keccak';
import { sha256ToField } from '@aztec-labs/foundation/crypto/sha256';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import type { SecpPublicKey } from './types.js';

const MAX_U128 = (1n << 128n) - 1n;

/** L1->L2 signer-registration message content hash. Must match `TeeRegistry.sol::_recordTee`. */
export function getRegisterSignerContentHash(publicKey: SecpPublicKey): Fr {
  const selector = keccak256(Buffer.from('register_signer(bytes32,bytes32)')).subarray(0, 4);
  return sha256ToField([Buffer.concat([selector, publicKey.x.toBuffer(), publicKey.y.toBuffer()])]);
}

export function getWithdrawContentHash(
  executor: EthAddress,
  userPayloadHash: Fr,
  amount: bigint,
  proverTip: bigint,
  randomness: Fr,
): Fr {
  assertU128('amount', amount);
  assertU128('proverTip', proverTip);
  const selector = keccak256(Buffer.from('withdraw(address,bytes32,uint256,uint256,uint256)')).subarray(0, 4);
  const bytes = Buffer.concat([
    selector,
    executor.toField().toBuffer(),
    userPayloadHash.toBuffer(),
    new Fr(amount).toBuffer(),
    new Fr(proverTip).toBuffer(),
    randomness.toBuffer(),
  ]);
  return sha256ToField([bytes]);
}

function assertU128(name: string, value: bigint): void {
  if (value < 0n || value > MAX_U128) {
    throw new Error(`${name} must fit in u128, got ${value}.`);
  }
}
