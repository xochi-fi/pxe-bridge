// The withdrawal hashes that clients and the L1 observer use. The rest of this module is in `@oxide/oxide-lib-tee/hash.js`, which this module re-exports.
// The enclave does not use this code, so a change here does not change the enclave PCR0.
import { Fr } from '@aztec-labs/aztec.js/fields';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { sha256 } from '@aztec-labs/foundation/crypto/sha256';
import { computeL2ToL1MessageHash } from '@aztec-labs/stdlib/hash';
import type { TxHash } from '@aztec-labs/stdlib/tx';

import { getWithdrawContentHash } from '../oxide-lib-tee/content_hash.js';
import type { OutboxWithdrawal, PortalDomain } from '../oxide-lib-tee/types.js';

export * from '../oxide-lib-tee/hash.js';

export function computeWithdrawMessageHash(portalDomain: PortalDomain, withdrawal: OutboxWithdrawal): Fr {
  return computeL2ToL1MessageHash({
    l2Sender: portalDomain.l2Token,
    l1Recipient: portalDomain.l1Portal,
    content: getWithdrawContentHash(
      withdrawal.executor,
      withdrawal.userPayloadHash,
      withdrawal.amount,
      withdrawal.proverTip,
      withdrawal.randomness,
    ),
    rollupVersion: new Fr(portalDomain.rollupVersion),
    chainId: new Fr(portalDomain.l1ChainId),
  });
}

/**
 * The id `OxidePortal.$isWithdrawalSpent` records for a withdrawal: `sha256(creation_tx_hash || message_hash)`.
 * The TEE computes the same value when it signs the finalization (`tee-enclave/src/signer.ts`).
 */
export function computeWithdrawalId(creationTxHash: TxHash, messageHash: Fr): Buffer32 {
  return new Buffer32(sha256(Buffer.concat([creationTxHash.toBuffer(), messageHash.toBuffer()])));
}
