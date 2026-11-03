use aztec::{
    oracle::capsules,
    protocol::{address::AztecAddress, hash::{poseidon2_hash, sha256_to_field}},
    transient::TransientValue,
};

pub global OXIDE_TOKEN_SEED_CAPSULE_SLOT: Field = sha256_to_field("OXIDE_TOKEN::RANDOMNESS_SEED".as_bytes());

pub unconstrained fn next_randomness(contract_address: AztecAddress) -> Field {
    let seed = capsules::load(
        contract_address,
        OXIDE_TOKEN_SEED_CAPSULE_SLOT,
        AztecAddress::zero(),
    )
        .unwrap();

    poseidon2_hash([seed, next_randomness_index()])
}

// A nonce for creating randomness for notes or withdrawal messages.
global OXIDE_TOKEN_RANDOMNESS_INDEX_TRANSIENT_SLOT: Field = sha256_to_field("OXIDE_TOKEN::RANDOMNESS_INDEX".as_bytes());

unconstrained fn next_randomness_index() -> Field {
    let index = TransientValue::at(OXIDE_TOKEN_RANDOMNESS_INDEX_TRANSIENT_SLOT);
    let current = index.read().unwrap_or(0);
    index.store(current + 1);
    current
}
