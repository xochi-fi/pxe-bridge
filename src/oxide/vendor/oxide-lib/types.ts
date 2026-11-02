// The zero signature that clients and the relayer use. The rest of this module is in `@oxide/oxide-lib-tee/types.js`, which this module re-exports.
// The enclave does not use this code, so a change here does not change the enclave PCR0.
import { Fr } from '@aztec-labs/aztec.js/fields';

import type { K1NoteSignature } from '../oxide-lib-tee/types.js';

export * from '../oxide-lib-tee/types.js';

/** A zero signature, for a place that needs a signature that nothing verifies. */
export const ZERO_K1_NOTE_SIGNATURE: K1NoteSignature = { sLo: Fr.ZERO, sHi: Fr.ZERO, rLo: Fr.ZERO, rHi: Fr.ZERO };
