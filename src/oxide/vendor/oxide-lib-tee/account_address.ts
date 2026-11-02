/**
 * Account address preimage helpers: the instance fields an account address commits to, the passkey commitment that
 * binds the P-256 passkey of an account to its address through the `immutables_hash`, and the WebAuthn assertion a
 * verifier checks.
 *
 * This module mirrors `noir-projects/oxide_lib/src/account_address.nr` and `webauthn.nr` exactly.
 */
import { Fr } from '@aztec-labs/aztec.js/fields';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { sha256 } from '@aztec-labs/foundation/crypto/sha256';
import { schemas, zodFor } from '@aztec-labs/foundation/schemas';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { computePartialAddress } from '@aztec-labs/stdlib/contract';
import { type PublicKeys, computeAddress } from '@aztec-labs/stdlib/keys';

import { z } from 'zod4';

import {
  DOM_SEP__PASSKEY_IMMUTABLES,
  DOM_SEP__PASSKEY_SET_IMMUTABLES,
  MAX_ACCOUNT_PASSKEYS,
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_CHALLENGE_LEN,
  WEBAUTHN_CHALLENGE_OFFSET,
  WEBAUTHN_FLAGS_OFFSET,
  WEBAUTHN_FLAG_USER_PRESENT,
  WEBAUTHN_FLAG_USER_VERIFIED,
  WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
} from './oxide_constants.gen.js';

export {
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_CHALLENGE_LEN,
  WEBAUTHN_CHALLENGE_OFFSET,
  WEBAUTHN_FLAG_USER_PRESENT,
  WEBAUTHN_FLAG_USER_VERIFIED,
  WEBAUTHN_FLAGS_OFFSET,
  WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
};

// ---------------------------------------------------------------------------
// Types + their schemas.
// ---------------------------------------------------------------------------

/** Uncompressed P-256 public key, coordinates as 32 big-endian bytes each. */
export interface PasskeyPublicKey {
  x: Buffer;
  y: Buffer;
}

/**
 * A WebAuthn assertion: the authenticator signed `sha256(authenticatorData || sha256(clientDataJSON))` with the
 * passkey. `signature` is `r || s`, 32 big-endian bytes each.
 */
export interface WebAuthnAuth {
  authenticatorData: Buffer;
  clientDataJSON: Buffer;
  signature: Buffer;
}

/**
 * The address preimage fields of an account's contract instance, less the immutables hash.
 */
export interface AccountInstancePreimage {
  contractClassId: Fr;
  salt: Fr;
  initializationHash: Fr;
  deployer: AztecAddress;
}

export const AccountInstancePreimageSchema = zodFor<AccountInstancePreimage>()(
  z.object({
    contractClassId: schemas.Fr,
    salt: schemas.Fr,
    initializationHash: schemas.Fr,
    deployer: AztecAddress.schema,
  }),
);

// ---------------------------------------------------------------------------
// Passkey to address binding.
// ---------------------------------------------------------------------------

function limb(bytes: Buffer, offset: number): Fr {
  return Fr.fromBuffer(Buffer.concat([Buffer.alloc(16), bytes.subarray(offset, offset + 16)]));
}

/**
 * The hash of one passkey, which fills one slot of a passkey set.
 *
 * Mirrors `oxide_lib::account_address::compute_passkey_hash`.
 */
export function computePasskeyHash(passkey: PasskeyPublicKey): Promise<Fr> {
  assertPasskeyShape(passkey);
  return poseidon2Hash([
    new Fr(DOM_SEP__PASSKEY_IMMUTABLES),
    limb(passkey.x, 0),
    limb(passkey.x, 16),
    limb(passkey.y, 0),
    limb(passkey.y, 16),
  ]);
}

/**
 * The `immutables_hash` of an account with the passkey set `slots`.
 *
 * Mirrors `oxide_lib::account_address::compute_passkey_set_immutables_hash`.
 */
export function computePasskeySetImmutablesHash(slots: Fr[]): Promise<Fr> {
  if (slots.length !== MAX_ACCOUNT_PASSKEYS) {
    throw new Error(`A passkey set has ${MAX_ACCOUNT_PASSKEYS} slots, not ${slots.length}`);
  }
  return poseidon2Hash([new Fr(DOM_SEP__PASSKEY_SET_IMMUTABLES), ...slots]);
}

/**
 * The address an account instance has when its preimage commits to `immutablesHash`.
 *
 * Mirrors `oxide_lib::account_address::compute_account_address`.
 */
export async function computeAccountAddress(
  publicKeys: PublicKeys,
  instance: AccountInstancePreimage,
  immutablesHash: Fr,
): Promise<AztecAddress> {
  const partialAddress = await computePartialAddress({
    originalContractClassId: instance.contractClassId,
    salt: instance.salt,
    initializationHash: instance.initializationHash,
    deployer: instance.deployer,
    immutablesHash,
  });
  return computeAddress(publicKeys, partialAddress);
}

// ---------------------------------------------------------------------------
// WebAuthn assertion verification.
// ---------------------------------------------------------------------------

/** Counts the characters of a string literal type, so the length of a constant can be checked at compile time. */
type CharCount<S extends string, Counted extends void[] = []> = S extends `${string}${infer Rest}`
  ? CharCount<Rest, [...Counted, void]>
  : Counted['length'];

const CLIENT_DATA_JSON_PREFIX_TEXT = '{"type":"webauthn.get","challenge":"';
/** The `clientDataJSON` bytes before the challenge, for an authentication ceremony. */
const CLIENT_DATA_JSON_PREFIX = Buffer.from(CLIENT_DATA_JSON_PREFIX_TEXT, 'utf8');
/** The prefix must end where the challenge starts. The annotation fails the build if the two stop agreeing, as the
 *  `[u8; WEBAUTHN_CHALLENGE_OFFSET]` type of the Noir global does. */
const CLIENT_DATA_JSON_PREFIX_LEN: CharCount<typeof CLIENT_DATA_JSON_PREFIX_TEXT> = WEBAUTHN_CHALLENGE_OFFSET;
/** The `"` that closes the challenge string. */
const CHALLENGE_QUOTE = 0x22;

/** The base64url (no padding) challenge a WebAuthn ceremony must carry to authorize `message`. */
export function computeWebAuthnChallenge(message: Fr): string {
  return message.toBuffer().toString('base64url');
}

/**
 * Check that `auth` is a valid WebAuthn assertion by `passkey` over `challenge`, with the same rules as
 * `oxide_lib::webauthn::assert_valid_webauthn_signature`. The `authenticatorData` flags must show user presence and
 * user verification, so the authenticator gated the assertion behind a biometric or a PIN. Never throws on malformed
 * input; returns false instead.
 */
export async function verifyWebAuthnAuth(
  passkey: PasskeyPublicKey,
  challenge: Fr,
  auth: WebAuthnAuth,
): Promise<boolean> {
  const { authenticatorData, clientDataJSON, signature } = auth;
  if (
    passkey.x.length !== 32 ||
    passkey.y.length !== 32 ||
    authenticatorData.length !== WEBAUTHN_AUTHENTICATOR_DATA_LEN ||
    signature.length !== 64 ||
    clientDataJSON.length > WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN ||
    clientDataJSON.length < WEBAUTHN_CHALLENGE_OFFSET + WEBAUTHN_CHALLENGE_LEN + 1
  ) {
    return false;
  }
  // The challenge offset below is fixed. It is correct only for an authentication ceremony.
  if (!clientDataJSON.subarray(0, CLIENT_DATA_JSON_PREFIX_LEN).equals(CLIENT_DATA_JSON_PREFIX)) {
    return false;
  }
  // The signature alone proves only that somebody holds the passkey. Both flags prove that a person completed the
  // ceremony and that the authenticator checked a biometric or a PIN first.
  const requiredFlags = WEBAUTHN_FLAG_USER_PRESENT | WEBAUTHN_FLAG_USER_VERIFIED;
  if ((authenticatorData[WEBAUTHN_FLAGS_OFFSET] & requiredFlags) !== requiredFlags) {
    return false;
  }

  const expectedChallenge = Buffer.from(computeWebAuthnChallenge(challenge), 'utf8');
  const end = WEBAUTHN_CHALLENGE_OFFSET + WEBAUTHN_CHALLENGE_LEN;
  if (!clientDataJSON.subarray(WEBAUTHN_CHALLENGE_OFFSET, end).equals(expectedChallenge)) {
    return false;
  }
  if (clientDataJSON[end] !== CHALLENGE_QUOTE) {
    return false;
  }

  const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(Buffer.concat([Buffer.from([0x04]), passkey.x, passkey.y])),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(signature),
      toArrayBuffer(signedData),
    );
  } catch {
    return false;
  }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function assertPasskeyShape(passkey: PasskeyPublicKey): void {
  if (passkey.x.length !== 32 || passkey.y.length !== 32) {
    throw new Error(`Passkey coordinates must be 32 bytes each, got x=${passkey.x.length} y=${passkey.y.length}`);
  }
}
