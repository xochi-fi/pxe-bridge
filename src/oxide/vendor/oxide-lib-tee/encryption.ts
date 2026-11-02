// HPKE wrapper for E2E encryption between client and enclave.
//
// Suite: DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM (RFC 9180), mode_base.
//
// One round-trip per HPKE context: per-request ephemeral sender keys give per-request forward
// secrecy. The response key is fresh too (it depends on the per-request encapsulation), so
// using a fixed-zero nonce for the single response is safe.
import { Buffer32 } from '@aztec-labs/foundation/buffer';

import {
  Aes128Gcm,
  type CipherSuite,
  CipherSuite as CipherSuiteImpl,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from '@hpke/core';

import type { PortalDomain } from './types.js';

const REQUEST_AAD_WITHOUT_DOMAIN = new TextEncoder().encode('oxide-tee/v1/req');
const REQUEST_AAD_WITH_DOMAIN_PREFIX = new TextEncoder().encode('oxide-tee/v1/req-domain');
const RESPONSE_EXPORT_LABEL = new TextEncoder().encode('oxide-tee/v1/response');
const RESPONSE_AAD = new TextEncoder().encode('oxide-tee/v1/resp');
// AES-128-GCM key size.
const RESPONSE_KEY_BYTES = 16;
// DHKEM(P-256) Npk = Nenc = 65 (uncompressed SEC1: 0x04 || X(32) || Y(32)).
const KEM_PUBKEY_BYTES = 65;
// SEC1 uncompressed-point prefix byte.
const SEC1_UNCOMPRESSED_PREFIX = 0x04;

let cachedSuite: CipherSuite | undefined;

function suite(): CipherSuite {
  if (!cachedSuite) {
    cachedSuite = new CipherSuiteImpl({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes128Gcm(),
    });
  }
  return cachedSuite;
}

/** Raw P-256 public key, split into its big-endian affine coordinates. */
export class P256PublicKey {
  constructor(
    public readonly x: Buffer32,
    public readonly y: Buffer32,
  ) {}

  static fromCoordinates({ x, y }: { x: Buffer32; y: Buffer32 }): P256PublicKey {
    return new P256PublicKey(x, y);
  }

  static fromSec1Uncompressed(sec1: Buffer): P256PublicKey {
    if (sec1.length !== KEM_PUBKEY_BYTES) {
      throw new Error(`expected ${KEM_PUBKEY_BYTES}-byte uncompressed SEC1 point, got ${sec1.length}`);
    }
    if (sec1[0] !== SEC1_UNCOMPRESSED_PREFIX) {
      throw new Error(`expected SEC1 uncompressed prefix 0x04, got 0x${sec1[0].toString(16)}`);
    }
    return P256PublicKey.fromCoordinates({
      x: Buffer32.fromBuffer(sec1.subarray(1, 33)),
      y: Buffer32.fromBuffer(sec1.subarray(33, 65)),
    });
  }

  toSec1Uncompressed(): Buffer {
    return Buffer.concat([Buffer.from([SEC1_UNCOMPRESSED_PREFIX]), this.x.toBuffer(), this.y.toBuffer()]);
  }
}

/** P-256 keypair held by the enclave for the lifetime of the process. */
export interface EnclaveEncryptionKeypair {
  /** P-256 public key as `(X, Y)` — what gets committed into attestation user_data. */
  publicKey: P256PublicKey;
  /** Opaque private key handle — never serialized, lives only in this process. */
  privateKey: CryptoKey;
}

/** Generate a fresh P-256 keypair for the enclave. */
export async function generateEncryptionKeypair(): Promise<EnclaveEncryptionKeypair> {
  const kp = await suite().kem.generateKeyPair();
  const rawPub = Buffer.from(await suite().kem.serializePublicKey(kp.publicKey));
  return { publicKey: P256PublicKey.fromSec1Uncompressed(rawPub), privateKey: kp.privateKey };
}

/**
 * Build the additional authenticated data (AAD) for a sealed request. With a disclosed domain, the AAD
 * commits to all of its values, so decryption fails unless the opener sees the same plaintext domain.
 * Without one, it is a fixed marker, so decryption fails if a domain is injected.
 */
function aadFor(domain?: PortalDomain): Uint8Array {
  if (!domain) {
    return REQUEST_AAD_WITHOUT_DOMAIN;
  }
  return Buffer.concat([REQUEST_AAD_WITH_DOMAIN_PREFIX, domainBytes(domain)]);
}

/**
 * Canonical domain encoding: l1Portal (20 bytes) ‖ l2Token (32) ‖ teeRegistry (20) ‖ l1ChainId (8) ‖
 * rollupVersion (8), big-endian.
 */
function domainBytes(domain: PortalDomain): Buffer {
  const tail = Buffer.alloc(16);
  tail.writeBigUInt64BE(domain.l1ChainId, 0);
  tail.writeBigUInt64BE(domain.rollupVersion, 8);
  return Buffer.concat([domain.l1Portal.toBuffer(), domain.l2Token.toBuffer(), domain.teeRegistry.toBuffer(), tail]);
}

/** Output of `sealRequest`. Caller frames `wirePayload` and sends it; on response, calls `openResponse`. */
export interface SealedRequest {
  wirePayload: Buffer;
  openResponse: (responseCiphertext: Buffer) => Promise<Buffer>;
}

/**
 * Client side: seal an inner JSON-RPC request to the enclave's pubkey. Wire layout: [enc (65 bytes) ‖ AEAD
 * ciphertext+tag]. A `domain`, when given, must also travel in plaintext with the payload.
 */
export async function sealRequest(
  recipientPublicKey: P256PublicKey,
  plaintext: Buffer,
  domain?: PortalDomain,
): Promise<SealedRequest> {
  const recipientSec1 = recipientPublicKey.toSec1Uncompressed();
  const recipient = await suite().kem.deserializePublicKey(toArrayBuffer(recipientSec1));
  const senderCtx = await suite().createSenderContext({ recipientPublicKey: recipient });
  const ciphertext = await senderCtx.seal(toArrayBuffer(plaintext), toArrayBuffer(aadFor(domain)));

  const enc = Buffer.from(senderCtx.enc);
  if (enc.length !== KEM_PUBKEY_BYTES) {
    throw new Error(`unexpected KEM enc size: ${enc.length}`);
  }
  const wirePayload = Buffer.concat([enc, Buffer.from(ciphertext)]);

  const responseKeyBytes = Buffer.from(await senderCtx.export(RESPONSE_EXPORT_LABEL, RESPONSE_KEY_BYTES));
  return {
    wirePayload,
    openResponse: responseCiphertext => openResponseWithKey(responseKeyBytes, responseCiphertext),
  };
}

/** Output of `openRequest`. Dispatcher uses `innerPlaintext` to handle, then `sealResponse` to encode. */
export interface OpenedRequest {
  innerPlaintext: Buffer;
  // TODO(benesjan) returning here this closure is weird. Figure out if better pattern is possible.
  sealResponse: (responsePlaintext: Buffer) => Promise<Buffer>;
}

export async function openRequest(
  keypair: EnclaveEncryptionKeypair,
  wirePayload: Buffer,
  domain?: PortalDomain,
): Promise<OpenedRequest> {
  if (wirePayload.length < KEM_PUBKEY_BYTES) {
    throw new Error('encrypted payload too short');
  }
  const enc = wirePayload.subarray(0, KEM_PUBKEY_BYTES);
  const ciphertext = wirePayload.subarray(KEM_PUBKEY_BYTES);
  const recipientCtx = await suite().createRecipientContext({
    recipientKey: keypair.privateKey,
    enc: toArrayBuffer(enc),
  });
  const plaintext = await recipientCtx.open(toArrayBuffer(ciphertext), toArrayBuffer(aadFor(domain)));
  const responseKeyBytes = Buffer.from(await recipientCtx.export(RESPONSE_EXPORT_LABEL, RESPONSE_KEY_BYTES));
  return {
    innerPlaintext: Buffer.from(plaintext),
    sealResponse: responsePlaintext => sealResponseWithKey(responseKeyBytes, responsePlaintext),
  };
}

// The response is a single AEAD message keyed by an HPKE-exported secret; the export is unique
// to this HPKE context (which is unique to this request's enc), so a fixed-zero nonce is safe.
const RESPONSE_NONCE = new Uint8Array(12);

async function sealResponseWithKey(rawKey: Buffer, plaintext: Buffer): Promise<Buffer> {
  const aeadCtx = suite().aead.createEncryptionContext(toArrayBuffer(rawKey));
  const ct = await aeadCtx.seal(RESPONSE_NONCE, toArrayBuffer(plaintext), RESPONSE_AAD);
  return Buffer.from(ct);
}

async function openResponseWithKey(rawKey: Buffer, ciphertext: Buffer): Promise<Buffer> {
  const aeadCtx = suite().aead.createEncryptionContext(toArrayBuffer(rawKey));
  const pt = await aeadCtx.open(RESPONSE_NONCE, toArrayBuffer(ciphertext), RESPONSE_AAD);
  return Buffer.from(pt);
}

// Defensively copies the input.
function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

// Re-export so callers don't need to import @hpke/* directly when they just want to detect a
// ciphertext-corruption error vs a real I/O error.
export { OpenError, SealError } from '@hpke/core';
