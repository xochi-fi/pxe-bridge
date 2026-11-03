// The user payload hash that clients use. The rest of this module is in `@oxide/oxide-lib-tee/content_hash.js`, which this module re-exports.
// The enclave does not use this code, so a change here does not change the enclave PCR0.
import { sha256ToField } from '@aztec-labs/foundation/crypto/sha256';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';

export * from '../oxide-lib-tee/content_hash.js';

export function getUserPayloadHash(userPayload: Buffer): Fr {
  return sha256ToField([userPayload]);
}
