use crate::{immutables::OxideTokenImmutables, OxideToken};
use aztec::{
    context::PublicContext,
    messages::logs::event::MAX_EVENT_SERIALIZED_LEN,
    protocol::{
        address::{AztecAddress, EthAddress},
        constants::{CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS, DEFAULT_UPDATE_DELAY, UPDATED_CLASS_IDS_SLOT},
        contract_class_id::ContractClassId,
        traits::{FromField, Serialize},
    },
    state_vars::{DelayedPublicMutable, Map, StateVariable},
    test::helpers::{
        authwit::add_private_authwit_from_call,
        test_environment::{CallPrivateOptions, DeployOptions, TestEnvironment},
    },
};
use compressed_string::FieldCompressedString;
use oxide_lib::constants::{BALANCES_STORAGE_SLOT, TOKEN_UPDATE_DELAY};

global TRANSFER_META_LEN: u32 = OxideToken::TRANSFER_META_LEN;

pub global MAX_NOTE_AMOUNT: u128 = 2_583_000_000_000_000_000_000;
global OVER_CAP: u128 = MAX_NOTE_AMOUNT + 1;

#[test]
fn storage_layout_matches_shared_slots() {
    assert_eq(OxideToken::storage_layout().balances.slot, BALANCES_STORAGE_SLOT);
}

// Meta must exactly fill the free capacity of the event's private log: any less wastes padding, any more would not
// compile (aztec-nr statically rejects oversized private events). Guards the base-field count baked into the
// TRANSFER_META_LEN derivation: if from/to/amount ever serialize to something other than 3 fields, this fails.
#[test]
fn transfer_event_fills_private_event_capacity() {
    assert_eq(<OxideToken::Transfer as Serialize>::N, MAX_EVENT_SERIALIZED_LEN);
}

// Pins the event wire format: the serialization recipients decode from `getPrivateEvents`. Hardcodes today's 7-field
// meta, so a protocol change that resizes the capacity surfaces here as a deliberate edit.
#[test]
fn transfer_event_serialized_format() {
    let event = OxideToken::Transfer {
        from: AztecAddress::from_field(1),
        to: AztecAddress::from_field(2),
        amount: 3,
        meta: [4, 5, 6, 7, 8, 9, 10],
    };
    assert_eq(event.serialize(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

#[test]
fn withdrawal_recovery_chunk_fills_private_event_capacity() {
    assert_eq(<OxideToken::WithdrawalRecoveryChunk as Serialize>::N, MAX_EVENT_SERIALIZED_LEN);
}

unconstrained fn default_immutables() -> OxideTokenImmutables {
    OxideTokenImmutables {
        portal: EthAddress::zero(),
        tee_registry: EthAddress::zero(),
        name: FieldCompressedString::from_string("OxideToken                     "),
        symbol: FieldCompressedString::from_string("ATKN                           "),
        decimals: 18,
        max_note_amount: MAX_NOTE_AMOUNT,
    }
}

/// Deploys a token and stores its immutables like a wallet.
unconstrained fn deploy_token(env: &mut TestEnvironment) -> AztecAddress {
    let immutables = default_immutables();
    // No keys, like a real token.
    let token = env
        .deploy_opts(DeployOptions::new().with_immutables_hash(immutables.hash()).with_secret(0), "OxideToken")
        .without_initializer();
    env.execute_utility(OxideToken::at(token).store_immutables(immutables));
    token
}

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let token = deploy_token(&mut env);

    (env, token, alice, bob)
}

// Like `setup`, but `alice` is a real account contract so her account can validate authwits.
unconstrained fn setup_with_authwit_account() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let alice = env.create_contract_account();
    let bob = env.create_light_account();
    let token = deploy_token(&mut env);

    (env, token, alice, bob)
}

type UpdatedClassId = DelayedPublicMutable<ContractClassId, DEFAULT_UPDATE_DELAY, PublicContext>;

#[test]
unconstrained fn lock_update_delay_sets_the_update_delay() {
    let (env, token, alice, _bob) = setup();
    env.call_private(alice, OxideToken::at(token).lock_update_delay());

    let delay = env.public_context_at(CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS, |context| {
        let updated_class_ids: Map<AztecAddress, UpdatedClassId, PublicContext> =
            Map::new(context, UPDATED_CLASS_IDS_SLOT as Field);
        updated_class_ids.at(token).get_current_delay()
    });
    assert_eq(delay, TOKEN_UPDATE_DELAY);
}

#[test(should_fail_with = "amount exceeds max note amount")]
unconstrained fn transfer_over_cap_is_rejected() {
    let (env, token, alice, bob) = setup();
    let _ = env.call_private(alice, OxideToken::at(token).transfer(alice, bob, OVER_CAP, [0; TRANSFER_META_LEN], 0));
}

#[test(should_fail_with = "amount exceeds max note amount")]
unconstrained fn withdraw_over_cap_is_rejected() {
    let (env, token, alice, _bob) = setup();
    let _ =
        env.call_private(alice, OxideToken::at(token).withdraw(alice, EthAddress::from_field(1), 0, OVER_CAP, 0, 0));
}

#[test(should_fail_with = "withdraw executor zero")]
unconstrained fn withdraw_zero_executor_is_rejected() {
    let (env, token, alice, _bob) = setup();
    let _ = env.call_private(alice, OxideToken::at(token).withdraw(alice, EthAddress::zero(), 0, 1, 0, 0));
}

#[test(should_fail_with = "prover tip exceeds amount")]
unconstrained fn withdraw_excess_prover_tip_is_rejected() {
    let (env, token, alice, _bob) = setup();
    let _ = env.call_private(alice, OxideToken::at(token).withdraw(alice, EthAddress::from_field(1), 0, 1, 2, 0));
}

// A valid authwit failing on "Balance too low" proves the authwit check passed: the balance subtraction runs after it.
#[test(should_fail_with = "Balance too low")]
unconstrained fn transfer_on_behalf_of_other_with_authwit() {
    let (env, token, alice, bob) = setup_with_authwit_account();
    // Nonzero meta so the authwit hash provably covers it.
    let call = OxideToken::at(token).transfer(alice, bob, 100, [1, 2, 3, 4, 5, 6, 7], 1);
    add_private_authwit_from_call(env, alice, bob, call);
    // Scope alice in so her account contract can read its signing-key note when validating the authwit.
    let _ = env.call_private_opts(bob, CallPrivateOptions::new().with_additional_scopes([alice]), call);
}

#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn transfer_on_behalf_of_other_without_authwit() {
    let (env, token, alice, bob) = setup_with_authwit_account();
    let call = OxideToken::at(token).transfer(alice, bob, 100, [0; TRANSFER_META_LEN], 1);
    let _ = env.call_private_opts(bob, CallPrivateOptions::new().with_additional_scopes([alice]), call);
}

#[test(should_fail_with = "Invalid authwit nonce")]
unconstrained fn transfer_self_with_nonzero_nonce_is_rejected() {
    let (env, token, alice, bob) = setup();
    let _ = env.call_private(alice, OxideToken::at(token).transfer(alice, bob, 1, [0; TRANSFER_META_LEN], 1));
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn withdraw_on_behalf_of_other_with_authwit() {
    let (env, token, alice, bob) = setup_with_authwit_account();
    let call = OxideToken::at(token).withdraw(alice, EthAddress::from_field(1), 0, 100, 0, 1);
    add_private_authwit_from_call(env, alice, bob, call);
    let _ = env.call_private_opts(bob, CallPrivateOptions::new().with_additional_scopes([alice]), call);
}

#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn withdraw_on_behalf_of_other_without_authwit() {
    let (env, token, alice, bob) = setup_with_authwit_account();
    let call = OxideToken::at(token).withdraw(alice, EthAddress::from_field(1), 0, 100, 0, 1);
    let _ = env.call_private_opts(bob, CallPrivateOptions::new().with_additional_scopes([alice]), call);
}

// ============================================================================================================
// OX-1101 built-in-note-route seal: intended regression test — LEFT FOR DEBUGGING, does not yet discriminate.
// ============================================================================================================
//
// What it is meant to prove
//   `sync_state_batched` (delivery.nr) passes note-hash/nullifier callbacks that always return `Option::none()`
//   into `do_sync_state`, so the aztec-nr built-in note route (message type `PRIVATE_NOTE_MSG_TYPE_ID`) can never
//   store an `AssertedNote`. Only `note_handler` stores notes, and only after `validate_note`. This test delivers a
//   note to bob under the built-in message type and asserts bob's wallet never stores it.
//
// How to run
//   ./noir-projects/bootstrap.sh oxide_token_contract              # build the artifact the TXE deploys
//   (cd noir-projects/oxide_token_contract && \
//      LOG_LEVEL=error aztec-nargo test \
//        --oracle-resolver http://127.0.0.1:8081 built_in_note_route_bypass_is_rejected --show-output)
//   # A TXE oracle resolver must be listening on 8081; ./noir-projects/bootstrap.sh test starts one.
//
// Expected, if it discriminated
//   With the fix (current code): the built-in route rejects the note, so bob stores 0 -> the assert passes.
//   Reverting the fix — replace the two inline `Option::none()` closures at the `do_sync_state` call in
//   `delivery.nr::sync_state_batched` with `_compute_note_hash, _compute_note_nullifier` — should make the built-in
//   route store the note, so bob stores 1 and this test FAILS.
//
// Actual (the bug to debug)
//   Both with and without the fix, bob stores 0, so the test passes either way and does NOT guard the fix.
//   Debug logs (LOG_LEVEL=debug) show why: even reverted, the injected message is dropped at discovery with
//   "Unable to compute note hash for note of id 0 ...", i.e. the hand-crafted plaintext does not round-trip through
//   the built-in decoder as a valid `AssertedNote`. The `println` below prints the observed stored-note count.
//   To make this a real regression test, get the injected message to be accepted by the built-in route when the fix
//   is reverted — likely the packed-note length or note-type-id encoding (`AssertedNote::get_id()`), or the way the
//   creation tx's note hash is matched during nonce discovery.

use crate::asserted_note::AssertedNote;
use crate::delivery::ASSERTED_NOTE_MSG_TYPE_ID;
use crate::randomness::OXIDE_TOKEN_SEED_CAPSULE_SLOT;
use aztec::messages::{
    encryption::{aes128::AES128, message_encryption::MessageEncryption},
    logs::note::encode_private_note_message_with_msg_type_id,
    msg_type::PRIVATE_NOTE_MSG_TYPE_ID,
    processing::offchain::OffchainMessage,
};
use aztec::oracle::capsules;
use aztec::test::helpers::txe_oracles;
use oxide_lib::constants::{ACCOUNTING_EFFECT_IDENTIFIER, INSERTION_EFFECT_TYPE, NULLIFICATION_EFFECT_TYPE};

/// Number of accounting effects of type `typ` emitted by the last top-level call.
unconstrained fn count_accounting_effects(typ: u8) -> u32 {
    let effects = txe_oracles::get_last_call_offchain_effects();
    let mut count = 0;
    for i in 0..effects.len() {
        let e = effects.get(i);
        if (e.get(0) == ACCOUNTING_EFFECT_IDENTIFIER) & (e.get(1) == typ as Field) {
            count += 1;
        }
    }
    count
}

/// The `(amount, randomness, storage_slot)` of the single note the last top-level call inserted for `owner`.
unconstrained fn single_inserted_note(owner: AztecAddress) -> (u128, Field, Field) {
    let effects = txe_oracles::get_last_call_offchain_effects();
    let mut found: Option<(u128, Field, Field)> = Option::none();
    for i in 0..effects.len() {
        let e = effects.get(i);
        if (e.get(0) == ACCOUNTING_EFFECT_IDENTIFIER)
            & (e.get(1) == INSERTION_EFFECT_TYPE as Field)
            & (AztecAddress::from_field(e.get(3)) == owner) {
            assert(found.is_none(), "expected exactly one inserted note");
            found = Option::some((e.get(2) as u128, e.get(4), e.get(5)));
        }
    }
    found.expect(f"expected exactly one inserted note")
}

#[test]
unconstrained fn built_in_note_route_bypass_is_rejected() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    // A full account contract, so bob's keys are available to compute the note nullifier during sync.
    let bob = env.create_contract_account();
    let token = deploy_token(&mut env);

    // Note randomness is drawn from this seed capsule.
    env.utility_context_at(token, |context| {
        capsules::store(
            context.this_address(),
            OXIDE_TOKEN_SEED_CAPSULE_SLOT,
            0x5eed,
            AztecAddress::zero(),
        );
    });

    // A zero-amount transfer inserts an unsigned note for bob without alice holding any balance. This note is the
    // one a griefer would re-deliver under the built-in message type.
    let _ = env.call_private(alice, OxideToken::at(token).transfer(alice, bob, 0, [0; TRANSFER_META_LEN], 0));
    let creation = txe_oracles::get_last_call_context();
    let (amount, randomness, storage_slot) = single_inserted_note(bob);

    // The same note, encoded the way the framework's own note route expects and labeled with the built-in type id.
    let note = AssertedNote { amount, randomness, signature: std::mem::zeroed() };
    let plaintext = encode_private_note_message_with_msg_type_id(PRIVATE_NOTE_MSG_TYPE_ID, note, bob, storage_slot, 0);
    let ciphertext = AES128::encrypt(plaintext, bob, token);
    let message = OffchainMessage {
        ciphertext: BoundedVec::from_array(ciphertext),
        recipient: bob,
        tx_hash: creation.tx_hash,
        anchor_block_timestamp: creation.anchor_block_timestamp,
    };
    env.execute_utility(OxideToken::at(token).offchain_receive(BoundedVec::from_array([message])));

    // `enumerate_owned_notes` runs bob's sync first, then emits one nullification effect per note bob's wallet holds.
    let _ = env.call_private_opts(
        bob,
        CallPrivateOptions::new().with_additional_scopes([bob]),
        OxideToken::at(token).enumerate_owned_notes(bob, 0),
    );
    let stored = count_accounting_effects(NULLIFICATION_EFFECT_TYPE);
    println(
        f"OX-1101 built-in-route: bob stored {stored} note(s) (fix => 0; a working test would show 1 when reverted)",
    );
    assert_eq(stored, 0);
}

#[test]
unconstrained fn forged_note_message_for_another_owner_is_ignored() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    let bob = env.create_contract_account();
    let token = deploy_token(&mut env);

    env.utility_context_at(token, |context| {
        capsules::store(
            context.this_address(),
            OXIDE_TOKEN_SEED_CAPSULE_SLOT,
            0x5eed,
            AztecAddress::zero(),
        );
    });

    // Create a real note for bob.
    let _ = env.call_private(alice, OxideToken::at(token).transfer(alice, bob, 0, [0; TRANSFER_META_LEN], 0));
    let creation = txe_oracles::get_last_call_context();
    let (amount, randomness, storage_slot) = single_inserted_note(bob);

    // Send bob's note to alice, with bob still as the owner.
    let note = AssertedNote { amount, randomness, signature: std::mem::zeroed() };
    let plaintext = encode_private_note_message_with_msg_type_id(ASSERTED_NOTE_MSG_TYPE_ID, note, bob, storage_slot, 0);
    let ciphertext = AES128::encrypt(plaintext, alice, token);
    let message = OffchainMessage {
        ciphertext: BoundedVec::from_array(ciphertext),
        recipient: alice,
        tx_hash: creation.tx_hash,
        anchor_block_timestamp: creation.anchor_block_timestamp,
    };
    env.execute_utility(OxideToken::at(token).offchain_receive(BoundedVec::from_array([message])));

    // Alice's sync runs before this call, so the call succeeds only if sync survives the message.
    let _ = env.call_private_opts(
        alice,
        CallPrivateOptions::new().with_additional_scopes([alice]),
        OxideToken::at(token).enumerate_owned_notes(alice, 0),
    );
    assert_eq(count_accounting_effects(NULLIFICATION_EFFECT_TYPE), 0);
}
