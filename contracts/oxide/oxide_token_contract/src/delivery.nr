use super::{
    asserted_note::AssertedNote, deposits::sync_deposits, effects::emit_insertion_effect, immutables::get_immutables,
    validation::validate_note,
};
use aztec::{
    context::{PrivateContext, UtilityContext},
    ephemeral::EphemeralArray,
    keys::ephemeral::generate_positive_ephemeral_key_pair,
    messages::{
        delivery::{do_private_message_delivery, MessageDelivery},
        discovery::{
            ComputeNoteHash, ComputeNoteNullifier, CustomMessageHandler, do_sync_state,
            private_notes::process_private_note_msg,
        },
        encoding::{MAX_MESSAGE_CONTENT_LEN, MESSAGE_CIPHERTEXT_LEN},
        logs::note::{encode_private_note_message_with_msg_type_id, MAX_NOTE_PACKED_LEN},
        msg_type::custom_msg_type_id,
        processing::{offchain::OffchainInboxSync, ResolvedTx, validate_and_store_enqueued_notes_and_events},
    },
    note::{note_interface::{NoteHash, NoteType}, NoteMessage},
    oracle::{get_membership_witness::are_block_hashes_in_archive, message_processing::get_tx_effects, random::random},
    protocol::{
        address::AztecAddress,
        hash::sha256_to_field,
        traits::{Deserialize, FromField, Hash, Packable, Serialize},
    },
    utils::array::subarray,
};

pub(crate) global ASSERTED_NOTE_MSG_TYPE_ID: u64 = custom_msg_type_id(0);

/// Serialization mirror of aztec-nr's crate-private `NoteValidationRequest`, which note discovery pushes and the
/// `validateAndStoreEnqueuedNotesAndEvents` oracle reads. The fields and their order must match.
#[derive(Deserialize, Serialize)]
struct DiscoveredNote {
    contract_address: AztecAddress,
    owner: AztecAddress,
    storage_slot: Field,
    randomness: Field,
    note_nonce: Field,
    max_note_packed_len: Field,
    packed_note: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
    note_hash: Field,
    nullifier: Field,
    tx_hash: Field,
}

pub fn deliver_note(context: &mut PrivateContext, message: NoteMessage<AssertedNote>) {
    let new_note = message.get_new_note();

    do_private_message_delivery(
        context,
        || encode_private_note_message_with_msg_type_id(
            ASSERTED_NOTE_MSG_TYPE_ID,
            new_note.note,
            new_note.owner,
            new_note.storage_slot,
            new_note.randomness,
        ),
        Option::some(new_note.note_hash_counter),
        new_note.owner,
        MessageDelivery::onchain_unconstrained(),
    );

    emit_note_insertion_effect(message);
}

/// Delivers a change note, unless its amount is 0.
///
/// A 0 note adds nothing to a spend, so delivering it would only add to the notes that the owner's wallet keeps and
/// syncs. A 0 change note gets a random log in place of its note message instead, so the transaction has the same
/// logs as a spend with change.
pub fn deliver_change_note(context: &mut PrivateContext, message: NoteMessage<AssertedNote>) {
    if message.get_new_note().note.amount == 0 {
        skip_note_delivery(context, message);
    } else {
        deliver_note(context, message);
    }
}

/// Emits a random log in place of a note message.
///
/// No account can discover the log, and observers cannot tell it from a note message, so the transaction looks the
/// same as when [`deliver_note`] delivers the note. The insertion effect is emitted as in [`deliver_note`], so the
/// enclave signs the note.
fn skip_note_delivery(context: &mut PrivateContext, message: NoteMessage<AssertedNote>) {
    // Safety: The log only has to look like a note message. Nothing reads it.
    let (tag, ciphertext) = unsafe { random_message_log() };
    // Tied to the note like a note message, so that it is squashed in the same cases.
    context.emit_raw_note_log_unsafe(tag, BoundedVec::from_array(ciphertext), message.get_new_note().note_hash_counter);

    emit_note_insertion_effect(message);
}

fn emit_note_insertion_effect(message: NoteMessage<AssertedNote>) {
    let new_note = message.get_new_note();

    // Safety: Offchain effects are by definition unconstrained.
    unsafe {
        emit_insertion_effect(
            new_note.note.amount,
            new_note.owner,
            new_note.note.randomness,
            new_note.storage_slot,
        )
    };
}

/// Returns a random log shaped like a note message.
///
/// No account can discover or decrypt the log.
unconstrained fn random_message_log() -> (Field, [Field; MESSAGE_CIPHERTEXT_LEN]) {
    let mut ciphertext = [0; MESSAGE_CIPHERTEXT_LEN];
    // A message ciphertext starts with the x-coordinate of an ephemeral public key. Approximately half of all field
    // values are not the x-coordinate of a curve point, so a random value would make the log different.
    ciphertext[0] = generate_positive_ephemeral_key_pair().1.x;
    // All other fields of a message ciphertext look uniformly random.
    for i in 1..MESSAGE_CIPHERTEXT_LEN {
        ciphertext[i] = random();
    }
    // A tag is a hash, so a random tag looks like a real one, and no account derives it.
    (random(), ciphertext)
}

unconstrained fn compute_asserted_note_hash(
    packed_note: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
    owner: AztecAddress,
    storage_slot: Field,
    note_type_id: Field,
    _contract_address: AztecAddress,
    randomness: Field,
) -> Option<Field> {
    if (note_type_id == AssertedNote::get_id()) & (packed_note.len() == <AssertedNote as Packable>::N) {
        let note = AssertedNote::unpack(subarray(packed_note.storage(), 0));
        Option::some(note.compute_note_hash(owner, storage_slot, randomness))
    } else {
        Option::none()
    }
}

unconstrained fn compute_asserted_note_nullifier(
    unique_note_hash: Field,
    packed_note: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
    owner: AztecAddress,
    _storage_slot: Field,
    note_type_id: Field,
    _contract_address: AztecAddress,
    _randomness: Field,
) -> Option<Field> {
    if (note_type_id == AssertedNote::get_id()) & (packed_note.len() == <AssertedNote as Packable>::N) {
        let note = AssertedNote::unpack(subarray(packed_note.storage(), 0));
        note.compute_nullifier_unconstrained(owner, unique_note_hash)
    } else {
        Option::none()
    }
}

global NOTE_VALIDATION_REQUESTS_ARRAY_BASE_SLOT: Field = sha256_to_field(
    "AZTEC_NR::NOTE_VALIDATION_REQUESTS_ARRAY_BASE_SLOT".as_bytes(),
);

/// Candidates parked by `note_handler` for the batched validation pass in `sync_state_batched`.
global PENDING_NOTE_VALIDATIONS_SLOT: Field = sha256_to_field("OXIDE_TOKEN::PENDING_NOTE_VALIDATIONS".as_bytes());

/// A candidate that passed every delivery-time check except anchor-ancestry, which is settled for
/// all candidates in one batched oracle call.
#[derive(Deserialize, Serialize)]
struct ValidatedNote {
    request: DiscoveredNote,
    anchor_block_hash: Field,
}

pub unconstrained fn note_handler(
    contract_address: AztecAddress,
    msg_type_id: u64,
    msg_metadata: u64,
    msg_content: BoundedVec<Field, MAX_MESSAGE_CONTENT_LEN>,
    resolved_tx: ResolvedTx,
    recipient: AztecAddress,
) {
    let owner = AztecAddress::from_field(msg_content.get_unchecked(0));

    // Skip unknown message kinds and notes whose owner is not the recipient. A forged log can name another account of
    // the recipient's wallet as owner. Computing that note's nullifier needs the owner's key, which is outside the
    // recipient's sync scope, so the key oracle throws and aborts sync.
    if (msg_type_id == ASSERTED_NOTE_MSG_TYPE_ID) & (owner == recipient) {
        let discovered_notes: EphemeralArray<DiscoveredNote> =
            EphemeralArray::at(NOTE_VALIDATION_REQUESTS_ARRAY_BASE_SLOT);
        let len_before = discovered_notes.len();

        process_private_note_msg(
            contract_address,
            resolved_tx.tx_hash,
            resolved_tx.unique_note_hashes_in_tx,
            resolved_tx.first_nullifier_in_tx,
            compute_asserted_note_hash,
            compute_asserted_note_nullifier,
            msg_metadata,
            msg_content,
        );

        let notes_discovered = discovered_notes.len() - len_before;
        aztec::protocol::logging::debug_log_format(
            "Found {0} notes after processing",
            [notes_discovered as Field],
        );
        if notes_discovered > 1 {
            // Delete all, we don't allow one log discovering multiple notes.
            for _ in 0..notes_discovered {
                let _deleted = discovered_notes.pop();
            }
        } else if notes_discovered == 1 {
            // Park the request; `sync_state_batched` validates all parked candidates at once.
            let note_validation_request = discovered_notes.pop();
            let pending: EphemeralArray<DiscoveredNote> = EphemeralArray::at(PENDING_NOTE_VALIDATIONS_SLOT);
            pending.push(note_validation_request);
        }
    } else {
        aztec::protocol::logging::warn_log_format("Ignoring message with type id {0}", [msg_type_id as Field]);
    }
}

/// `sync_state` body: discovery parks candidates; batched tx-effect and anchor-ancestry checks validate them. Then
/// syncs the deposit hints of `scope`.
pub unconstrained fn sync_state_batched(
    contract_address: AztecAddress,
    _compute_note_hash: ComputeNoteHash,
    _compute_note_nullifier: ComputeNoteNullifier,
    process_custom_message: Option<CustomMessageHandler>,
    offchain_inbox_sync: Option<OffchainInboxSync>,
    scope: AztecAddress,
) {
    let pending: EphemeralArray<DiscoveredNote> = EphemeralArray::empty_at(PENDING_NOTE_VALIDATIONS_SLOT);

    // We must make sure that all `AssertedNote`s we find have been validated by `note_handler`, which is the only route
    // that runs `validate_note`. Any note of this type found in any other message type (e.g. a regular
    // `PRIVATE_NOTE_MSG_TYPE_ID`) would result in _only_ checking note hash existence in the tree, which is
    // insufficient. We therefore pass `compute_note_hash` and `compute_note_nullifier` functions that reject all notes.
    //
    // `note_handler` uses its own hardcoded hash functions, so this doesn't affect it.
    do_sync_state(
        contract_address,
        |_packed_note, _owner, _storage_slot, _note_type_id, _contract_address, _randomness| Option::none(),
        |_unique_note_hash, _packed_note, _owner, _storage_slot, _note_type_id, _contract_address, _randomness| {
            Option::none()
        },
        process_custom_message,
        offchain_inbox_sync,
        scope,
    );
    let pending_count = pending.len();
    if pending_count != 0 {
        // Batched so the node round-trips stay constant per sync instead of per note.
        let effects = get_tx_effects(pending.map(|request: DiscoveredNote| request.tx_hash));
        let immutables = get_immutables(contract_address);

        let passers: EphemeralArray<ValidatedNote> = EphemeralArray::empty();
        for i in 0..pending_count {
            let request = pending.get(i);
            let note = AssertedNote::unpack(subarray(request.packed_note.storage(), 0));
            let maybe_anchor_block_hash = validate_note(
                note,
                contract_address,
                immutables.portal,
                immutables.tee_registry,
                request.storage_slot,
                request.owner,
                effects.get(i),
            );
            if maybe_anchor_block_hash.is_some() {
                passers.push(ValidatedNote { request, anchor_block_hash: maybe_anchor_block_hash.unwrap_unchecked() });
            }
        }

        let passer_count = passers.len();
        if passer_count != 0 {
            let head_header = UtilityContext::new().block_header();
            let head_hash = head_header.hash();
            let in_archive = are_block_hashes_in_archive(
                head_header,
                passers.map(|passer: ValidatedNote| passer.anchor_block_hash),
            );
            let queue: EphemeralArray<DiscoveredNote> = EphemeralArray::at(NOTE_VALIDATION_REQUESTS_ARRAY_BASE_SLOT);
            for i in 0..passer_count {
                let passer = passers.get(i);
                // The head's own hash is never in its archive; accept it by equality.
                if (passer.anchor_block_hash == head_hash) | in_archive.get(i) {
                    aztec::protocol::logging::debug_log("Validated note");
                    queue.push(passer.request);
                } else {
                    aztec::protocol::logging::debug_log("Dropping note whose anchor block hash is not in the chain");
                }
            }
            validate_and_store_enqueued_notes_and_events(scope);
        }
    }

    sync_deposits(contract_address, scope);
}

mod test {
    use super::random_message_log;
    use aztec::{
        messages::{
            encoding::MESSAGE_CIPHERTEXT_LEN,
            encryption::{aes128::AES128, message_encryption::MessageEncryption},
        },
        test::helpers::test_environment::TestEnvironment,
        utils::point::point_from_x_coord,
    };

    // The random log copies two properties of the message format: the ciphertext length, and a first field that is
    // the x-coordinate of a curve point. The type annotation checks the length when this test compiles.
    #[test]
    unconstrained fn random_message_log_has_the_shape_of_a_note_message() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();

        env.private_context(|context| {
            let message: [Field; MESSAGE_CIPHERTEXT_LEN] =
                AES128::encrypt([1, 2, 3], recipient, context.this_address());
            assert(point_from_x_coord(message[0]).is_some());

            // About half of all field values are not the x-coordinate of a curve point, so one sample cannot detect a
            // random first field.
            for _ in 0..32 {
                let (_, ciphertext) = random_message_log();
                assert(point_from_x_coord(ciphertext[0]).is_some());
            }
        });
    }
}
