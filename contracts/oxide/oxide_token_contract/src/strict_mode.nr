//! Strict mode distinguishes the two passes the client runs every token operation through. The first pass is a
//! simulation with strict mode off: TEE signatures don't exist yet, so wherever a signature capsule is missing the
//! contract substitutes zeros, and the pass serves only to collect the off-chain effects sent to the TEE for signing.
//! Once the signatures are back, the client runs witness generation for the real transaction with the strict-mode
//! capsule set, and a missing signature capsule aborts execution instead of baking a zeroed signature into the tx.

use aztec::{oracle::capsules, protocol::{address::AztecAddress, hash::sha256_to_field}};

global STRICT_MODE_CAPSULE_SLOT: Field = sha256_to_field("OXIDE_TOKEN::STRICT_MODE_CAPSULE_SLOT".as_bytes());

pub unconstrained fn is_strict_mode(contract_address: AztecAddress) -> bool {
    capsules::load(
        contract_address,
        STRICT_MODE_CAPSULE_SLOT,
        AztecAddress::zero(),
    )
        .unwrap_or(false)
}
