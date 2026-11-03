// Modified for pxe-bridge (see ../VENDORED.md): L1SubmitContext and its
// @oxide/l1-contracts import removed; the L1 finalize helpers are not vendored.
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import type { SecpPublicKey, SignTokenOperationOutput, TeeSigner, TokenOperation } from '../oxide-lib/types.js';

/** A client-side handle to an enclave registered on a `TeeRegistry`. */
export interface RegisteredTeeSigner extends TeeSigner {
  readonly teeRegistry: EthAddress;
  signTokenOperation(operation: TokenOperation): Promise<RegisteredSignTokenOperationOutput>;
}

/**
 * The output plus the key and leaf index of the enclave that signed it. These can differ from the signer's current
 * ones, because a `FleetSigner` can switch enclaves at any time.
 */
export type RegisteredSignTokenOperationOutput = SignTokenOperationOutput & {
  publicKey: SecpPublicKey;
  registrationLeafIndex: bigint;
};
