mod public_key_note;

// SpendingLimitAccount: Schnorr account contract extended with on-chain spending
// controls. Enforces per-transaction amount ceilings, rolling daily volume caps,
// and a recipient allowlist. Parameter changes are timelocked.
//
// Threat model: if the bridge's signing key is compromised, limit the damage.
// An attacker with the key can sign transactions, but the public spending check
// rejects amounts above caps or to unlisted recipients. The entire tx reverts
// atomically if any check fails.
//
// Deployment flow:
//   1. Deploy contract (constructor stores signing key + enqueues public init)
//   2. Call set_recipient() to allowlist recipients before transfers
//   3. Start processing transactions
//
// Build: nargo compile
// Artifact: target/spending_limit_account_contract-SpendingLimitAccount.json

use aztec::macros::aztec;

#[aztec]
pub contract SpendingLimitAccount {
    use aztec::{
        authwit::{
            account::{AccountActions, AccountFeePaymentMethodOptions},
            auth::{compute_authwit_message_hash, compute_authwit_nullifier},
            entrypoint::app::AppPayload,
        },
        context::PrivateContext,
        hash::compute_siloed_nullifier,
        macros::{
            functions::{allow_phase_change, external, initializer, noinitcheck, view},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        oracle::{
            auth_witness::get_auth_witness,
            get_nullifier_membership_witness::get_low_nullifier_membership_witness,
            notes::{get_sender_for_tags, set_sender_for_tags},
        },
        protocol::{
            address::AztecAddress,
            constants::DOM_SEP__TX_NULLIFIER,
            hash::poseidon2_hash_with_separator,
            traits::{Hash, ToField},
        },
        state_vars::{Map, PublicImmutable, PublicMutable, SinglePrivateImmutable},
    };

    use crate::public_key_note::PublicKeyNote;

    // Epoch length for daily spending reset (~24h at 12s/block).
    global BLOCKS_PER_EPOCH: u64 = 7200;

    // Timelock delay for parameter changes (blocks).
    global TIMELOCK_BLOCKS: u64 = 5;

    // Domain separator for combined (payload + spending info) hash.
    // Must match DOM_SEP_SPENDING_LIMIT in the TypeScript entrypoint.
    global DOM_SEP__SPENDING_LIMIT: u32 = 10042;

    #[storage]
    struct Storage<Context> {
        // ---- Schnorr signing key (private, set once) ----
        signing_public_key: SinglePrivateImmutable<PublicKeyNote, Context>,

        // ---- Spending limits (public state) ----
        max_amount_per_tx: PublicMutable<Field, Context>,
        daily_limit: PublicMutable<Field, Context>,

        // ---- Daily spending tracker ----
        daily_spent: PublicMutable<Field, Context>,
        current_epoch: PublicMutable<Field, Context>,

        // ---- Recipient allowlist ----
        recipient_allowlist: Map<AztecAddress, PublicMutable<bool, Context>, Context>,

        // ---- Admin (immutable after init) ----
        admin: PublicImmutable<AztecAddress, Context>,

        // ---- Timelock for pending limit changes ----
        pending_max_amount: PublicMutable<Field, Context>,
        pending_daily_limit: PublicMutable<Field, Context>,
        pending_change_block: PublicMutable<Field, Context>,

        // ---- Initialization flag ----
        initialized: PublicMutable<bool, Context>,
    }

    // ================================================================
    // Constructor
    // ================================================================

    #[external("private")]
    #[initializer]
    fn constructor(
        signing_pub_key_x: Field,
        signing_pub_key_y: Field,
        initial_max_per_tx: Field,
        initial_daily_limit: Field,
        admin_address: AztecAddress,
    ) {
        let pub_key_note = PublicKeyNote {
            x: signing_pub_key_x,
            y: signing_pub_key_y,
        };

        // Safety: oracle calls for tag management, no security impact.
        let original_sender = unsafe { get_sender_for_tags().unwrap_or(self.address) };
        // Safety: setting sender tag for note delivery, no security impact.
        unsafe { set_sender_for_tags(self.address) };

        self.storage
            .signing_public_key
            .initialize(pub_key_note)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        // Safety: restoring original sender tag, no security impact.
        unsafe { set_sender_for_tags(original_sender) };

        // Enqueue public initialization (immediate, no timelock for initial values).
        SpendingLimitAccount::at(self.context.this_address())
            .initialize_public_state(
                initial_max_per_tx,
                initial_daily_limit,
                admin_address,
            )
            .enqueue(self.context);
    }

    #[external("public")]
    #[noinitcheck]
    fn initialize_public_state(
        initial_max_per_tx: Field,
        initial_daily_limit: Field,
        admin_address: AztecAddress,
    ) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(
            caller == self.context.this_address(),
            "Only callable internally",
        );
        assert(!self.storage.initialized.read(), "Already initialized");

        self.storage.max_amount_per_tx.write(initial_max_per_tx);
        self.storage.daily_limit.write(initial_daily_limit);
        self.storage.admin.initialize(admin_address);
        self.storage.initialized.write(true);
    }

    // ================================================================
    // Entrypoint (private) -- called for every user transaction
    // ================================================================

    #[external("private")]
    #[noinitcheck]
    #[allow_phase_change]
    fn entrypoint(
        app_payload: AppPayload,
        fee_payment_method: u8,
        cancellable: bool,
        // Spending limit enforcement: the caller declares the total amount
        // and primary recipient. These are bound to the signed hash.
        declared_amount: Field,
        declared_recipient: AztecAddress,
    ) {
        // Safety: tag management oracle, no security impact.
        unsafe { set_sender_for_tags(self.address) };

        // --- Signature verification ---
        // Sign over the combined hash of (payload + declared spending info).
        // This binds the declared amount/recipient to the payload so an
        // attacker cannot reuse a signature with different spending params.
        let payload_hash = app_payload.hash();
        let combined_hash = poseidon2_hash_with_separator(
            [
                payload_hash,
                declared_amount,
                declared_recipient.to_field(),
            ],
            DOM_SEP__SPENDING_LIMIT,
        );
        let message_hash = compute_authwit_message_hash(
            self.context.this_address(),
            self.context.chain_id(),
            self.context.version(),
            combined_hash,
        );
        assert(
            is_valid_impl(self.context, message_hash),
            "Invalid signature",
        );

        // --- Fee handling (same as standard Schnorr account) ---
        if fee_payment_method
            == AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE
        {
            self.context.set_as_fee_payer();
            self.context.end_setup();
        }
        if fee_payment_method
            == AccountFeePaymentMethodOptions.FEE_JUICE_WITH_CLAIM
        {
            self.context.set_as_fee_payer();
        }

        // --- Execute the actual calls ---
        app_payload.execute_calls(self.context);

        // --- Enqueue public spending checks ---
        // All limit checking happens in public context since spending
        // limits are stored in public state. If limits are exceeded, the
        // entire tx reverts atomically (including the private calls above).
        SpendingLimitAccount::at(self.context.this_address())
            .check_spending_public(declared_amount, declared_recipient)
            .enqueue(self.context);

        // --- Cancellation nullifier ---
        if cancellable {
            let tx_nullifier = poseidon2_hash_with_separator(
                [app_payload.tx_nonce],
                DOM_SEP__TX_NULLIFIER,
            );
            self.context.push_nullifier(tx_nullifier);
        }
    }

    // ================================================================
    // Auth witness verification (for third-party authorization)
    // ================================================================

    #[external("private")]
    #[noinitcheck]
    #[view]
    fn verify_private_authwit(inner_hash: Field) -> Field {
        let actions = AccountActions::init(self.context, is_valid_impl);
        actions.verify_private_authwit(inner_hash)
    }

    // ================================================================
    // Public spending checks (enqueued by entrypoint)
    // ================================================================

    #[external("public")]
    #[noinitcheck]
    fn check_spending_public(
        declared_amount: Field,
        declared_recipient: AztecAddress,
    ) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(
            caller == self.context.this_address(),
            "Only callable internally",
        );
        assert(self.storage.initialized.read(), "Not initialized");

        // --- Per-tx limit ---
        let max_per_tx = self.storage.max_amount_per_tx.read();
        if max_per_tx != 0 {
            assert_amount_within_limit(declared_amount, max_per_tx);
        }

        // --- Recipient allowlist ---
        if declared_recipient != AztecAddress::zero() {
            let allowed = self
                .storage
                .recipient_allowlist
                .at(declared_recipient)
                .read();
            assert(allowed, "Recipient not in allowlist");
        }

        // --- Daily spending limit ---
        let daily_limit = self.storage.daily_limit.read();
        if daily_limit != 0 {
            let current_block = self.context.block_number() as u64;
            let epoch = current_block / BLOCKS_PER_EPOCH;
            let stored_epoch = self.storage.current_epoch.read() as u64;

            let mut spent = if epoch != stored_epoch {
                self.storage.current_epoch.write(epoch as Field);
                0 as Field
            } else {
                self.storage.daily_spent.read()
            };

            spent = spent + declared_amount;
            assert_amount_within_limit(spent, daily_limit);
            self.storage.daily_spent.write(spent);
        }
    }

    // ================================================================
    // Admin functions
    // ================================================================

    #[external("public")]
    fn propose_limits(new_max_per_tx: Field, new_daily_limit: Field) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        self.storage.pending_max_amount.write(new_max_per_tx);
        self.storage.pending_daily_limit.write(new_daily_limit);

        let effective_block =
            (self.context.block_number() as u64 + TIMELOCK_BLOCKS) as Field;
        self.storage.pending_change_block.write(effective_block);
    }

    #[external("public")]
    fn apply_limits() {
        let change_block = self.storage.pending_change_block.read() as u64;
        assert(change_block != 0, "No pending changes");
        assert(
            self.context.block_number() as u64 >= change_block,
            "Timelock not expired",
        );

        self.storage
            .max_amount_per_tx
            .write(self.storage.pending_max_amount.read());
        self.storage
            .daily_limit
            .write(self.storage.pending_daily_limit.read());

        // Clear pending state
        self.storage.pending_max_amount.write(0);
        self.storage.pending_daily_limit.write(0);
        self.storage.pending_change_block.write(0);
    }

    #[external("public")]
    fn set_recipient(recipient: AztecAddress, allowed: bool) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        self.storage
            .recipient_allowlist
            .at(recipient)
            .write(allowed);
    }

    // ================================================================
    // Signature verification (contract library method)
    // ================================================================

    #[contract_library_method]
    fn is_valid_impl(
        context: &mut PrivateContext,
        outer_hash: Field,
    ) -> bool {
        let storage = Storage::init(context);
        let public_key = storage.signing_public_key.get_note();

        // Safety: reading auth witness from oracle is safe -- the
        // signature is verified against the stored public key below.
        let witness: [Field; 64] = unsafe { get_auth_witness(outer_hash) };
        let mut signature: [u8; 64] = [0; 64];
        for i in 0..64 {
            signature[i] = witness[i] as u8;
        }

        let pub_key = std::embedded_curve_ops::EmbeddedCurvePoint {
            x: public_key.x,
            y: public_key.y,
        };
        schnorr::verify_signature(
            pub_key,
            signature,
            outer_hash.to_be_bytes::<32>(),
        )
    }

    // ================================================================
    // Utility (unconstrained)
    // ================================================================

    #[external("utility")]
    unconstrained fn lookup_validity(
        consumer: AztecAddress,
        inner_hash: Field,
    ) -> bool {
        let public_key = self.storage.signing_public_key.view_note();
        let message_hash = compute_authwit_message_hash(
            consumer,
            self.context.chain_id(),
            self.context.version(),
            inner_hash,
        );
        let signature_fields: [Field; 64] = get_auth_witness(message_hash);
        let mut signature: [u8; 64] = [0; 64];
        for i in 0..64 {
            signature[i] = signature_fields[i] as u8;
        }
        let pub_key = std::embedded_curve_ops::EmbeddedCurvePoint {
            x: public_key.x,
            y: public_key.y,
        };
        let valid_in_private = schnorr::verify_signature(
            pub_key,
            signature,
            message_hash.to_be_bytes::<32>(),
        );
        let nullifier = compute_authwit_nullifier(self.address, inner_hash);
        let siloed_nullifier =
            compute_siloed_nullifier(consumer, nullifier);
        let low_nullifier_witness = get_low_nullifier_membership_witness(
            self.context.block_header(),
            siloed_nullifier,
        );
        let is_spent =
            low_nullifier_witness.leaf_preimage.nullifier == siloed_nullifier;
        !is_spent & valid_in_private
    }

    // ================================================================
    // Helpers
    // ================================================================

    #[contract_library_method]
    fn assert_amount_within_limit(amount: Field, limit: Field) {
        let a = amount as u64;
        assert(a as Field == amount, "Amount exceeds u64 range");
        let l = limit as u64;
        assert(l as Field == limit, "Limit exceeds u64 range");
        assert(a <= l, "Amount exceeds spending limit");
    }
}
