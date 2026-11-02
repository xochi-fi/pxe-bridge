use super::utils::is_block_in_archive;
use aztec::{
    oracle::capsules,
    protocol::{
        abis::block_header::BlockHeader,
        address::AztecAddress,
        blob_data::TxEffect,
        constants::{
            MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX, PRIVATE_LOG_CIPHERTEXT_LEN,
        },
        hash::{compute_siloed_private_log_first_field, sha256_to_field},
        traits::{Deserialize, Hash, Serialize},
    },
    utils::array::subarray,
};
use oxide_lib::constants::{
    TEE_METADATA_DA_TAG, TEE_NOTES_DA_TAG, TEE_REQUIRED_NULLIFIERS_DA_TAG, TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
};

global DA_COMPONENT_LOG_PAYLOAD_LENGTH: u32 = PRIVATE_LOG_CIPHERTEXT_LEN;
global MAX_NOTE_HASH_PRIVATE_LOGS: u32 =
    (MAX_NOTE_HASHES_PER_TX + DA_COMPONENT_LOG_PAYLOAD_LENGTH - 1) / DA_COMPONENT_LOG_PAYLOAD_LENGTH;
global MAX_NULLIFIER_PRIVATE_LOGS: u32 =
    (MAX_NULLIFIERS_PER_TX + DA_COMPONENT_LOG_PAYLOAD_LENGTH - 1) / DA_COMPONENT_LOG_PAYLOAD_LENGTH;
global MAX_WITHDRAWAL_MESSAGE_HASH_PRIVATE_LOGS: u32 =
    (MAX_L2_TO_L1_MSGS_PER_TX + DA_COMPONENT_LOG_PAYLOAD_LENGTH - 1) / DA_COMPONENT_LOG_PAYLOAD_LENGTH;

global TEE_NOTES_DA_COMPONENT_CAPSULE_KEY: Field = sha256_to_field("oxideTeeNotesCapsuleKey".as_bytes());

global TEE_REQUIRED_NULLIFIERS_DA_COMPONENT_CAPSULE_KEY: Field =
    sha256_to_field("oxideTeeRequiredNullifiersCapsuleKey".as_bytes());

global TEE_METADATA_DA_COMPONENT_CAPSULE_KEY: Field = sha256_to_field("oxideTeeMetadataCapsuleKey".as_bytes());

global TEE_WITHDRAWAL_MESSAGE_HASHES_DA_COMPONENT_CAPSULE_KEY: Field =
    sha256_to_field("oxideTeeWithdrawalMessageHashesCapsuleKey".as_bytes());

pub unconstrained fn prepare_tee_notes_da_component_logs(
    address: AztecAddress,
) -> BoundedVec<BoundedVec<Field, PRIVATE_LOG_CIPHERTEXT_LEN>, MAX_NOTE_HASH_PRIVATE_LOGS> {
    let tee_notes = load_tee_notes_da_capsule(address);
    chunk_to_log_payloads(tee_notes)
}

unconstrained fn load_tee_notes_da_capsule(address: AztecAddress) -> BoundedVec<Field, MAX_NOTE_HASHES_PER_TX> {
    capsules::load(
        address,
        TEE_NOTES_DA_COMPONENT_CAPSULE_KEY,
        AztecAddress::zero(),
    )
        .unwrap()
}

pub unconstrained fn prepare_tee_required_nullifiers_da_component_logs(
    address: AztecAddress,
) -> BoundedVec<BoundedVec<Field, PRIVATE_LOG_CIPHERTEXT_LEN>, MAX_NULLIFIER_PRIVATE_LOGS> {
    let tee_required_nullifiers = load_tee_required_nullifiers_da_capsule(address);
    chunk_to_log_payloads(tee_required_nullifiers)
}

unconstrained fn load_tee_required_nullifiers_da_capsule(
    address: AztecAddress,
) -> BoundedVec<Field, MAX_NULLIFIERS_PER_TX> {
    capsules::load(
        address,
        TEE_REQUIRED_NULLIFIERS_DA_COMPONENT_CAPSULE_KEY,
        AztecAddress::zero(),
    )
        .unwrap()
}

pub unconstrained fn prepare_tee_withdrawal_message_hashes_da_component_logs(
    address: AztecAddress,
) -> BoundedVec<BoundedVec<Field, PRIVATE_LOG_CIPHERTEXT_LEN>, MAX_WITHDRAWAL_MESSAGE_HASH_PRIVATE_LOGS> {
    let tee_withdrawal_message_hashes = load_tee_withdrawal_message_hashes_da_capsule(address);
    chunk_to_log_payloads(tee_withdrawal_message_hashes)
}

unconstrained fn load_tee_withdrawal_message_hashes_da_capsule(
    address: AztecAddress,
) -> BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> {
    capsules::load(
        address,
        TEE_WITHDRAWAL_MESSAGE_HASHES_DA_COMPONENT_CAPSULE_KEY,
        AztecAddress::zero(),
    )
        .unwrap()
}

unconstrained fn chunk_to_log_payloads<let TOTAL_LEN: u32, let MAX_LOGS: u32>(
    items: BoundedVec<Field, TOTAL_LEN>,
) -> BoundedVec<BoundedVec<Field, PRIVATE_LOG_CIPHERTEXT_LEN>, MAX_LOGS> {
    // Validate MAX_LOGS is just enough to fit all the items.
    std::static_assert(
        (DA_COMPONENT_LOG_PAYLOAD_LENGTH * MAX_LOGS) >= TOTAL_LEN,
        "DA_COMPONENT_LOG_PAYLOAD_LENGTH * MAX_LOGS must be >= TOTAL_LEN",
    );
    std::static_assert(
        (DA_COMPONENT_LOG_PAYLOAD_LENGTH * (MAX_LOGS - 1)) < TOTAL_LEN,
        "DA_COMPONENT_LOG_PAYLOAD_LENGTH * (MAX_LOGS - 1) must be < TOTAL_LEN",
    );
    let mut logs = BoundedVec::new();

    let mut current_log = BoundedVec::new();

    for i in 0..items.len() {
        if (current_log.len() == current_log.max_len()) {
            logs.push(current_log);
            current_log = BoundedVec::new();
        }
        current_log.push(items.get_unchecked(i));
    }
    if (current_log.len() > 0) {
        logs.push(current_log);
    }
    logs
}

pub unconstrained fn extract_tee_notes_da_component(
    tx_effect: TxEffect,
    contract_address: AztecAddress,
) -> Option<BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>> {
    fill_with_tagged_da_component(tx_effect, contract_address, TEE_NOTES_DA_TAG)
}

pub unconstrained fn extract_tee_required_nullifiers_da_component(
    tx_effect: TxEffect,
    contract_address: AztecAddress,
) -> Option<BoundedVec<Field, MAX_NULLIFIERS_PER_TX>> {
    fill_with_tagged_da_component(tx_effect, contract_address, TEE_REQUIRED_NULLIFIERS_DA_TAG)
}

pub unconstrained fn extract_tee_withdrawal_message_hashes_da_component(
    tx_effect: TxEffect,
    contract_address: AztecAddress,
) -> Option<BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX>> {
    fill_with_tagged_da_component(
        tx_effect,
        contract_address,
        TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
    )
}

/// Concatenates the payloads of every private log whose first field is `da_tag` siloed with `contract_address`.
///
/// Returns `Option::none` when they carry more than `N` fields in total.
unconstrained fn fill_with_tagged_da_component<let N: u32>(
    tx_effect: TxEffect,
    contract_address: AztecAddress,
    da_tag: Field,
) -> Option<BoundedVec<Field, N>> {
    let TAG_OFFSET: u32 = 0;
    let PAYLOAD_OFFSET: u32 = 1;
    let siloed_tag = compute_siloed_private_log_first_field(contract_address, da_tag);
    let mut fields: BoundedVec<Field, N> = BoundedVec::new();
    let mut overflow = false;

    for i in 0..tx_effect.private_logs.len() {
        let log = tx_effect.private_logs[i];
        if (log.length > TAG_OFFSET) & (log.fields[TAG_OFFSET] == siloed_tag) {
            for j in PAYLOAD_OFFSET..log.length {
                if (fields.len() < fields.max_len()) {
                    fields.push(log.fields[j]);
                } else {
                    overflow = true;
                }
            }
        }
    }

    if overflow {
        Option::none()
    } else {
        Option::some(fields)
    }
}

#[derive(Deserialize, Eq, Serialize)]
pub struct TEEMetadata {
    pub pub_key_x_hi: Field,
    pub pub_key_x_lo: Field,
    pub pub_key_y_hi: Field,
    pub pub_key_y_lo: Field,
    pub anchor_block_hash: Field,
    pub registration_leaf_index: Field,
}

impl TEEMetadata {
    /// True when every public key half fits the 16 bytes it was split into
    pub fn has_canonical_key_halves(self) -> bool {
        fits_u128(self.pub_key_x_hi)
            & fits_u128(self.pub_key_x_lo)
            & fits_u128(self.pub_key_y_hi)
            & fits_u128(self.pub_key_y_lo)
    }
}

fn fits_u128(value: Field) -> bool {
    ((value as u128) as Field) == value
}

pub unconstrained fn load_tee_metadata_da_capsule(
    address: AztecAddress,
    anchor_block_header: BlockHeader,
) -> TEEMetadata {
    let metadata: TEEMetadata = capsules::load(
        address,
        TEE_METADATA_DA_COMPONENT_CAPSULE_KEY,
        AztecAddress::zero(),
    )
        .unwrap();

    // Validate block hash in the past, just in case we signed over a reorged block hash.
    assert(
        (anchor_block_header.hash() == metadata.anchor_block_hash)
            | is_block_in_archive(anchor_block_header, metadata.anchor_block_hash),
        "Anchor block hash of TEEMetadata is not in the past",
    );
    assert(metadata.has_canonical_key_halves(), "TEEMetadata public key half exceeds 16 bytes");

    metadata
}

pub unconstrained fn extract_metadata_da_component(
    tx_effect: TxEffect,
    contract_address: AztecAddress,
) -> Option<TEEMetadata> {
    let metadata_index = find_tagged_da_component(tx_effect, contract_address, TEE_METADATA_DA_TAG);
    let RESERVED_SIZE_FOR_TAG: u32 = 1;
    metadata_index.and_then(|index| {
        let log = tx_effect.private_logs[index];
        // The full payload must be emitted, otherwise we would read metadata from unauthenticated padding.
        if log.length < RESERVED_SIZE_FOR_TAG + <TEEMetadata as Serialize>::N {
            Option::none()
        } else {
            let metadata = TEEMetadata::deserialize(subarray(log.fields, RESERVED_SIZE_FOR_TAG));
            if metadata.has_canonical_key_halves() {
                Option::some(metadata)
            } else {
                Option::none()
            }
        }
    })
}

unconstrained fn find_tagged_da_component(
    tx_effect: TxEffect,
    contract_address: AztecAddress,
    da_tag: Field,
) -> Option<u32> {
    let TAG_OFFSET: u32 = 0;

    let siloed_tag = compute_siloed_private_log_first_field(contract_address, da_tag);
    aztec::protocol::logging::debug_log_format("Finding tagged DA component: {0}", [da_tag]);
    let mut count = 0;
    let mut index = 0;
    for i in 0..tx_effect.private_logs.len() {
        let log = tx_effect.private_logs[i];
        if (log.length > TAG_OFFSET) & (log.fields[TAG_OFFSET] == siloed_tag) {
            count += 1;
            index = i;
        }
    }
    // We don't allow multiple DA components with the same tag.
    if count == 1 {
        Option::some(index)
    } else {
        Option::none()
    }
}

// These tests are mirrored in yarn-project/oxide-lib/src/da_extractors.test.ts: every case here has a same-named
// test there with equivalent behavior. This helps ensure the enclave and the client perform equivalent validation
// checks.
mod test {
    use super::{
        extract_metadata_da_component, extract_tee_required_nullifiers_da_component,
        extract_tee_withdrawal_message_hashes_da_component,
    };
    use aztec::protocol::{
        abis::private_log::PrivateLog,
        address::AztecAddress,
        blob_data::TxEffect,
        constants::{
            MAX_L2_TO_L1_MSGS_PER_TX, MAX_NULLIFIERS_PER_TX, PRIVATE_LOG_CIPHERTEXT_LEN, PRIVATE_LOG_SIZE_IN_FIELDS,
        },
        hash::compute_siloed_private_log_first_field,
        traits::{Empty, FromField},
    };
    use oxide_lib::constants::{
        TEE_METADATA_DA_TAG, TEE_REQUIRED_NULLIFIERS_DA_TAG, TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
    };

    global TWO_POW_128: Field = 0x100000000000000000000000000000000;
    global METADATA_PAYLOAD: [Field; 6] = [11, 12, 13, 14, 15, 16];
    global FULLY_EMITTED: u32 = 1 + METADATA_PAYLOAD.len();

    unconstrained fn token() -> AztecAddress {
        AztecAddress::from_field(0x1234)
    }

    /// A DA log tagged `da_tag` whose emitted payload is the `count` fields `first, first + 1, ...`.
    unconstrained fn counting_log(da_tag: Field, first: Field, count: u32) -> PrivateLog {
        let mut fields = [0; PRIVATE_LOG_SIZE_IN_FIELDS];
        fields[0] = compute_siloed_private_log_first_field(token(), da_tag);
        for i in 0..count {
            fields[1 + i] = first + i as Field;
        }
        PrivateLog::new(fields, 1 + count)
    }

    /// A metadata log with `emitted` committed fields; the payload sits at fields 1..=6 regardless.
    unconstrained fn metadata_log(payload: [Field; 6], emitted: u32) -> PrivateLog {
        let mut fields = [0; PRIVATE_LOG_SIZE_IN_FIELDS];
        fields[0] = compute_siloed_private_log_first_field(token(), TEE_METADATA_DA_TAG);
        for i in 0..6 {
            fields[1 + i] = payload[i];
        }
        PrivateLog::new(fields, emitted)
    }

    unconstrained fn effect_with<let L: u32>(logs: [PrivateLog; L]) -> TxEffect {
        let mut effect = TxEffect::empty();
        for i in 0..L {
            effect.private_logs[i] = logs[i];
        }
        effect
    }

    #[test]
    unconstrained fn da_set_reads_the_emitted_payload() {
        let effect = effect_with([counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1, 3)]);
        let got = extract_tee_required_nullifiers_da_component(effect, token()).unwrap();
        assert_eq(got.len(), 3);
        assert_eq(got.get(0), 1);
        assert_eq(got.get(1), 2);
        assert_eq(got.get(2), 3);
    }

    #[test]
    unconstrained fn da_set_reads_a_trailing_zero_as_an_element() {
        // A submitter can emit the signed set's own zero padding as an extra element; nothing in the log distinguishes
        // the two. The digest, which covers the element count, is what rejects it.
        let mut log = counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1, 3);
        log.fields[3] = 0;
        let got = extract_tee_required_nullifiers_da_component(effect_with([log]), token()).unwrap();
        assert_eq(got.len(), 3);
        assert_eq(got.get(2), 0);
    }

    #[test]
    unconstrained fn da_set_ignores_a_tag_in_unauthenticated_padding() {
        let mut log = counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1, 3);
        log.length = 0;
        let got = extract_tee_required_nullifiers_da_component(effect_with([log]), token()).unwrap();
        assert_eq(got.len(), 0);
    }

    #[test]
    unconstrained fn da_set_reads_exactly_the_per_tx_cap() {
        let effect = effect_with(
            [
                counting_log(
                    TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
                    1,
                    MAX_L2_TO_L1_MSGS_PER_TX,
                ),
            ],
        );
        let got = extract_tee_withdrawal_message_hashes_da_component(effect, token()).unwrap();
        assert_eq(got.len(), MAX_L2_TO_L1_MSGS_PER_TX);
        assert_eq(got.get(MAX_L2_TO_L1_MSGS_PER_TX - 1), MAX_L2_TO_L1_MSGS_PER_TX as Field);
    }

    #[test]
    unconstrained fn da_set_rejects_more_elements_than_the_per_tx_cap() {
        let effect = effect_with(
            [
                counting_log(
                    TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
                    1,
                    MAX_L2_TO_L1_MSGS_PER_TX + 1,
                ),
            ],
        );
        assert(extract_tee_withdrawal_message_hashes_da_component(effect, token()).is_none());
    }

    #[test]
    unconstrained fn da_set_rejects_the_cap_exceeded_across_two_logs() {
        let effect = effect_with([
            counting_log(
                TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
                1,
                MAX_L2_TO_L1_MSGS_PER_TX,
            ),
            counting_log(TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG, 0xdead, 1),
        ]);
        assert(extract_tee_withdrawal_message_hashes_da_component(effect, token()).is_none());
    }

    #[test]
    unconstrained fn da_set_reads_a_cap_spread_across_full_logs() {
        // 64 nullifiers: four full logs and one carrying the remaining four.
        let full = PRIVATE_LOG_CIPHERTEXT_LEN;
        let rest = MAX_NULLIFIERS_PER_TX - 4 * full;
        let effect = effect_with([
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1, full),
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1 + full as Field, full),
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1 + 2 * full as Field, full),
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1 + 3 * full as Field, full),
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1 + 4 * full as Field, rest),
        ]);
        let got = extract_tee_required_nullifiers_da_component(effect, token()).unwrap();
        assert_eq(got.len(), MAX_NULLIFIERS_PER_TX);
        assert_eq(got.get(MAX_NULLIFIERS_PER_TX - 1), MAX_NULLIFIERS_PER_TX as Field);
    }

    #[test]
    unconstrained fn da_set_rejects_a_cap_spread_across_full_logs_exceeded_by_one() {
        let full = PRIVATE_LOG_CIPHERTEXT_LEN;
        let rest = MAX_NULLIFIERS_PER_TX - 4 * full;
        let effect = effect_with([
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1, full),
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1 + full as Field, full),
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1 + 2 * full as Field, full),
            counting_log(TEE_REQUIRED_NULLIFIERS_DA_TAG, 1 + 3 * full as Field, full),
            counting_log(
                TEE_REQUIRED_NULLIFIERS_DA_TAG,
                1 + 4 * full as Field,
                rest + 1,
            ),
        ]);
        assert(extract_tee_required_nullifiers_da_component(effect, token()).is_none());
    }

    #[test]
    unconstrained fn metadata_reads_a_fully_emitted_log() {
        let effect = effect_with([metadata_log(METADATA_PAYLOAD, FULLY_EMITTED)]);
        let metadata = extract_metadata_da_component(effect, token()).unwrap();
        assert_eq(metadata.pub_key_x_hi, 11);
        assert_eq(metadata.pub_key_x_lo, 12);
        assert_eq(metadata.pub_key_y_hi, 13);
        assert_eq(metadata.pub_key_y_lo, 14);
        assert_eq(metadata.anchor_block_hash, 15);
        assert_eq(metadata.registration_leaf_index, 16);
    }

    #[test]
    unconstrained fn metadata_rejects_a_tag_in_unauthenticated_padding() {
        let effect = effect_with([metadata_log(METADATA_PAYLOAD, 0)]);
        assert(extract_metadata_da_component(effect, token()).is_none());
    }

    #[test]
    unconstrained fn metadata_rejects_a_payload_not_fully_emitted() {
        for emitted in 1..FULLY_EMITTED {
            let effect = effect_with([metadata_log(METADATA_PAYLOAD, emitted)]);
            assert(extract_metadata_da_component(effect, token()).is_none());
        }
    }

    #[test]
    unconstrained fn metadata_rejects_two_tagged_logs() {
        let effect = effect_with([
            metadata_log(METADATA_PAYLOAD, FULLY_EMITTED),
            metadata_log(METADATA_PAYLOAD, FULLY_EMITTED),
        ]);
        assert(extract_metadata_da_component(effect, token()).is_none());
    }

    #[test]
    unconstrained fn metadata_ignores_a_log_of_another_token() {
        let effect = effect_with([metadata_log(METADATA_PAYLOAD, FULLY_EMITTED)]);
        assert(extract_metadata_da_component(effect, AztecAddress::from_field(0x5678)).is_none());
    }

    #[test]
    unconstrained fn metadata_reads_key_halves_at_the_16_byte_boundary() {
        let max_half = TWO_POW_128 - 1;
        let effect = effect_with(
            [
                metadata_log(
                    [max_half, max_half, max_half, max_half, 15, 16],
                    FULLY_EMITTED,
                ),
            ],
        );
        let metadata = extract_metadata_da_component(effect, token()).unwrap();
        assert_eq(metadata.pub_key_y_lo, max_half);
    }

    #[test]
    unconstrained fn metadata_rejects_a_key_half_wider_than_16_bytes() {
        for wide_index in 0..4 {
            let mut payload = METADATA_PAYLOAD;
            payload[wide_index] += TWO_POW_128;
            let effect = effect_with([metadata_log(payload, FULLY_EMITTED)]);
            assert(extract_metadata_da_component(effect, token()).is_none());
        }
    }
}
