use aztec::macros::aztec;

mod k1_verify;
mod randomness;
mod recovery;
mod asserted_note;
mod effects;
mod validation;
mod delivery;
mod immutables;
mod da;
mod balance;
mod consume_deposit_message;
mod strict_mode;
mod deposits;
mod utils;
mod test;

/// A token that implements oxide-relevant functionality and that works only with private state (no public balances).
#[aztec(
    ::aztec::macros::AztecConfig::new().custom_message_handler(crate::delivery::note_handler).custom_sync_state(
        crate::delivery::sync_state_batched,
    ),
)]
pub contract OxideToken {
    use crate::{
        asserted_note::AssertedNote,
        balance::preprocess_notes_min_sum,
        consume_deposit_message::consume_deposit_message,
        da::{
            load_tee_metadata_da_capsule, prepare_tee_notes_da_component_logs,
            prepare_tee_required_nullifiers_da_component_logs, prepare_tee_withdrawal_message_hashes_da_component_logs,
        },
        delivery::{deliver_change_note, deliver_note},
        deposits::next_deposits,
        effects::{emit_deposit_effect, emit_nullification_effect, emit_withdrawal_effect},
        immutables::{get_immutables, OxideTokenImmutables},
        randomness::next_randomness,
        recovery::{get_recovery_chunk, get_recovery_chunk_count, next_recovery_chunks_slot},
    };
    use aztec::{
        keys::getters::get_public_keys,
        macros::{events::event, functions::{authorize_once, external, internal, only_self}, storage::storage},
        messages::{delivery::MessageDelivery, logs::event::MAX_EVENT_SERIALIZED_LEN},
        note::{
            lifecycle::destroy_note,
            note_getter_options::{NoteGetterOptions, NoteStatus, SortOrder},
            note_interface::NoteProperties,
        },
        protocol::{
            address::{AztecAddress, EthAddress},
            constants::CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS,
            traits::Serialize,
        },
        state_vars::{Owned, PrivateSet},
    };
    use contract_instance_registry::ContractInstanceRegistry;
    use oxide_lib::constants::{
        TEE_METADATA_DA_TAG, TEE_NOTES_DA_TAG, TEE_REQUIRED_NULLIFIERS_DA_TAG, TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
        TOKEN_UPDATE_DELAY,
    };
    use oxide_token_lib::content_hash::get_withdraw_content_hash;

    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;
    global INITIAL_TRANSFER_CALL_MAX_DEPOSITS: u32 = 2;
    global RECURSIVE_TRANSFER_CALL_MAX_DEPOSITS: u32 = 8;

    pub global TRANSFER_META_LEN: u32 = MAX_EVENT_SERIALIZED_LEN - 3;

    #[event]
    pub struct Transfer {
        pub from: AztecAddress,
        pub to: AztecAddress,
        pub amount: u128,
        /// Blob of data passed through unparsed; its format is an app concern. Sized to fill the
        /// event to the private-event capacity, so it costs no extra DA.
        pub meta: [Field; TRANSFER_META_LEN],
    }

    /// One chunk of withdrawal recovery data. The application defines the content format.
    #[event]
    pub struct WithdrawalRecoveryChunk {
        pub fields: [Field; MAX_EVENT_SERIALIZED_LEN],
    }

    /// Minimum amount of info the recipient needs to find a SIPA and the corresponding deposit.
    #[event]
    pub struct SIPA {
        pub shared_secret_salt: Field,
        pub resweepable: bool,
        pub intent_hash_hi: u128,
        pub intent_hash_lo: u128,
    }

    #[storage]
    struct Storage<Context> {
        balances: Owned<PrivateSet<AssertedNote, Context>, Context>,
    }

    /// Stores this token's immutables in a capsule.
    ///
    /// The call is rejected if the token's address does not commit to the values.
    #[external("utility")]
    unconstrained fn store_immutables(immutables: OxideTokenImmutables) {
        crate::immutables::store_immutables(self.address, immutables);
    }

    /// Sets this token's class-update delay to ~infinity.
    ///
    /// A compromised kernel could forge `msg.sender` and schedule an update of this token's class, which would grief
    /// every user. After this call, a new update takes ~infinity to take effect.
    ///
    /// The token must be locked before it is safe to use. The token is meant to be counterfactual, so it has no
    /// constructor, and the lock is a separate function.
    #[external("private")]
    fn lock_update_delay() {
        ContractInstanceRegistry::at(CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS)
            .set_update_delay(TOKEN_UPDATE_DELAY)
            .enqueue(self.context)
    }

    #[authorize_once("from", "authwit_nonce")]
    #[external("private")]
    fn transfer(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        meta: [Field; TRANSFER_META_LEN],
        authwit_nonce: Field,
    ) {
        let immutables = get_immutables(self.address);
        // No note exceeds the max note amount, which equals the per-tx cap, so every note can exit on L1.
        assert(amount <= immutables.max_note_amount, "amount exceeds max note amount");

        let change = self.internal._subtract_balance(
            from,
            amount,
            INITIAL_TRANSFER_CALL_MAX_NOTES,
            INITIAL_TRANSFER_CALL_MAX_DEPOSITS,
            immutables,
        );

        // Also when the change is 0, so that an exact spend creates the same number of notes as all other spends.
        deliver_change_note(
            self.context,
            self.storage.balances.at(from).insert(AssertedNote::create(self.context, change)),
        );

        deliver_note(
            self.context,
            self.storage.balances.at(to).insert(AssertedNote::create(self.context, amount)),
        );

        let event_msg = self.emit(Transfer { from, to, amount, meta });
        event_msg.deliver_to(to, MessageDelivery::onchain_unconstrained());
        event_msg.deliver_to(from, MessageDelivery::onchain_unconstrained());
    }

    /// Withdraws `amount` from `from`'s private balance.
    ///
    /// # On recovery
    /// The withdrawal owner must be able to recover the withdrawal from onchain data alone: to finalize it if relayers
    /// fail to do so, and to rebuild the activity history for UI purposes when a wallet is restored just from its keys.
    ///
    /// `withdraw` emits the first recovery chunk, and if needed, calls `emit_withdrawal_recovery_chunk` that
    /// recursively emits the rest of the chunks. The chunks come in capsules, not in arguments, so that an authwit for
    /// this call can be signed before the TEE signs (see `recovery.nr`).
    #[authorize_once("from", "authwit_nonce")]
    #[external("private")]
    fn withdraw(
        from: AztecAddress,
        executor: EthAddress,
        user_payload_hash: Field,
        amount: u128,
        prover_tip: u128,
        authwit_nonce: Field,
    ) {
        assert(executor != EthAddress::zero(), "withdraw executor zero");
        assert(prover_tip <= amount, "prover tip exceeds amount");
        let immutables = get_immutables(self.address);
        assert(amount <= immutables.max_note_amount, "amount exceeds max note amount");

        let portal = immutables.portal;

        let change = self.internal._subtract_balance(
            from,
            amount,
            INITIAL_TRANSFER_CALL_MAX_NOTES,
            INITIAL_TRANSFER_CALL_MAX_DEPOSITS,
            immutables,
        );

        // Also when the change is 0. See `transfer`.
        deliver_change_note(
            self.context,
            self.storage.balances.at(from).insert(AssertedNote::create(self.context, change)),
        );

        // Safety: Randomness only keeps this withdrawal's message distinct from the others in this tx. A malicious
        // prover that repeats it produces duplicate messages, which result as a single withdrawal and causes no issues
        // to a recipient.
        let randomness = unsafe { next_randomness(self.context.this_address()) };

        let content_hash = get_withdraw_content_hash(executor, user_payload_hash, amount, prover_tip, randomness);
        self.context.message_portal(portal, content_hash);
        // Safety: Offchain effects are by definition unconstrained.
        unsafe { emit_withdrawal_effect(executor, user_payload_hash, amount, prover_tip, randomness) };

        // Safety: Recovery data is a hint for the owner. Nothing onchain reads it.
        let recovery_chunks_slot = unsafe { next_recovery_chunks_slot() };
        self.internal._emit_withdrawal_recovery_chunks(from, recovery_chunks_slot, 0);
    }

    #[external("private")]
    #[only_self]
    fn emit_withdrawal_recovery_chunk(from: AztecAddress, recovery_chunks_slot: Field, index: u32) {
        self.internal._emit_withdrawal_recovery_chunks(from, recovery_chunks_slot, index);
    }

    /// Emits nullification effects for one page of `owner`'s notes from `offset`.
    /// Used for the frozen-notes refund.
    /// Includes locally nullified notes (they might be spent after freeze in case of soundness bug).
    #[external("private")]
    fn enumerate_owned_notes(owner: AztecAddress, offset: u32) {
        let options = NoteGetterOptions::new().set_status(NoteStatus.ACTIVE_OR_NULLIFIED).set_offset(offset);
        let notes = self.storage.balances.at(owner).get_notes(options);

        for i in 0..options.limit {
            if i < notes.len() {
                // Safety: Offchain effects are by definition unconstrained.
                unsafe { emit_nullification_effect(self.context.this_address(), notes.get_unchecked(i)) };
            }
        }
    }

    /// Notifies recipient of a SIPA and the corresponding deposit.
    ///
    /// Called by the resolver when he resolves a SIPA.
    #[external("private")]
    fn notify_sipa_recipient(
        recipient: AztecAddress,
        shared_secret_salt: Field,
        resweepable: bool,
        intent_hash_hi: u128,
        intent_hash_lo: u128,
    ) {
        self.emit(SIPA { shared_secret_salt, resweepable, intent_hash_hi, intent_hash_lo }).deliver_to(
            recipient,
            MessageDelivery::onchain_unconstrained(),
        );
    }

    #[external("private")]
    fn publish_da() {
        // Safety: DA components are unconstrained.
        let tee_notes_payloads = unsafe { prepare_tee_notes_da_component_logs(self.context.this_address()) };
        for i in 0..tee_notes_payloads.max_len() {
            if i < tee_notes_payloads.len() {
                self.context.emit_private_log_unsafe(TEE_NOTES_DA_TAG, tee_notes_payloads.get_unchecked(i));
            }
        }
        // Safety: DA components are unconstrained.
        let required_nullifiers_payloads =
            unsafe { prepare_tee_required_nullifiers_da_component_logs(self.context.this_address()) };
        for i in 0..required_nullifiers_payloads.max_len() {
            if i < required_nullifiers_payloads.len() {
                self.context.emit_private_log_unsafe(
                    TEE_REQUIRED_NULLIFIERS_DA_TAG,
                    required_nullifiers_payloads.get_unchecked(i),
                );
            }
        }
        // Safety: DA components are unconstrained.
        let withdrawal_message_payloads =
            unsafe { prepare_tee_withdrawal_message_hashes_da_component_logs(self.context.this_address()) };

        for i in 0..withdrawal_message_payloads.max_len() {
            if i < withdrawal_message_payloads.len() {
                self.context.emit_private_log_unsafe(
                    TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
                    withdrawal_message_payloads.get_unchecked(i),
                );
            }
        }

        // Safety: DA components are unconstrained.
        let tee_metadata = unsafe {
            load_tee_metadata_da_capsule(
                self.context.this_address(),
                self.context.get_anchor_block_header(),
            )
        };
        let mut tee_metadata_payload = BoundedVec::new();
        tee_metadata_payload.extend_from_array(tee_metadata.serialize());
        self.context.emit_private_log_unsafe(TEE_METADATA_DA_TAG, tee_metadata_payload);
    }

    #[external("private")]
    #[only_self]
    fn recurse_subtract_balance_internal(
        account: AztecAddress,
        amount: u128,
        immutables: OxideTokenImmutables,
    ) -> u128 {
        self.internal._subtract_balance(
            account,
            amount,
            RECURSIVE_TRANSFER_CALL_MAX_NOTES,
            RECURSIVE_TRANSFER_CALL_MAX_DEPOSITS,
            immutables,
        )
    }

    /// Emits the recovery chunks at capsule array at `recovery_chunks_slot` starting at `index`.
    #[internal("private")]
    fn _emit_withdrawal_recovery_chunks(from: AztecAddress, recovery_chunks_slot: Field, index: u32) {
        // Safety: Recovery data, which includes the number of chunks, is a hint for the owner. Nothing onchain reads it.
        let (recovery_chunk, chunk_count) = unsafe {
            (
                get_recovery_chunk(self.address, recovery_chunks_slot, index),
                get_recovery_chunk_count(self.address, recovery_chunks_slot),
            )
        };
        // Tags with `from` as the sender, so that `from` alone can find the event, also when another account sent the
        // transaction.
        self.emit(WithdrawalRecoveryChunk { fields: recovery_chunk }).deliver_to(
            from,
            MessageDelivery::onchain_unconstrained().with_sender(from),
        );
        if index + 1 < chunk_count {
            self.call_self.emit_withdrawal_recovery_chunk(from, recovery_chunks_slot, index + 1);
        }
    }

    /// Spends notes and deposits until `amount` is reached and returns change amount that is to be credited to the
    /// `account` as a note by the calling function.
    #[internal("private")]
    fn _subtract_balance(
        account: AztecAddress,
        amount: u128,
        max_notes: u32,
        max_deposits: u32,
        immutables: OxideTokenImmutables,
    ) -> u128 {
        let mut subtracted: u128 = 0;
        // Select only enough notes to cover `amount` so change stays below the max note amount.
        let options = NoteGetterOptions::with_preprocessor(preprocess_notes_min_sum, amount)
            .sort(AssertedNote::properties().amount, SortOrder.DESC)
            .set_limit(max_notes);
        let confirmed_notes = self.storage.balances.at(account).get_notes(options);

        for i in 0..options.limit {
            if i < confirmed_notes.len() {
                let confirmed_note = confirmed_notes.get_unchecked(i);
                destroy_note(self.context, confirmed_note);
                // Safety: Offchain effects are by definition unconstrained.
                unsafe { emit_nullification_effect(self.context.this_address(), confirmed_note) };

                subtracted += confirmed_note.note.amount;
            }
        }

        let portal = immutables.portal;

        // We are tracking missing here and getting only the lowest number of necessary deposits for it as due to
        // per-withdrawal caps that are likely to get implemented we want to minimize the size of the resulting change
        // note.
        // TODO(GK-592): If withdrawal cap is abandoned then drop this.
        let missing = if subtracted < amount {
            amount - subtracted
        } else {
            0
        };
        // Safety: `Deposit`s serve only as an unconstrained hint.
        let deposits = unsafe { next_deposits(self.context.this_address(), account, missing, max_deposits) };

        let nhk_app = self.context.request_nhk_app(get_public_keys(account).npk_m_hash);
        for i in 0..max_deposits {
            if i < deposits.len() {
                let deposit = deposits.get_unchecked(i);
                consume_deposit_message(
                    self.context,
                    portal,
                    deposit.shared_secret_salt,
                    account,
                    deposit.amount,
                    deposit.inbox_index,
                    nhk_app,
                );
                // Safety: Offchain effects are by definition unconstrained.
                unsafe {
                    emit_deposit_effect(
                        account,
                        deposit.amount,
                        deposit.shared_secret_salt,
                        deposit.inbox_index,
                        deposit.message_hash,
                    )
                };

                subtracted += deposit.amount;
            }
        }

        if subtracted >= amount {
            let change = subtracted - amount;
            // Preprocessor is unconstrained; this is the hard guarantee that change above the max note amount is never
            // created.
            assert(change <= immutables.max_note_amount, "change exceeds max note amount");
            change
        } else {
            assert(subtracted > 0, "Balance too low");
            self.call_self.recurse_subtract_balance_internal(account, amount - subtracted, immutables)
        }
    }

    /// Verifies if a deposit is legitimate and stores it for later processing.
    #[external("utility")]
    unconstrained fn store_deposit(
        inbox_index: Field,
        amount: u128,
        recipient: AztecAddress,
        shared_secret_salt: Field,
    ) {
        let portal = get_immutables(self.address).portal;
        crate::deposits::store_deposit(
            self.context,
            portal,
            inbox_index,
            amount,
            recipient,
            shared_secret_salt,
        );
    }

    #[external("utility")]
    unconstrained fn balance_of(owner: AztecAddress) -> u128 {
        // Balance is sum of both notes and unspent deposits
        crate::balance::balance_of_with_offset(self.storage.balances.at(owner), 0)
            + crate::deposits::balance(self.context.this_address(), owner)
    }
}
