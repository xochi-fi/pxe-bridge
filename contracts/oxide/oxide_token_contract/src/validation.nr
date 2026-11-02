use super::{
    asserted_note::AssertedNote,
    da::{
        extract_metadata_da_component, extract_tee_notes_da_component, extract_tee_required_nullifiers_da_component,
        extract_tee_withdrawal_message_hashes_da_component, TEEMetadata,
    },
    k1_verify::Signature,
};
use aztec::{
    context::UtilityContext,
    hash::compute_l1_to_l2_message_hash,
    note::note_interface::NoteHash,
    oracle::get_l1_to_l2_membership_witness::try_get_l1_to_l2_membership_witness,
    protocol::{
        address::{AztecAddress, EthAddress},
        blob_data::TxEffect,
        constants::{MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX},
        hash::{compute_note_hash_nonce, compute_siloed_note_hash, compute_unique_note_hash, poseidon2_hash},
        merkle_tree::root::root_from_sibling_path,
        traits::{Deserialize, FromField, Serialize},
    },
};

use oxide_lib::constants::{PORTAL_CONSTANT_SECRET_HASH, TEE_REGISTRY_L2_RECIPIENT, TEE_SIG_DOMAIN_NOTE};
use oxide_token_lib::content_hash::get_register_signer_content_hash;

#[derive(Deserialize, Eq, Serialize)]
struct TeeSignedData {
    domain: u8,
    anchor_block_hash: Field,
    token_address: AztecAddress,
    l1_portal: EthAddress,
    tee_registry: EthAddress,
    signed_commitment: Field,
    required_nullifiers: BoundedVec<Field, MAX_NULLIFIERS_PER_TX>,
    tee_notes: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    withdrawal_message_hashes: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX>,
}

struct DAComponents {
    tee_notes: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    required_nullifiers: BoundedVec<Field, MAX_NULLIFIERS_PER_TX>,
    withdrawal_message_hashes: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX>,
    metadata: TEEMetadata,
}

impl DAComponents {
    unconstrained fn from_effect(effect: TxEffect, contract_address: AztecAddress) -> Option<DAComponents> {
        let tee_notes = extract_tee_notes_da_component(effect, contract_address);
        let metadata = extract_metadata_da_component(effect, contract_address);
        let required_nullifiers = extract_tee_required_nullifiers_da_component(effect, contract_address);
        let withdrawal_message_hashes = extract_tee_withdrawal_message_hashes_da_component(effect, contract_address);

        if tee_notes.is_none()
            | metadata.is_none()
            | required_nullifiers.is_none()
            | withdrawal_message_hashes.is_none() {
            Option::none()
        } else {
            Option::some(
                DAComponents {
                    tee_notes: tee_notes.unwrap_unchecked(),
                    metadata: metadata.unwrap_unchecked(),
                    required_nullifiers: required_nullifiers.unwrap_unchecked(),
                    withdrawal_message_hashes: withdrawal_message_hashes.unwrap_unchecked(),
                },
            )
        }
    }
}

fn validate_signature(
    signature: Signature,
    domain: u8,
    contract_address: AztecAddress,
    l1_portal: EthAddress,
    tee_registry: EthAddress,
    signed_commitment: Field,
    da_components: DAComponents,
) -> bool {
    let signed_data = TeeSignedData {
        domain,
        anchor_block_hash: da_components.metadata.anchor_block_hash,
        token_address: contract_address,
        l1_portal,
        tee_registry,
        signed_commitment,
        required_nullifiers: da_components.required_nullifiers,
        tee_notes: da_components.tee_notes,
        withdrawal_message_hashes: da_components.withdrawal_message_hashes,
    };

    aztec::protocol::logging::debug_log("Validating signature");

    aztec::protocol::logging::debug_log_format(
        "Public key x: {0}, {1}",
        [da_components.metadata.pub_key_x_hi, da_components.metadata.pub_key_x_lo],
    );
    aztec::protocol::logging::debug_log_format(
        "Public key y: {0}, {1}",
        [da_components.metadata.pub_key_y_hi, da_components.metadata.pub_key_y_lo],
    );
    aztec::protocol::logging::debug_log_format("Signature: {}", signature.serialize());
    aztec::protocol::logging::debug_log_format("Signed data: {}", signed_data.serialize());

    // Poseidon2-hash the serialized TeeSignedData and verify the ECDSA-secp256k1 signature over
    // the resulting field with the registered public key.
    let msg_hash = poseidon2_hash(signed_data.serialize());
    crate::k1_verify::safe_verify_signature(
        [da_components.metadata.pub_key_x_hi as u128, da_components.metadata.pub_key_x_lo as u128],
        [da_components.metadata.pub_key_y_hi as u128, da_components.metadata.pub_key_y_lo as u128],
        signature,
        msg_hash,
    )
}

fn validate_siloed_vs_unique_note_hash(siloed_note_hash: Field, effect: TxEffect) -> bool {
    let first_nullifier_in_tx = effect.nullifiers[0];
    let mut matching_count = 0;
    for i in 0..MAX_NOTE_HASHES_PER_TX {
        let nonce_for_i = compute_note_hash_nonce(first_nullifier_in_tx, i);
        let unique_note_hash_for_i = compute_unique_note_hash(nonce_for_i, siloed_note_hash);
        if effect.note_hashes[i] == unique_note_hash_for_i {
            matching_count += 1;
        }
    }
    // The siloed note hash must be used exactly once in the transaction.
    matching_count == 1
}

fn validate_required_nullifiers(
    required_nullifiers: BoundedVec<Field, MAX_NULLIFIERS_PER_TX>,
    effect: TxEffect,
) -> bool {
    let mut valid = true;
    for i in 0..required_nullifiers.len() {
        let required_nullifier = required_nullifiers.get_unchecked(i);
        valid = valid & (count_appearances_in_array(effect.nullifiers, required_nullifier) >= 1);
    }
    valid
}

fn validate_siloed_note_hash_in_tee_notes<let N: u32>(
    siloed_note_hash: Field,
    tee_notes: BoundedVec<Field, N>,
) -> bool {
    count_appearances_in_bounded_vec(tee_notes, siloed_note_hash) == 1
}

// Mirrors validateWithdrawalMessageHashesInL2ToL1Msgs in yarn-project/tee-enclave/src/signer.ts.
// We do the whole TEE dance because we can't fully trust the outbox - it inherits trust from
// circuits that may be buggy. So independently verify that every withdrawal the TEE attested in the
// creation preimage actually shows up as an L2->L1 message in the creation tx's effects.
// At least once, not exactly once: the check exists to catch an attested message the tx never emitted. A repeated
// message is finalized as a single withdrawal, so it says nothing about the notes, and the enclave accepts it.
fn validate_withdrawal_message_hashes_in_l2_to_l1_msgs<let N: u32>(
    withdrawal_message_hashes: BoundedVec<Field, N>,
    effect: TxEffect,
) -> bool {
    let mut valid = true;
    for i in 0..withdrawal_message_hashes.len() {
        let withdrawal_message_hash = withdrawal_message_hashes.get_unchecked(i);
        valid = valid & (count_appearances_in_array(effect.l2_to_l1_msgs, withdrawal_message_hash) >= 1);
    }
    valid
}

// Returns whether the `tee_registry` registered the note's signer. The registration message must be in the L1->L2 tree of
// the anchor block, at the leaf index that the note's metadata gives.
unconstrained fn validate_signer_registration(metadata: TEEMetadata, tee_registry: EthAddress) -> bool {
    let context = UtilityContext::new();
    let message_hash = compute_l1_to_l2_message_hash(
        tee_registry,
        context.chain_id(),
        AztecAddress::from_field(TEE_REGISTRY_L2_RECIPIENT),
        context.version(),
        get_register_signer_content_hash(
            metadata.pub_key_x_hi,
            metadata.pub_key_x_lo,
            metadata.pub_key_y_hi,
            metadata.pub_key_y_lo,
        ),
        PORTAL_CONSTANT_SECRET_HASH,
        metadata.registration_leaf_index,
    );
    // A missing registration message makes only this note invalid, so it must not stop the recipient's note sync.
    // Nothing consumes a registration message, so there is no nullifier.
    try_get_l1_to_l2_membership_witness(message_hash, Option::none())
        .map(|(_, sibling_path)| {
            root_from_sibling_path(message_hash, metadata.registration_leaf_index, sibling_path)
                == context.block_header().state.l1_to_l2_message_tree.root
        })
        .unwrap_or(false)
}

// Returns the TEE-signed anchor block hash if valid. The anchor's chain presence is NOT checked here; the caller
// batches that check (see delivery.nr).
pub unconstrained fn validate_note(
    note: AssertedNote,
    contract_address: AztecAddress,
    l1_portal: EthAddress,
    tee_registry: EthAddress,
    storage_slot: Field,
    owner: AztecAddress,
    maybe_effect: Option<TxEffect>,
) -> Option<Field> {
    let inner_note_hash = note.compute_note_hash(owner, storage_slot, note.randomness);
    let siloed_note_hash = compute_siloed_note_hash(contract_address, inner_note_hash);

    if maybe_effect.is_none() {
        Option::none()
    } else {
        let effect = maybe_effect.unwrap();
        aztec::protocol::logging::debug_log_format(
            "Fetched tx effect for {0}: revert_code={1}, fee={2}, first_nullifier={3}, randomness={4}",
            [
                effect.tx_hash,
                effect.revert_code as Field,
                effect.transaction_fee,
                effect.nullifiers[0],
                note.randomness,
            ],
        );

        let da_components = DAComponents::from_effect(effect, contract_address);

        // ugly indentation because we don't have early returns ):
        if da_components.is_none() {
            Option::none()
        } else {
            let da_components = da_components.unwrap_unchecked();

            // Validate everything but the signature
            let valid_conditions = validate_siloed_vs_unique_note_hash(siloed_note_hash, effect)
                & validate_required_nullifiers(da_components.required_nullifiers, effect)
                & validate_siloed_note_hash_in_tee_notes(siloed_note_hash, da_components.tee_notes)
                & validate_withdrawal_message_hashes_in_l2_to_l1_msgs(da_components.withdrawal_message_hashes, effect)
                & validate_signer_registration(da_components.metadata, tee_registry);

            if valid_conditions {
                // Now validate the signature. We do this last because the signature verification can panic if the public key is
                // not on the curve. However we have validated before that the public key has been registered, so validated on l1
                // to be on the curve.
                if validate_signature(
                    note.signature,
                    TEE_SIG_DOMAIN_NOTE,
                    contract_address,
                    l1_portal,
                    tee_registry,
                    siloed_note_hash,
                    da_components,
                ) {
                    Option::some(da_components.metadata.anchor_block_hash)
                } else {
                    Option::none()
                }
            } else {
                Option::none()
            }
        }
    }
}

fn count_appearances_in_array<T: Eq, let N: u32>(array: [T; N], value: T) -> u32 {
    let mut count = 0;
    for i in 0..N {
        if array[i] == value {
            count += 1;
        }
    }
    count
}

fn count_appearances_in_bounded_vec<T: Eq, let N: u32>(vec: BoundedVec<T, N>, value: T) -> u32 {
    let mut count = 0;
    for i in 0..vec.len() {
        if vec.get_unchecked(i) == value {
            count += 1;
        }
    }
    count
}

// These tests are mirrored in yarn-project/tee-enclave/src/signer.test.ts: every case here has a same-named test there
// with equivalent behavior. This helps ensure the enclave and the client perform equivalent validation checks.
mod test {
    use super::{
        TeeSignedData, validate_required_nullifiers, validate_siloed_note_hash_in_tee_notes,
        validate_withdrawal_message_hashes_in_l2_to_l1_msgs,
    };
    use aztec::protocol::{
        address::{AztecAddress, EthAddress},
        blob_data::TxEffect,
        constants::{MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX},
        hash::poseidon2_hash,
        traits::{Empty, FromField, Serialize},
    };
    use oxide_lib::constants::TEE_SIG_DOMAIN_NOTE;

    global H1: Field = 0x1111;
    global H2: Field = 0x2222;
    global H3: Field = 0x3333;

    unconstrained fn effect_with_l2_to_l1_msgs<let L: u32>(msgs: [Field; L]) -> TxEffect {
        let mut effect = TxEffect::empty();
        for i in 0..L {
            effect.l2_to_l1_msgs[i] = msgs[i];
        }
        effect
    }

    #[test]
    unconstrained fn accepts_attested_withdrawal_messages_present_in_the_tx() {
        let attested: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> = BoundedVec::from_array([H1, H2]);
        assert(validate_withdrawal_message_hashes_in_l2_to_l1_msgs(attested, effect_with_l2_to_l1_msgs([H2, H1])));
    }

    #[test]
    unconstrained fn rejects_an_attested_withdrawal_message_absent_from_the_tx() {
        let attested: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> = BoundedVec::from_array([H1, H2]);
        assert(!validate_withdrawal_message_hashes_in_l2_to_l1_msgs(attested, effect_with_l2_to_l1_msgs([H1])));
    }

    #[test]
    unconstrained fn accepts_a_repeated_withdrawal_message() {
        let attested: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> = BoundedVec::from_array([H1]);
        assert(validate_withdrawal_message_hashes_in_l2_to_l1_msgs(attested, effect_with_l2_to_l1_msgs([H1, H1])));
    }

    #[test]
    unconstrained fn accepts_an_empty_attested_withdrawal_list() {
        let attested: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> = BoundedVec::new();
        assert(validate_withdrawal_message_hashes_in_l2_to_l1_msgs(attested, effect_with_l2_to_l1_msgs([H1, H1])));
    }

    #[test]
    unconstrained fn rejects_a_required_nullifier_absent_from_the_tx() {
        let required: BoundedVec<Field, MAX_NULLIFIERS_PER_TX> = BoundedVec::from_array([H1, H2]);
        let mut effect = TxEffect::empty();
        effect.nullifiers[0] = H1;
        assert(!validate_required_nullifiers(required, effect));
        effect.nullifiers[1] = H2;
        assert(validate_required_nullifiers(required, effect));
    }

    #[test]
    unconstrained fn counts_a_note_only_within_the_emitted_tee_notes() {
        let mut storage = [0; MAX_NOTE_HASHES_PER_TX];
        storage[0] = H1;
        storage[1] = H3;
        storage[2] = H2;
        // H2 sits past the emitted length, so it is padding and not a tee note.
        let tee_notes: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX> = BoundedVec::from_parts(storage, 2);
        assert(validate_siloed_note_hash_in_tee_notes(H1, tee_notes));
        assert(!validate_siloed_note_hash_in_tee_notes(H2, tee_notes));
        assert(!validate_siloed_note_hash_in_tee_notes(0, tee_notes));
    }

    // Parity with the TS builders: `TeeSignedData TS <-> Noir parity` in oxide-lib's types.test.ts pins this value.
    #[test]
    unconstrained fn ts_parity() {
        // Updated by `OXIDE_GENERATE_TEST_DATA=1 yarn workspace @oxide/oxide-lib test types`.
        let expected_note_digest: Field = 0x005e3bf1161b9788b3cbefb5df256aa5d4846903a4469a819e7274c22933f6a7;

        let signed_data = TeeSignedData {
            domain: TEE_SIG_DOMAIN_NOTE,
            anchor_block_hash: 1,
            token_address: AztecAddress::from_field(2),
            l1_portal: EthAddress::from_field(3),
            tee_registry: EthAddress::from_field(7),
            signed_commitment: 4,
            required_nullifiers: BoundedVec::from_array([5]),
            tee_notes: BoundedVec::from_array([4]),
            withdrawal_message_hashes: BoundedVec::from_array([6]),
        };
        assert_eq(poseidon2_hash(signed_data.serialize()), expected_note_digest);
    }
}

mod registration_test {
    use crate::da::TEEMetadata;
    use super::validate_signer_registration;
    use aztec::{
        protocol::{address::{AztecAddress, EthAddress}, traits::FromField},
        test::helpers::test_environment::TestEnvironment,
    };
    use oxide_lib::constants::{PORTAL_CONSTANT_SECRET_HASH, TEE_REGISTRY_L2_RECIPIENT};
    use oxide_token_lib::content_hash::get_register_signer_content_hash;

    global TEE_REGISTRY: EthAddress = EthAddress::from_field(0x7e6);

    /// Sends the registration message for a signer from `TEE_REGISTRY` and returns the signer's metadata.
    unconstrained fn register_signer(env: TestEnvironment) -> TEEMetadata {
        let mut metadata = TEEMetadata {
            pub_key_x_hi: 1,
            pub_key_x_lo: 2,
            pub_key_y_hi: 3,
            pub_key_y_lo: 4,
            anchor_block_hash: 0,
            registration_leaf_index: 0,
        };
        metadata.registration_leaf_index = env.send_l1_to_l2_message_from_secret_hash(
            get_register_signer_content_hash(
                metadata.pub_key_x_hi,
                metadata.pub_key_x_lo,
                metadata.pub_key_y_hi,
                metadata.pub_key_y_lo,
            ),
            PORTAL_CONSTANT_SECRET_HASH,
            TEE_REGISTRY,
            AztecAddress::from_field(TEE_REGISTRY_L2_RECIPIENT),
        );
        metadata
    }

    #[test]
    unconstrained fn accepts_a_signer_that_the_registry_registered() {
        let env = TestEnvironment::new();
        let metadata = register_signer(env);
        env.utility_context(|_| assert(validate_signer_registration(metadata, TEE_REGISTRY)));
    }

    #[test]
    unconstrained fn rejects_a_signer_that_another_registry_registered() {
        let env = TestEnvironment::new();
        let metadata = register_signer(env);
        env.utility_context(|_| assert(!validate_signer_registration(metadata, EthAddress::from_field(0xbad))));
    }

    #[test]
    unconstrained fn rejects_a_signer_with_a_wrong_registration_leaf_index() {
        let env = TestEnvironment::new();
        let mut metadata = register_signer(env);
        metadata.registration_leaf_index += 1;
        env.utility_context(|_| assert(!validate_signer_registration(metadata, TEE_REGISTRY)));
    }
}
