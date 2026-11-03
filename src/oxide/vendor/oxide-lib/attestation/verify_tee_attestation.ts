import type { ParsedNitroAttestation } from './nitro_attestation/parsers.js';
import { verifyNitroAttestation } from './nitro_attestation/verify_nitro_attestation.js';
import { type UserData, computeAttestationUserData } from './user_data.js';

export interface TeeAttestationVerificationInput {
  /** Raw AWS Nitro attestation document: COSE_Sign1 CBOR bytes. */
  attestationDocument: Buffer;
  /**
   * Trusted AWS Nitro root certificates in DER or PEM form.
   */
  trustedRootCertificates: Buffer[];
  /**
   * Caller-known TEE user data. The function recomputes the canonical `user_data` SHA-256
   * commitment from these and asserts the parsed attestation's `user_data` matches it. Used to
   * confirm an attestation was produced by an enclave the caller already trusts the keys of.
   */
  userData: UserData;
  /** Optional expected Nitro `nonce` binding. */
  expectedNonce?: Buffer;
  /** Certificate validation time. Defaults to the attestation timestamp when present. */
  now?: Date;
}

/**
 * Higher-level wrapper around `verifyNitroAttestation`: recomputes the canonical
 * `user_data` SHA-256 commitment from `keys` and asserts the document binds it before returning
 * the parsed payload. Use when the caller knows which keys an attestation should commit to —
 * e.g. registering a TEE whose secp256k1 pubkey and P-256 encryption key are already established off-chain.
 */
export function verifyTeeAttestation(input: TeeAttestationVerificationInput): ParsedNitroAttestation {
  const expectedUserData = computeAttestationUserData(input.userData);
  return verifyNitroAttestation({
    attestationDocument: input.attestationDocument,
    trustedRootCertificates: input.trustedRootCertificates,
    expectedUserData,
    expectedNonce: input.expectedNonce,
    now: input.now,
  });
}
