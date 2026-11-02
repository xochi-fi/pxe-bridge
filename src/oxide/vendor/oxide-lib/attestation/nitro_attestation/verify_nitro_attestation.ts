import { X509Certificate, verify as verifyCryptoSignature } from 'node:crypto';

import {
  type ParsedNitroAttestation,
  assertLen,
  cborArray,
  cborBytes,
  cborText,
  parseCoseSign1,
  parseNitroPayload,
} from './parsers.js';

export interface NitroAttestationVerificationInput {
  /** Raw AWS Nitro attestation document: COSE_Sign1 CBOR bytes. */
  attestationDocument: Buffer;
  /**
   * Trusted AWS Nitro root certificates in DER or PEM form. If omitted, the COSE
   * certificate chain is still checked internally but no external trust anchor is enforced.
   */
  trustedRootCertificates?: Buffer[];
  /** Optional expected Nitro `user_data` binding. */
  expectedUserData?: Buffer;
  /** Optional expected Nitro `nonce` binding. */
  expectedNonce?: Buffer;
  /** Certificate validation time. Defaults to the attestation timestamp when present. */
  now?: Date;
}

/**
 * Verifies a raw AWS Nitro COSE_Sign1 attestation document: parses the CBOR envelope, walks the
 * cabundle to the trusted root, verifies the ES384 leaf signature over the payload, and (if
 * provided) asserts `user_data` / `nonce` bindings byte-for-byte. Returns the parsed payload on
 * success; throws otherwise.
 */
export function verifyNitroAttestation(input: NitroAttestationVerificationInput): ParsedNitroAttestation {
  const { protectedHeaders, payloadBytes, signature } = parseCoseSign1(input.attestationDocument);
  const parsed = parseNitroPayload(payloadBytes);

  if (input.expectedUserData) {
    assertBufferEquals('Nitro user_data', parsed.userData, input.expectedUserData);
  }
  if (input.expectedNonce) {
    assertBufferEquals('Nitro nonce', parsed.nonce, input.expectedNonce);
  }

  const validationTime = input.now ?? (parsed.timestamp != null ? new Date(Number(parsed.timestamp)) : new Date());
  verifyCertificateChain(parsed, input.trustedRootCertificates, validationTime);
  verifyCoseSignature(protectedHeaders, payloadBytes, signature, parsed.certificate);
  return parsed;
}

function assertBufferEquals(name: string, actual: Buffer | undefined, expected: Buffer): void {
  if (!actual || !actual.equals(expected)) {
    throw new Error(`${name} does not match expected binding`);
  }
}

function verifyCertificateChain(parsed: ParsedNitroAttestation, trustedRoots: Buffer[] | undefined, now: Date): void {
  const leaf = new X509Certificate(parsed.certificate);
  const chain = parsed.caBundle.map(cert => new X509Certificate(cert));
  if (chain.length === 0) {
    throw new Error('Nitro cabundle must contain at least one issuing certificate');
  }

  assertCertificateTime(leaf, now, 'Nitro leaf certificate');
  for (const [i, cert] of chain.entries()) {
    assertCertificateTime(cert, now, `Nitro cabundle[${i}]`);
  }

  const unused = new Set(chain.map((_, i) => i));
  let current = leaf;
  while (current.subject !== current.issuer) {
    let issuerIndex: number | undefined;
    for (const i of unused) {
      const candidate = chain[i];
      if (candidate.subject === current.issuer && current.verify(candidate.publicKey)) {
        issuerIndex = i;
        break;
      }
    }
    if (issuerIndex == null) {
      throw new Error(`could not find issuer for Nitro certificate subject ${current.subject}`);
    }
    unused.delete(issuerIndex);
    current = chain[issuerIndex];
  }

  if (trustedRoots && trustedRoots.length > 0) {
    const roots = trustedRoots.map(cert => new X509Certificate(cert));
    const trusted = roots.some(root => current.raw.equals(root.raw) || current.verify(root.publicKey));
    if (!trusted) {
      throw new Error('Nitro certificate chain does not terminate in a trusted root');
    }
  }
}

function assertCertificateTime(cert: X509Certificate, now: Date, name: string): void {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  const time = now.getTime();
  if (time < from || time > to) {
    throw new Error(`${name} is not valid at ${now.toISOString()}`);
  }
}

function verifyCoseSignature(
  protectedHeaders: Buffer,
  payloadBytes: Buffer,
  signature: Buffer,
  certificate: Buffer,
): void {
  assertLen('COSE ES384 signature', signature, 96);
  const leaf = new X509Certificate(certificate);
  const sigStructure = cborArray([
    cborText('Signature1'),
    cborBytes(protectedHeaders),
    cborBytes(Buffer.alloc(0)),
    cborBytes(payloadBytes),
  ]);
  const ok = verifyCryptoSignature(
    'sha384',
    sigStructure,
    { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!ok) {
    throw new Error('Nitro COSE signature verification failed');
  }
}
