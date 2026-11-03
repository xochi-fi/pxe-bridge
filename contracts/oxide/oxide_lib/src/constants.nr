//! Single source of truth for constants shared across Noir, TypeScript, and Solidity.
//!
//! `yarn-project/oxide-lib-tee/scripts/gen_constants.mjs` parses this file and regenerates
//! `yarn-project/oxide-lib-tee/src/oxide_constants.gen.ts` and `l1-contracts/src/generated/OxideConstants.gen.sol`.
//! Edit values here only; never hand-edit the generated files.

use aztec::hash::compute_secret_hash;
use aztec::protocol::hash::sha256_to_field;

pub global DOM_SEP__MIGRATION: Field = sha256_to_field("OXIDE_MIGRATION".as_bytes());

pub global DOM_SEP__PASSKEY_IMMUTABLES: Field = sha256_to_field("ALPHA_KEY".as_bytes());

// Passkey set: up to 8 sorted passkey hashes, zero-padded.
pub global MAX_ACCOUNT_PASSKEYS: u32 = 8;
pub global DOM_SEP__PASSKEY_SET_IMMUTABLES: Field = sha256_to_field("ALPHA_KEYS".as_bytes());

// WebAuthn assertion layout. `authenticatorData` is rpIdHash (32) + flags (1) + signCount (4) with no extensions.
// `clientDataJSON` starts with `{"type":"webauthn.get","challenge":"` (36 bytes) followed by the base64url challenge
// (43 bytes for a 32-byte challenge) and a closing quote. The maximum JSON length matches the alpha account contract:
// it keeps `sha256_var` at the same block count and covers Chromium's anti-templating suffix on long origins.
pub global WEBAUTHN_AUTHENTICATOR_DATA_LEN: u32 = 37;
pub global WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN: u32 = 319;
pub global WEBAUTHN_CHALLENGE_OFFSET: u32 = 36;
pub global WEBAUTHN_CHALLENGE_LEN: u32 = 43;
// The flags byte of `authenticatorData` follows the 32-byte rpIdHash. Bit 0 tells that the user was present, and bit 2
// tells that the authenticator verified the user with a biometric or a PIN. The verifier requires both bits.
pub global WEBAUTHN_FLAGS_OFFSET: u32 = 32;
pub global WEBAUTHN_FLAG_USER_PRESENT: u8 = 0x01;
pub global WEBAUTHN_FLAG_USER_VERIFIED: u8 = 0x04;

pub global DOM_SEP__DEPOSIT_MESSAGE_NULLIFIER: u32 = 0xD3B0511F;

pub global DOM_SEP__TOKEN_IMMUTABLES: u32 = 0x67A58CB3;

// Domain bytes prepended to TEE-signed preimages so a signature for one operation cannot be replayed as another.
pub global TEE_SIG_DOMAIN_NOTE: u8 = 0;
pub global TEE_SIG_DOMAIN_WITHDRAWAL: u8 = 1;
pub global TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED: u8 = 2;
pub global TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND: u8 = 3;
pub global TEE_SIG_DOMAIN_FROZEN_DEPOSITS_REFUND: u8 = 4;
pub global TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND: u8 = 5;

// Identifier used to name space accounting effects between all the effects emitted via `emit_offchain_effect`
pub global ACCOUNTING_EFFECT_IDENTIFIER: Field = sha256_to_field("OXIDE_TOKEN::ACCOUNTING_EFFECT".as_bytes());
// Accounting effect tags, one per balance-invariant term. Second field of each effect, after the identifier.
pub global NULLIFICATION_EFFECT_TYPE: u8 = 1;
pub global INSERTION_EFFECT_TYPE: u8 = 2;
pub global WITHDRAWAL_EFFECT_TYPE: u8 = 3;
pub global DEPOSIT_EFFECT_TYPE: u8 = 4;

// Storage slots in `oxide_token_contract::Storage`; must match the `#[storage]` macro layout.
pub global BALANCES_STORAGE_SLOT: Field = 1;

// The class-update delay that `lock_update_delay` sets, in seconds: 10 years.
pub global TOKEN_UPDATE_DELAY: u64 = 315_360_000;

// Signer-registration L1 -> L2 messages use a constant zero secret: registration is public, so there is nothing to
// hide.
pub global PORTAL_CONSTANT_SECRET: Field = 0;
pub global PORTAL_CONSTANT_SECRET_HASH: Field = compute_secret_hash([PORTAL_CONSTANT_SECRET]);

// The L2 recipient of `TeeRegistry` registration messages. No contract consumes them.
pub global TEE_REGISTRY_L2_RECIPIENT: Field = sha256_to_field("OXIDE_TEE_REGISTRY::L2_RECIPIENT".as_bytes());

// Cap on the L1 priority fee per gas, in wei. Subsidy pays for gas at no more than the base fee plus this cap, and
// the relayer signs L1 operations with a priority fee of no more than this cap. This is done to protect the subsidy
// from griefing attacks by the relayer.
pub global MAX_PRIORITY_FEE_WEI: u128 = 100_000_000; // 0.1 gwei

// Frozen-notes refund sizing and the verifier public-input counts the L1 portal rebuilds.
pub global MAX_FROZEN_NOTES_PER_REFUND: u32 = 20;
pub global FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT: u32 = MAX_FROZEN_NOTES_PER_REFUND + 8;
pub global MAX_FROZEN_DEPOSITS_PER_REFUND: u32 = 5;
pub global FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT: u32 = MAX_FROZEN_DEPOSITS_PER_REFUND + 7;
pub global UNPROCESSED_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT: u32 = 10;

// DA component tags: sha256-to-field of stable labels identifying each private-log payload.
pub global TEE_NOTES_DA_TAG: Field = sha256_to_field("oxideTeeNotes".as_bytes());
pub global TEE_REQUIRED_NULLIFIERS_DA_TAG: Field = sha256_to_field("oxideTeeRequiredNullifiers".as_bytes());
pub global TEE_METADATA_DA_TAG: Field = sha256_to_field("oxideTeeMetadata".as_bytes());
pub global TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG: Field = sha256_to_field("oxideTeeWithdrawalMessageHashes".as_bytes());
pub global DOM_SEP__STEALTH_K: Field = sha256_to_field("OXIDE_STEALTH_RESOLUTION".as_bytes());
/// `MAX_NONCE` is the upper bound on nonces per (resolver, recipient, day).
pub global MAX_NONCE: u32 = 1_000_000;

// secp256k1 curve parameters, each split big-endian into two u128 limbs.
// n (order) = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE BAAEDCE6AF48A03BBFD25E8CD0364141
pub global K1_N_HI: u128 = 0xfffffffffffffffffffffffffffffffe;
pub global K1_N_LO: u128 = 0xbaaedce6af48a03bbfd25e8cd0364141;
// p (base field prime) = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF FFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
pub global K1_P_HI: u128 = 0xffffffffffffffffffffffffffffffff;
pub global K1_P_LO: u128 = 0xfffffffffffffffffffffffefffffc2f;

pub global L1_OPERATION_METADATA_FIELDS: u32 = 6;
pub global L1_OPERATION_CALLDATA_FIELDS_2K: u32 = 67;
pub global L1_OPERATION_CALLDATA_FIELDS_4K: u32 = 133;
pub global L1_OPERATION_CALLDATA_FIELDS_16K: u32 = 529;
pub global L1_OPERATION_CALLDATA_FIELDS_32K: u32 = 1058;
pub global L1_OPERATION_CALLDATA_FIELDS_64K: u32 = 2115;
pub global L1_OPERATION_CALLDATA_FIELDS_128K: u32 = 4229;
