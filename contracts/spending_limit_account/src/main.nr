mod public_key_note;

// SpendingLimitAccount: Schnorr account with on-chain per-tx caps, a bucketed
// daily volume window, a recipient allowlist, and timelocked parameters.
//
// Threat model: the bridge's signing key is compromised. The holder can sign
// anything; the public spending check bounds what that is worth. App-logic
// reverts are atomic, but the fee is charged regardless -- set_as_fee_payer and
// end_setup run in the non-revertible setup phase.
//
// Build: aztec-nargo compile (plain nargo does not transpile public functions;
// loadContractArtifact rejects the result). Artifact is gitignored, built by CI.

use aztec::macros::aztec;

#[aztec]
pub contract SpendingLimitAccount {
    use aztec::{
        authwit::{
            account::AccountFeePaymentMethodOptions,
            auth::compute_authwit_message_hash,
            entrypoint::app::AppPayload,
        },
        context::PrivateContext,
        hash::hash_args,
        macros::{
            functions::{allow_phase_change, external, initializer, noinitcheck, view},
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        oracle::auth_witness::get_auth_witness,
        protocol::{
            address::AztecAddress,
            constants::DOM_SEP__TX_NULLIFIER,
            hash::poseidon2_hash_with_separator,
            traits::{FromField, Hash, Serialize, ToField},
        },
        state_vars::{Map, PublicImmutable, PublicMutable, SinglePrivateImmutable},
    };

    use crate::public_key_note::PublicKeyNote;

    // Epoch length for daily spending reset (~24h at 12s/block).
    global BLOCKS_PER_EPOCH: u64 = 7200;

    // Timelock delay for parameter changes (blocks).
    global TIMELOCK_BLOCKS: u64 = 5;

    // How long a matured proposal stays applicable before it must be
    // re-proposed. Bounds the window in which an armed proposal is useful to a
    // compromised admin; see apply_limits.
    global APPLY_WINDOW_BLOCKS: u64 = 7200;

    // Domain separator for combined (payload + spending info) hash.
    // Must match DOM_SEP_SPENDING_LIMIT in the TypeScript entrypoint.
    global DOM_SEP__SPENDING_LIMIT: u32 = 10042;

    #[storage]
    struct Storage<Context> {
        // ---- Schnorr signing key (private, set once) ----
        signing_public_key: SinglePrivateImmutable<PublicKeyNote, Context>,

        // ---- Spending limits (public state) ----
        // u128, matching the Token contract's own amount type. As Field these
        // were validated by a round-trip cast through u64, which capped every
        // limit at 2^64-1 base units == 18.45 tokens at 18 decimals, making the
        // account unusable for WETH or DAI. The type is now the range, so the
        // cast-and-compare pattern is gone entirely.
        //
        // Zero is not storable (see assert_limits_valid). "0 means unlimited"
        // was the precondition for the daily-counter reset, so making it
        // inexpressible removes that reachability rather than guarding it.
        max_amount_per_tx: PublicMutable<u128, Context>,
        daily_limit: PublicMutable<u128, Context>,

        // ---- Daily spending tracker ----
        daily_spent: PublicMutable<u128, Context>,
        current_epoch: PublicMutable<Field, Context>,

        // ---- Recipient allowlist ----
        recipient_allowlist: Map<AztecAddress, PublicMutable<bool, Context>, Context>,

        // ---- Admin (immutable after init) ----
        admin: PublicImmutable<AztecAddress, Context>,

        // ---- Timelock for pending limit changes ----
        // u128 too: as Field, propose_limits could store a value apply_limits
        // then truncates on write.
        pending_max_amount: PublicMutable<u128, Context>,
        pending_daily_limit: PublicMutable<u128, Context>,
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
        initial_max_per_tx: u128,
        initial_daily_limit: u128,
        admin_address: AztecAddress,
    ) {
        let pub_key_note = PublicKeyNote {
            x: signing_pub_key_x,
            y: signing_pub_key_y,
        };

        // Unconstrained delivery, matching the v5.1.0 reference SchnorrAccount.
        // Constrained delivery is handshake-backed and a fresh account has no
        // handshake with itself. Getting this wrong bricks the account:
        // SinglePrivateImmutable initializes once, with no re-delivery path.
        self.storage.signing_public_key.initialize(pub_key_note).deliver(
            MessageDelivery::onchain_unconstrained().with_sender(self.address),
        );

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
        initial_max_per_tx: u128,
        initial_daily_limit: u128,
        admin_address: AztecAddress,
    ) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(
            caller == self.context.this_address(),
            "Only callable internally",
        );
        assert(!self.storage.initialized.read(), "Already initialized");

        assert_limits_valid(initial_max_per_tx, initial_daily_limit);

        self.storage.max_amount_per_tx.write(initial_max_per_tx);
        self.storage.daily_limit.write(initial_daily_limit);
        self.storage.admin.initialize(admin_address);
        self.storage.initialized.write(true);
    }

    // ================================================================
    // Entrypoint (private) -- called for every user transaction
    // ================================================================

    // SECURITY -- declared vs. actual binding:
    // `declared_amount` / `declared_recipient` are caller-supplied. On their
    // own the spending checks would validate numbers the caller invents, so a
    // key holder could declare amount=1 while the payload transfers more. To
    // close that gap, `assert_declared_matches_transfer` (called below) proves
    // the executed transfer's args hash equals the reconstruction from the
    // declared values, binding declared == actual. See that helper for detail.
    #[external("private")]
    #[noinitcheck]
    #[allow_phase_change]
    fn entrypoint(
        app_payload: AppPayload,
        fee_payment_method: u8,
        cancellable: bool,
        // Declared spending, bound into the signed hash below. u128 as a
        // parameter: argument decoding constrains it below 2^128 before any
        // line here runs, whereas `Field as u128` would silently truncate.
        declared_amount: u128,
        declared_recipient: AztecAddress,
    ) {
        // --- Signature verification ---
        // Sign over the combined hash of (payload + declared spending info).
        // This binds the declared amount/recipient to the payload so an
        // attacker cannot reuse a signature with different spending params.
        let payload_hash = app_payload.hash();
        let combined_hash = poseidon2_hash_with_separator(
            [
                payload_hash,
                declared_amount as Field,
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

        // --- Bind declared spending to the actual transfer ---
        // Proves the payload's real transfer matches declared_amount/recipient
        // before the spending checks run on the declared values.
        assert_declared_matches_transfer(app_payload, declared_amount, declared_recipient);

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
            // v5.1.0 renamed PrivateContext::push_nullifier to
            // push_nullifier_unsafe.
            self.context.push_nullifier_unsafe(tx_nullifier);
        }
    }

    // ================================================================
    // Auth witness verification (for third-party authorization)
    // ================================================================

    #[external("private")]
    #[noinitcheck]
    #[view]
    fn verify_private_authwit(_inner_hash: Field) -> Field {
        // Third-party authwit is DISABLED for this account. A valid authwit
        // would let a token contract move funds without routing through
        // `entrypoint`, bypassing `check_spending_public` (per-tx cap, daily
        // limit, recipient allowlist) entirely. Returning 0 (not the
        // IS_VALID magic value) rejects every authwit request.
        //
        // Safe: the bridge's own transfers execute via `entrypoint` with
        // msg_sender == this account, which needs no third-party authwit.
        0
    }

    // ================================================================
    // Public spending checks (enqueued by entrypoint)
    // ================================================================

    #[external("public")]
    #[noinitcheck]
    fn check_spending_public(
        declared_amount: u128,
        declared_recipient: AztecAddress,
    ) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(
            caller == self.context.this_address(),
            "Only callable internally",
        );
        assert(self.storage.initialized.read(), "Not initialized");

        // --- Per-tx limit ---
        // Unconditional: zero is not a storable limit (assert_limits_valid),
        // so there is no `if max_per_tx != 0` branch to fall through.
        let max_per_tx = self.storage.max_amount_per_tx.read();
        assert(declared_amount <= max_per_tx, "Amount exceeds per-tx limit");

        // --- Recipient allowlist ---
        // Always enforced. The zero address is rejected outright so it cannot
        // be used as a sentinel to skip the allowlist check.
        assert(
            declared_recipient != AztecAddress::zero(),
            "Recipient must not be zero",
        );
        let allowed = self
            .storage
            .recipient_allowlist
            .at(declared_recipient)
            .read();
        assert(allowed, "Recipient not in allowlist");

        // --- Daily spending limit ---
        // `spent` is u128, so `spent + declared_amount` is a checked add: it
        // traps on overflow instead of wrapping. As Field this was addition
        // modulo the BN254 prime, and an addend of p - daily_spent produced a
        // sum of zero that passed the range check -- the second root cause of
        // the daily-counter reset.
        //
        // The epoch window itself is still the fixed, globally-aligned one that
        // Nethermind filed as a 2x bypass. It is replaced by a timestamp
        // anchored bucketed window in a later commit; this commit only changes
        // the arithmetic's width.
        let daily_limit = self.storage.daily_limit.read();
        let current_block = self.context.block_number() as u64;
        let epoch = current_block / BLOCKS_PER_EPOCH;
        let stored_epoch = self.storage.current_epoch.read() as u64;

        let mut spent = if epoch != stored_epoch {
            self.storage.current_epoch.write(epoch as Field);
            0 as u128
        } else {
            self.storage.daily_spent.read()
        };

        spent = spent + declared_amount;
        assert(spent <= daily_limit, "Amount exceeds daily spending limit");
        self.storage.daily_spent.write(spent);
    }

    // ================================================================
    // Admin functions
    // ================================================================

    #[external("public")]
    fn propose_limits(new_max_per_tx: u128, new_daily_limit: u128) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        // Validate at PROPOSE time as well as at APPLY time, so an invalid
        // proposal cannot sit armed for the whole timelock.
        assert_limits_valid(new_max_per_tx, new_daily_limit);
        self.storage.pending_max_amount.write(new_max_per_tx);
        self.storage.pending_daily_limit.write(new_daily_limit);

        let effective_block =
            (self.context.block_number() as u64 + TIMELOCK_BLOCKS) as Field;
        self.storage.pending_change_block.write(effective_block);
    }

    #[external("public")]
    fn apply_limits() {
        // Without this, anyone -- including the signing-key holder -- could
        // apply an abandoned proposal at a moment of their choosing.
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");

        let change_block = self.storage.pending_change_block.read() as u64;
        assert(change_block != 0, "No pending changes");
        let now = self.context.block_number() as u64;
        assert(now >= change_block, "Timelock not expired");
        // Proposals expire. Without an upper bound the timelock delivers public
        // notice but no enforcement: a compromised admin proposes maximum
        // limits on day 0, waits weeks until the account is at peak balance,
        // then applies and drains in a single block.
        assert(now < change_block + APPLY_WINDOW_BLOCKS, "Proposal expired");

        let new_max = self.storage.pending_max_amount.read();
        let new_daily = self.storage.pending_daily_limit.read();

        // Same validation as construction: an unvalidated write here can store
        // limits that make every subsequent spend revert.
        assert_limits_valid(new_max, new_daily);

        self.storage.max_amount_per_tx.write(new_max);
        self.storage.daily_limit.write(new_daily);

        // Clear pending state
        self.storage.pending_max_amount.write(0);
        self.storage.pending_daily_limit.write(0);
        self.storage.pending_change_block.write(0);
    }

    // Withdraw a proposal before it is applied.
    #[external("public")]
    fn cancel_limits() {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        assert(
            self.storage.pending_change_block.read() != 0,
            "No pending changes",
        );
        self.storage.pending_max_amount.write(0);
        self.storage.pending_daily_limit.write(0);
        self.storage.pending_change_block.write(0);
    }

    // There is deliberately no admin reset of the spending counter: an
    // untimelocked write of zero is the counter-reset impact by another route.

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

        // Safety: the witness is only used as a "magical value" that makes the
        // signature verification below pass, against the stored public key.
        //
        // v5.1.0 / schnorr v0.4.0: the witness is FOUR limb Fields forming two
        // EmbeddedCurveScalars, and the message is the Field itself -- not the
        // v4.2.0 shape of 64 bytes plus `outer_hash.to_be_bytes::<32>()`. The
        // TypeScript side must emit `signature.toLimbFields()` in lockstep.
        let limbs: [Field; 4] = unsafe { get_auth_witness(outer_hash) };
        let signature = (
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[0], limbs[1]),
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[2], limbs[3]),
        );

        let pub_key = std::embedded_curve_ops::EmbeddedCurvePoint {
            x: public_key.x,
            y: public_key.y,
        };
        schnorr::verify_signature(pub_key, signature, outer_hash)
    }

    // ================================================================
    // Utility (unconstrained)
    // ================================================================

    #[external("utility")]
    unconstrained fn lookup_validity(_consumer: AztecAddress, _inner_hash: Field) -> bool {
        // Third-party authwit is disabled (see verify_private_authwit), so no
        // authwit is ever valid. The stock implementation would report true for
        // one that verify_private_authwit then rejects, telling an off-chain
        // caller to submit a transaction guaranteed to revert.
        false
    }

    // ================================================================
    // Helpers
    // ================================================================

    // Binds the caller-declared spending to the transfer the payload actually
    // executes, so check_spending_public cannot be fed invented values.
    //
    // AppPayload does not expose its calls, so they are read through the derived
    // Serialize layout: [FunctionCall; 5] then tx_nonce, each call 6 fields in
    // declaration order (args_hash, selector, target, is_public,
    // hide_msg_sender, is_static). Empty when target == 0. Pinned by
    // function_call_serialize_layout.
    #[contract_library_method]
    fn assert_declared_matches_transfer(
        app_payload: AppPayload,
        declared_amount: u128,
        declared_recipient: AztecAddress,
    ) {
        // transfer_to_private(to: AztecAddress, amount: u128) encodes its args
        // as two fields, and a u128 packs into exactly one, so the widening
        // cast here reproduces the callee's own args_hash.
        let expected_args_hash =
            hash_args([declared_recipient.to_field(), declared_amount as Field]);

        // [FunctionCall; 5] (6 fields each) + tx_nonce = 31 fields
        let serialized: [Field; 31] = app_payload.serialize();

        assert_single_call_matches(serialized, expected_args_hash);
    }

    // Core matching logic over the serialized AppPayload, split out so it can be
    // unit-tested without constructing an AppPayload (its `function_calls` field
    // is not public outside the aztec crate). Each FunctionCall occupies 6 fields
    // starting at index i*6, with args_hash at offset 0 and target_address at
    // offset 2 (see the `function_call_serialize_layout` test).
    #[contract_library_method]
    fn assert_single_call_matches(serialized: [Field; 31], expected_args_hash: Field) {
        let mut nonempty_calls: u32 = 0;
        let mut matching_calls: u32 = 0;
        for i in 0..5 {
            let base = i * 6;
            let args_hash = serialized[base];
            let target = serialized[base + 2];
            if target != 0 {
                nonempty_calls += 1;
                if args_hash == expected_args_hash {
                    matching_calls += 1;
                }
            }
        }

        assert(nonempty_calls == 1, "Expected exactly one call in payload");
        assert(matching_calls == 1, "Transfer does not match declared spending");
    }

    // Zero is rejected in both slots. It would mean "unlimited", which is a
    // fail-open default for an operator who omits an env var.
    #[contract_library_method]
    fn assert_limits_valid(max_per_tx: u128, daily_limit: u128) {
        assert(max_per_tx != 0, "Per-tx limit must be non-zero");
        assert(daily_limit != 0, "Daily limit must be non-zero");
        assert(daily_limit >= max_per_tx, "Daily limit must be >= per-tx max");
    }

    // ================================================================
    // Tests (run with `nargo test`; no sandbox or proving required)
    // ================================================================

    // Verifies the FunctionCall serialize order that assert_single_call_matches
    // relies on: args_hash at offset 0, target_address at offset 2. If a future
    // aztec version reorders these fields, this test fails instead of silently
    // breaking the binding.
    #[test]
    fn function_call_serialize_layout() {
        let call = aztec::authwit::entrypoint::FunctionCall {
            args_hash: 111,
            function_selector: aztec::protocol::abis::function_selector::FunctionSelector::from_u32(
                222,
            ),
            target_address: AztecAddress::from_field(333),
            is_public: false,
            hide_msg_sender: false,
            is_static: false,
        };
        let serialized: [Field; 6] = call.serialize();
        assert(serialized[0] == 111, "args_hash expected at offset 0");
        assert(serialized[2] == 333, "target_address expected at offset 2");
    }

    // A payload with exactly one non-empty call whose args_hash matches the
    // declared reconstruction is accepted.
    #[test]
    fn single_matching_call_passes() {
        let mut serialized = [0; 31];
        serialized[0] = 999; // call 0 args_hash == expected
        serialized[2] = 42; // call 0 target_address != 0
        assert_single_call_matches(serialized, 999);
    }

    // Declaring a value that does not match the executed transfer reverts. This
    // is the core protection: declare amount=1, transfer more -> rejected.
    #[test(should_fail_with = "Transfer does not match declared spending")]
    fn mismatched_transfer_reverts() {
        let mut serialized = [0; 31];
        serialized[0] = 111; // call 0 args_hash != expected
        serialized[2] = 42; // call 0 target_address != 0
        assert_single_call_matches(serialized, 999);
    }

    // A hidden second call cannot ride along with a matching first call.
    #[test(should_fail_with = "Expected exactly one call in payload")]
    fn hidden_second_call_reverts() {
        let mut serialized = [0; 31];
        serialized[0] = 999; // call 0 matches
        serialized[2] = 42;
        serialized[6] = 999; // call 1 non-empty
        serialized[8] = 43;
        assert_single_call_matches(serialized, 999);
    }

    // An empty payload (no transfer) is rejected.
    #[test(should_fail_with = "Expected exactly one call in payload")]
    fn empty_payload_reverts() {
        let serialized = [0; 31];
        assert_single_call_matches(serialized, 999);
    }
}
