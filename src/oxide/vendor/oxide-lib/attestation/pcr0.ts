import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { keccak256 } from '@aztec-labs/foundation/crypto/keccak';

import { parseCoseSign1, parseNitroPayload } from './nitro_attestation/parsers.js';

/**
 * Extracts the 48-byte PCR0 measurement from a raw AWS Nitro COSE_Sign1 attestation document.
 * Convenience wrapper over `parseCoseSign1` + `parseNitroPayload` for callers that only need
 * the enclave image hash.
 */
export function getPcr0(attestation: Buffer): Buffer {
  const { payloadBytes } = parseCoseSign1(attestation);
  return parseNitroPayload(payloadBytes).pcr0;
}

/**
 * Computes the keccak256 hash of a 48-byte PCR0 measurement, as the L1 contracts do.
 */
export function hashPcr0(pcr0: Buffer): Buffer32 {
  return Buffer32.fromString(keccak256(pcr0).toString('hex'));
}
