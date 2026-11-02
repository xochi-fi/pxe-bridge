use crate::constants::{DOM_SEP__PASSKEY_IMMUTABLES, DOM_SEP__PASSKEY_SET_IMMUTABLES, MAX_ACCOUNT_PASSKEYS};
use aztec::protocol::{
    address::{AztecAddress, PartialAddress},
    contract_class_id::ContractClassId,
    hash::poseidon2_hash_with_separator,
    public_keys::PublicKeys,
};

/// Uncompressed P-256 public key, coordinates as 32 big-endian bytes each. This is the shape
/// `std::ecdsa_secp256r1::verify_signature` consumes.
pub struct PasskeyPublicKey {
    pub x: [u8; 32],
    pub y: [u8; 32],
}

/// The address preimage fields of a contract instance, less the immutables hash.
pub struct AccountInstancePreimage {
    pub contract_class_id: ContractClassId,
    pub salt: Field,
    pub initialization_hash: Field,
    pub deployer: AztecAddress,
}

fn pack_16_bytes(bytes: [u8; 32], offset: u32) -> Field {
    let mut acc: Field = 0;
    for i in 0..16 {
        acc = acc * 256 + bytes[offset + i] as Field;
    }
    acc
}

/// The hash of one passkey, which fills one slot of a passkey set.
pub fn compute_passkey_hash(passkey: PasskeyPublicKey) -> Field {
    poseidon2_hash_with_separator(
        [
            pack_16_bytes(passkey.x, 0),
            pack_16_bytes(passkey.x, 16),
            pack_16_bytes(passkey.y, 0),
            pack_16_bytes(passkey.y, 16),
        ],
        DOM_SEP__PASSKEY_IMMUTABLES,
    )
}

/// The `immutables_hash` of an account with the passkey set `slots`.
pub fn compute_passkey_set_immutables_hash(slots: [Field; MAX_ACCOUNT_PASSKEYS]) -> Field {
    poseidon2_hash_with_separator(slots, DOM_SEP__PASSKEY_SET_IMMUTABLES)
}

pub fn compute_account_address(
    public_keys: PublicKeys,
    instance: AccountInstancePreimage,
    immutables_hash: Field,
) -> AztecAddress {
    let partial_address = PartialAddress::compute(
        instance.contract_class_id,
        instance.salt,
        instance.initialization_hash,
        instance.deployer,
        immutables_hash,
    );
    AztecAddress::compute(public_keys, partial_address)
}
