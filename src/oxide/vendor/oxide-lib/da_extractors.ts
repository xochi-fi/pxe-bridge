// The withdrawal message hash log helpers that the relayer and the L1 observer use. The rest of this module is in `@oxide/oxide-lib-tee/da_extractors.js`, which this module re-exports.
// The enclave does not use this code, so a change here does not change the enclave PCR0.
import type { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import { DA_PAYLOAD_OFFSET, computeSiloedDaTag } from '../oxide-lib-tee/da_extractors.js';
import { TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG } from '../oxide-lib-tee/oxide_constants.gen.js';

export * from '../oxide-lib-tee/da_extractors.js';

/** The tag of the private logs that carry the withdrawal message hashes of `l2Token`, siloed with the token. */
export function computeSiloedWithdrawalMessageHashesTag(l2Token: AztecAddress): Promise<Fr> {
  return computeSiloedDaTag(l2Token, TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG);
}

/** The withdrawal message hashes of one DA log, given its emitted fields with the siloed tag first. */
export function decodeWithdrawalMessageHashesLog(fields: Fr[]): Fr[] {
  return fields.slice(DA_PAYLOAD_OFFSET);
}
