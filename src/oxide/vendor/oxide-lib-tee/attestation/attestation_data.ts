import { schemas, zodFor } from '@aztec-labs/foundation/schemas';

import { z } from 'zod4';

import { UserData, userDataSchema } from './user_data.js';

export interface AttestationData {
  /** Raw AWS Nitro attestation document: COSE_Sign1 CBOR bytes. */
  attestation: Buffer;
  userData: UserData;
}

export const AttestationDataSchema = zodFor<AttestationData>()(
  z.object({
    attestation: schemas.Buffer,
    userData: userDataSchema,
  }),
);
