// The enclave L1 address derivation that clients and the registrar use. The rest of this module is in `@oxide/oxide-lib-tee/attestation/user_data.js`, which this module re-exports.
// The enclave does not use this code, so a change here does not change the enclave PCR0.
import { keccak256 } from '@aztec-labs/foundation/crypto/keccak';
import { EthAddress } from '@aztec-labs/stdlib/block';

import type { SecpPublicKey } from '../../oxide-lib-tee/types.js';

export * from '../../oxide-lib-tee/attestation/user_data.js';

/**
 * Derive an enclave's L1 eth address from its attested secp256k1 pubkey. Mirrors the on-chain
 * derivation `address(uint160(uint256(keccak256(abi.encodePacked(pubKeyX, pubKeyY)))))` in
 * `TEERegistrationLib.sol` — the `TeeRegistry`'s key for the enclave, and the identity the fleet router
 * addresses sealed calls by.
 */
export function ethAddressFromSecpPublicKey(publicKey: SecpPublicKey): EthAddress {
  const hash = keccak256(Buffer.concat([publicKey.x.toBuffer(), publicKey.y.toBuffer()]));
  return new EthAddress(hash.subarray(12));
}
