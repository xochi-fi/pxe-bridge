mod public_key_note;

// SpendingLimitAccount: Schnorr account with on-chain per-tx caps, a bucketed
// daily volume window, a recipient allowlist, and timelocked parameters.
//
// Threat model: the bridge's signing key is compromised. The holder can sign
// anything; the public spending check bounds what that is worth. App-logic
// reverts are atomic, but the fee is charged regardless -- set_as_fee_payer and
// end_setup run in the non-revertible setup phase.
//
// Build: `aztec compile`. Not `aztec-nargo compile` -- aztec-nargo is a symlink
// to plain nargo and emits transpiled=false, which loadContractArtifact rejects.
// Artifact is gitignored and built by CI.

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
            abis::function_selector::FunctionSelector,
            address::AztecAddress,
            constants::DOM_SEP__TX_NULLIFIER,
            hash::poseidon2_hash_with_separator,
            traits::{FromField, Hash, Serialize, ToField},
        },
        state_vars::{Map, PublicImmutable, PublicMutable, SinglePrivateImmutable},
    };

    use crate::public_key_note::PublicKeyNote;

    // Sliding window: BUCKET_COUNT buckets of BUCKET_SECONDS, summed.
    //
    // 25 and not 24. Minimum lookback is (N-1)*W, so 24 hourly buckets enforce
    // over 23h and admit 2L inside 24h. (N-1)*W == WINDOW_SECONDS is the
    // invariant; window_parameterisation_is_exact asserts it. Cost: lookback
    // runs up to 25h, i.e. 25/24 conservatism, not a burst allowance.
    //
    // Timestamps, not block height -- block intervals must not be relied on.
    global WINDOW_SECONDS: u64 = 86400;
    global BUCKET_COUNT: u32 = 25;
    global BUCKET_SECONDS: u64 = WINDOW_SECONDS / (BUCKET_COUNT as u64 - 1);

    // Timelock delay for parameter changes. Seconds, for the same reason the
    // window is: the previous 5-block delay was both tiny and dependent on
    // block production rate.
    global PARAM_TIMELOCK_SECONDS: u64 = 86400;

    // How long a matured proposal stays applicable before it must be
    // re-proposed. Bounds the window in which an armed proposal is useful to a
    // compromised admin; see apply_limits.
    global PARAM_APPLY_WINDOW_SECONDS: u64 = 86400;

    // Allowlist capacity. Fixed at compile time: it is the length of the
    // private entrypoint hint and the number of public reads on the hot path,
    // so it is part of the entrypoint ABI and therefore of the account address.
    global ALLOWLIST_SIZE: u32 = 8;

    // Floor on how many allowlist slots a transfer must carry, so a degenerate
    // client cannot publish the recipient by carrying only its slot.
    //
    // STORED, not derived from live_count. Deriving it meant an addition that
    // grew the list past the floor raised it underneath transactions that were
    // already proven, reverting them after their fee had been committed. A
    // stored floor cannot move except through propose_limits/apply_limits, so
    // it can only change with the full timelock's notice and never surprises an
    // in-flight transaction.
    //
    // This is a BACKSTOP, not the anonymity mechanism. The set the recipient
    // actually hides in is whatever the client carries, and the client rule is
    // to carry every live slot. The contract cannot enforce that the mask is
    // chosen independently of the recipient, so it guarantees a count, not
    // unlinkability.
    //
    // Raising it is an operator responsibility as the allowlist grows: an
    // account left at the construction value keeps the weaker guarantee.

    // Domain separator for combined (payload + spending info) hash.
    // Must match DOM_SEP_SPENDING_LIMIT in the TypeScript entrypoint.
    global DOM_SEP__SPENDING_LIMIT: u32 = 10042;

    // The only call this account may make. 0x89758b40, computed both from the
    // v5.1.0 Token ABI and from the signature string. from_signature is not
    // comptime in v5.1.0, hence the explicit wrapper.
    global TRANSFER_TO_PRIVATE_SELECTOR: Field =
        comptime { FunctionSelector::from_signature("transfer_to_private((Field),u128)").to_field() };

    #[storage]
    struct Storage<Context> {
        // ---- Schnorr signing key (private, set once) ----
        signing_public_key: SinglePrivateImmutable<PublicKeyNote, Context>,

        // u128 to match Token's amount type: the type is the range, so no
        // cast-and-compare. Zero is not storable (assert_limits_valid), which
        // makes "0 means unlimited" -- the counter-reset precondition --
        // inexpressible rather than merely guarded.
        max_amount_per_tx: PublicMutable<u128, Context>,
        daily_limit: PublicMutable<u128, Context>,

        // spend_buckets[i] holds volume for absolute bucket indices congruent
        // to i mod BUCKET_COUNT; spend_bucket is the most recent absolute
        // index. Expired slots are zeroed lazily on the next spend.
        //
        // A Map, not PublicMutable<[u128; N]>: a packed array is one Packable
        // value, so any write rewrites all 25 slots.
        spend_buckets: Map<Field, PublicMutable<u128, Context>, Context>,
        spend_bucket: PublicMutable<u64, Context>,

        // The single asset this account may move. Limits are in base units, so
        // one counter cannot span tokens of differing decimals or value.
        // Enforced by the payload guard. No setter: a wrong address here is
        // permanent and strands the balance.
        permitted_token: PublicImmutable<AztecAddress, Context>,

        // ---- Recipient allowlist ----
        // Index-keyed: slot i holds an allowlisted recipient or the zero
        // address. Public by construction -- propose_recipient and
        // remove_recipient take the address as an ordinary public argument, so
        // every entry is published by the admin's own transactions. Keeping the
        // recipient out of the per-transfer call does not make the list secret.
        allowlist: Map<Field, PublicMutable<AztecAddress, Context>, Context>,

        // See the note above ALLOWLIST_SIZE. 1 means "no floor".
        min_anonymity_set: PublicMutable<u32, Context>,

        // Timelocked pending addition.
        pending_recipient: PublicMutable<AztecAddress, Context>,
        pending_recipient_time: PublicMutable<u64, Context>,

        // ---- Admin (immutable after init) ----
        admin: PublicImmutable<AztecAddress, Context>,

        // Emergency stop, checked in check_spending_public so it takes effect
        // at inclusion time. Defaults false; never written at construction.
        paused: PublicMutable<bool, Context>,

        // ---- Timelock for pending limit changes ----
        // u128 too: as Field, propose_limits could store a value apply_limits
        // then truncates on write.
        pending_max_amount: PublicMutable<u128, Context>,
        pending_daily_limit: PublicMutable<u128, Context>,
        pending_min_anonymity: PublicMutable<u32, Context>,
        pending_change_time: PublicMutable<u64, Context>,

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
        token_address: AztecAddress,
        seed_recipient: AztecAddress,
        initial_min_anonymity: u32,
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
                token_address,
                seed_recipient,
                initial_min_anonymity,
            )
            .enqueue(self.context);
    }

    #[external("public")]
    #[noinitcheck]
    fn initialize_public_state(
        initial_max_per_tx: u128,
        initial_daily_limit: u128,
        admin_address: AztecAddress,
        token_address: AztecAddress,
        seed_recipient: AztecAddress,
        initial_min_anonymity: u32,
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
        assert(!token_address.is_zero(), "Token must not be zero");
        // Genesis seeding: the only untimelocked write to the allowlist.
        // Without it the list is empty at deployment and every addition waits
        // out PARAM_TIMELOCK_SECONDS, so the bridge could not transfer for 24
        // hours after each cutover.
        assert(!seed_recipient.is_zero(), "Seed recipient must not be zero");
        self.storage.allowlist.at(0 as Field).write(seed_recipient);
        assert_anonymity_valid(initial_min_anonymity);
        self.storage.min_anonymity_set.write(initial_min_anonymity);
        self.storage.admin.initialize(admin_address);
        self.storage.permitted_token.initialize(token_address);
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
        // The live allowlist with some slots blanked to zero, supplied by the
        // caller. NOT signed and NOT trusted.
        //
        // INVARIANT -- FIVE asserts make this parameter safe, across two
        // execution contexts. Removing any one of them makes an unsigned,
        // caller-supplied array the sole authority on who may be paid:
        //   1. !declared_recipient.is_zero()          (private, below)
        //   2. the `recipient != 0` guard in is_allowlisted (private)
        //   3. recipient IN hint                      (private, below)
        //   4. hint[i] IN {live[i], 0} for all i      (PUBLIC, inclusion time)
        //   5. hint carries at least the floor        (PUBLIC, inclusion time)
        //
        // (4) looks redundant beside (3) and is the one a maintainer would
        // delete. It is the only check evaluated at inclusion time and so the
        // only thing that makes revocation immediate. `stale_hint_is_rejected`
        // fails if it goes.
        allowlist_hint: [Field; ALLOWLIST_SIZE],
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
        let call_target =
            assert_declared_matches_transfer(app_payload, declared_amount, declared_recipient);

        // The membership decision is made HERE, in private, against the hint.
        // The enqueued public call never sees the recipient; it only re-binds
        // the hint to current storage.
        assert(!declared_recipient.is_zero(), "Recipient must not be zero");
        assert(
            is_allowlisted(allowlist_hint, declared_recipient.to_field()),
            "Recipient not in allowlist",
        );

        // --- Execute the actual calls ---
        app_payload.execute_calls(self.context);

        // --- Enqueue public spending checks ---
        // All limit checking happens in public context since spending
        // limits are stored in public state. If limits are exceeded, the
        // entire tx reverts atomically (including the private calls above).
        SpendingLimitAccount::at(self.context.this_address())
            .check_spending_public(declared_amount, allowlist_hint, call_target)
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
        allowlist_hint: [Field; ALLOWLIST_SIZE],
        call_target: Field,
    ) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(
            caller == self.context.this_address(),
            "Only callable internally",
        );
        assert(self.storage.initialized.read(), "Not initialized");

        // Emergency stop. Here rather than in private for the same reason the
        // allowlist binding is: a check evaluated at inclusion time stops a
        // transaction however far through proving it already is, which is the
        // only thing that helps once the signing key is loose.
        assert(!self.storage.paused.read(), "Account is paused");

        // H3: the single asset this account may move. Checked here rather than
        // in private because a public read is of current state and needs no
        // initialization nullifier at the anchor block.
        assert(
            call_target == self.storage.permitted_token.read().to_field(),
            "Call target is not the permitted token",
        );

        // Bind the private membership proof to the allowlist AS IT IS NOW.
        // Evaluated at inclusion time, so a transaction proven against a
        // superseded allowlist cannot be included however far through proving
        // it already is. This is what makes revocation immediate.
        let mut live: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        for i in 0..ALLOWLIST_SIZE {
            live[i] = self.storage.allowlist.at(i as Field).read().to_field();
        }
        assert_hint_masks_live(allowlist_hint, live, self.storage.min_anonymity_set.read());

        // --- Per-tx limit ---
        // Unconditional: zero is not a storable limit (assert_limits_valid),
        // so there is no `if max_per_tx != 0` branch to fall through.
        let max_per_tx = self.storage.max_amount_per_tx.read();
        assert(declared_amount <= max_per_tx, "Amount exceeds per-tx limit");

        // --- Daily spending limit ---
        // u128 throughout, so accumulation is a checked add. As Field this was
        // addition mod p, and an addend of p - spent zeroed the counter.
        let daily_limit = self.storage.daily_limit.read();

        let now = self.context.timestamp();
        let current_bucket = now / BUCKET_SECONDS;
        let last_bucket = self.storage.spend_bucket.read();

        let mut buckets: [u128; BUCKET_COUNT] = [0; BUCKET_COUNT];
        for i in 0..BUCKET_COUNT {
            buckets[i] = self.storage.spend_buckets.at(i as Field).read();
        }

        let (updated, total) =
            advance_window(buckets, last_bucket, current_bucket, declared_amount);

        // Only enforced for a value-moving transfer. Otherwise lowering
        // daily_limit below the volume already in the window would revert every
        // transaction, including a zero-amount one, until the window drained --
        // an admin action that bricks the account for up to a full window.
        if declared_amount != 0 {
            assert(total <= daily_limit, "Amount exceeds daily spending limit");
        }

        // Write back only what changed. `total` is recomputed from the array
        // every call, so no cached aggregate can desync from these slots. The
        // condition saves public data writes; it cannot change the result.
        for i in 0..BUCKET_COUNT {
            if updated[i] != buckets[i] {
                self.storage.spend_buckets.at(i as Field).write(updated[i]);
            }
        }
        self.storage.spend_bucket.write(current_bucket);
    }

    // ================================================================
    // Admin functions
    // ================================================================

    #[external("public")]
    fn propose_limits(new_max_per_tx: u128, new_daily_limit: u128, new_min_anonymity: u32) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        // Validate at PROPOSE time as well as at APPLY time, so an invalid
        // proposal cannot sit armed for the whole timelock.
        assert_limits_valid(new_max_per_tx, new_daily_limit);
        assert_anonymity_valid(new_min_anonymity);
        self.storage.pending_max_amount.write(new_max_per_tx);
        self.storage.pending_daily_limit.write(new_daily_limit);
        self.storage.pending_min_anonymity.write(new_min_anonymity);

        self.storage.pending_change_time.write(
            self.context.timestamp() + PARAM_TIMELOCK_SECONDS,
        );
    }

    #[external("public")]
    fn apply_limits() {
        // Without this, anyone -- including the signing-key holder -- could
        // apply an abandoned proposal at a moment of their choosing.
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");

        let change_time = self.storage.pending_change_time.read();
        assert(change_time != 0, "No pending changes");
        let now = self.context.timestamp();
        assert(now >= change_time, "Timelock not expired");
        // Proposals expire. Without an upper bound the timelock delivers public
        // notice but no enforcement: a compromised admin proposes maximum
        // limits on day 0, waits weeks until the account is at peak balance,
        // then applies and drains in a single block.
        assert(now < change_time + PARAM_APPLY_WINDOW_SECONDS, "Proposal expired");

        let new_max = self.storage.pending_max_amount.read();
        let new_daily = self.storage.pending_daily_limit.read();
        let new_anon = self.storage.pending_min_anonymity.read();

        // Same validation as construction: an unvalidated write here can store
        // limits that make every subsequent spend revert.
        assert_limits_valid(new_max, new_daily);
        assert_anonymity_valid(new_anon);

        self.storage.max_amount_per_tx.write(new_max);
        self.storage.daily_limit.write(new_daily);
        self.storage.min_anonymity_set.write(new_anon);

        // Clear pending state
        self.storage.pending_max_amount.write(0);
        self.storage.pending_daily_limit.write(0);
        self.storage.pending_min_anonymity.write(0);
        self.storage.pending_change_time.write(0);
    }

    // Withdraw a proposal before it is applied.
    #[external("public")]
    fn cancel_limits() {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        assert(
            self.storage.pending_change_time.read() != 0,
            "No pending changes",
        );
        self.storage.pending_max_amount.write(0);
        self.storage.pending_daily_limit.write(0);
        self.storage.pending_min_anonymity.write(0);
        self.storage.pending_change_time.write(0);
    }

    // ================================================================
    // Emergency stop
    // ================================================================

    // IMMEDIATE in both directions, and deliberately not timelocked.
    //
    // This is the admin's lever against a compromised SIGNING KEY, which under
    // the threat model at the top of this file is a different party from the
    // admin. The key holder can sign anything; the only thing that stops them
    // mid-incident is a check evaluated at inclusion time, and a timelock on
    // pause would hand them exactly the notice period they need to drain.
    //
    // A timelock on unpause is no better: it would freeze the account for a
    // day after a false alarm. Both directions are already admin-gated, and an
    // attacker who holds the admin key has propose_limits and does not need
    // this.
    //
    // Removing every allowlist entry is the alternative to this, at one
    // transaction per recipient, which is what the account had before.
    #[external("public")]
    fn pause() {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        self.storage.paused.write(true);
    }

    #[external("public")]
    fn unpause() {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        self.storage.paused.write(false);
    }

    // Lowering the anonymity floor is IMMEDIATE; raising it keeps the
    // propose_limits timelock. Same asymmetry as the allowlist, for the same
    // reason: loosening a restriction is not what an attacker wants, and the
    // raise is the direction that needs notice.
    //
    // This is the way out of a bricked account. assert_hint_masks_live needs
    // count_nonzero(hint) >= floor, and a hint can carry at most live_count
    // entries, so a floor above live_count makes every transfer unsatisfiable.
    // remove_recipient can produce that state immediately and is deliberately
    // not stopped from doing so -- refusing an emergency revocation is worse
    // than the outage it would prevent -- so the recovery cannot itself wait
    // out a 24h timelock.
    #[external("public")]
    fn lower_min_anonymity(new_floor: u32) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        assert_anonymity_lowered(new_floor, self.storage.min_anonymity_set.read());
        self.storage.min_anonymity_set.write(new_floor);
    }

    // There is deliberately no admin reset of the spending counter: an
    // untimelocked write of zero is the counter-reset impact by another route.

    #[external("public")]
    // Additions are TIMELOCKED, removals are IMMEDIATE. The asymmetry is
    // deliberate: the threat is a compromised admin adding an address they
    // control, and a compromised admin must not be able to delay a legitimate
    // revocation.
    fn propose_recipient(recipient: AztecAddress) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        assert(!recipient.is_zero(), "Recipient must not be zero");

        // A pending proposal blocks another, so a proposal watched for its full
        // notice period cannot be swapped just before it matures. An EXPIRED
        // proposal does not block: otherwise one abandoned proposal would wedge
        // every future addition until someone thought to cancel it.
        let pending = self.storage.pending_recipient_time.read();
        let expired = (pending != 0)
            & (self.context.timestamp() >= pending + PARAM_APPLY_WINDOW_SECONDS);
        assert((pending == 0) | expired, "Proposal already pending");

        self.storage.pending_recipient.write(recipient);
        self.storage.pending_recipient_time.write(
            self.context.timestamp() + PARAM_TIMELOCK_SECONDS,
        );
    }

    #[external("public")]
    fn apply_recipient() {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");

        let change_time = self.storage.pending_recipient_time.read();
        assert(change_time != 0, "No pending recipient");
        let now = self.context.timestamp();
        assert(now >= change_time, "Timelock not expired");
        assert(now < change_time + PARAM_APPLY_WINDOW_SECONDS, "Proposal expired");

        let recipient = self.storage.pending_recipient.read();
        assert(!recipient.is_zero(), "Recipient must not be zero");

        let mut entries: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        for i in 0..ALLOWLIST_SIZE {
            entries[i] = self.storage.allowlist.at(i as Field).read().to_field();
        }
        // A duplicate would silently consume a second slot and inflate the
        // apparent anonymity set without adding a candidate.
        assert(!is_allowlisted(entries, recipient.to_field()), "Already allowlisted");

        let index = first_free_slot(entries);
        assert(index < ALLOWLIST_SIZE, "Allowlist is full");
        self.storage.allowlist.at(index as Field).write(recipient);

        self.storage.pending_recipient.write(AztecAddress::from_field(0));
        self.storage.pending_recipient_time.write(0);
    }

    #[external("public")]
    fn cancel_recipient() {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        assert(self.storage.pending_recipient_time.read() != 0, "No pending recipient");
        self.storage.pending_recipient.write(AztecAddress::from_field(0));
        self.storage.pending_recipient_time.write(0);
    }

    // IMMEDIATE. Takes effect in the next block and additionally invalidates
    // every in-flight transaction whose hint carried this address, because
    // check_spending_public re-reads these slots at inclusion time.
    //
    // Address-keyed, not index-keyed: an off-by-one on the emergency path would
    // delete the wrong recipient.
    //
    // Removing the last entry leaves the allowlist empty and the bridge unable
    // to transfer until an addition clears its timelock. That is accepted:
    // pause() is the lever for stopping everything, and this one is for
    // removing a specific recipient.
    //
    // Nor is this blocked when it would drop live_count below
    // min_anonymity_set, which also stops every transfer. Refusing an
    // emergency revocation to protect an availability property is the wrong
    // trade; lower_min_anonymity is the untimelocked way back.
    #[external("public")]
    fn remove_recipient(recipient: AztecAddress) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        assert(!recipient.is_zero(), "Recipient must not be zero");
        let mut removed = false;
        for i in 0..ALLOWLIST_SIZE {
            if self.storage.allowlist.at(i as Field).read() == recipient {
                self.storage.allowlist.at(i as Field).write(AztecAddress::from_field(0));
                removed = true;
            }
        }
        assert(removed, "Recipient not in allowlist");
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

    // Lets a client build allowlist_hint. The list is public storage anyway;
    // this only saves the caller from deriving eight Map slots by hand.
    #[external("utility")]
    unconstrained fn get_allowlist() -> pub [Field; ALLOWLIST_SIZE] {
        let mut entries: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        for i in 0..ALLOWLIST_SIZE {
            entries[i] = self.storage.allowlist.at(i as Field).read().to_field();
        }
        entries
    }

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
    ) -> Field {
        // transfer_to_private(to: AztecAddress, amount: u128) encodes its args
        // as two fields, and a u128 packs into exactly one, so the widening
        // cast here reproduces the callee's own args_hash.
        let expected_args_hash =
            hash_args([declared_recipient.to_field(), declared_amount as Field]);

        // [FunctionCall; 5] (6 fields each) + tx_nonce = 31 fields
        let serialized: [Field; 31] = app_payload.serialize();

        assert_single_call_matches(serialized, expected_args_hash)
    }

    // Core matching logic over the serialized AppPayload, split out so it can be
    // unit-tested without constructing an AppPayload (its `function_calls` field
    // is not public outside the aztec crate). Each FunctionCall occupies 6 fields
    // starting at index i*6, with args_hash at offset 0 and target_address at
    // offset 2 (see the `function_call_serialize_layout` test).
    #[contract_library_method]
    // Returns the target of the single matching call. The caller checks that
    // target against the pinned token in PUBLIC: reading permitted_token from
    // private would be a historical read at the anchor block, and on the first
    // transaction the constructor's enqueued initializer has not been mined, so
    // it fails with "Trying to read from uninitialized PublicImmutable".
    fn assert_single_call_matches(
        serialized: [Field; 31],
        expected_args_hash: Field,
    ) -> Field {
        let mut nonempty_calls: u32 = 0;
        let mut matching_calls: u32 = 0;
        let mut matched_target: Field = 0;
        for i in 0..5 {
            let base = i * 6;
            let args_hash = serialized[base];
            let selector = serialized[base + 1];
            let target = serialized[base + 2];
            let is_public = serialized[base + 3];
            let hide_msg_sender = serialized[base + 4];
            let is_static = serialized[base + 5];
            if target != 0 {
                nonempty_calls += 1;
                // args_hash alone proved only that SOME contract received two
                // fields; any fn noop(a: Field, b: Field) satisfied it. is_public
                // is not belt-and-braces: execute_calls omits the selector on the
                // public branch, so unpinning it makes the selector pin dead.
                let matches = (args_hash == expected_args_hash)
                    & (selector == TRANSFER_TO_PRIVATE_SELECTOR)
                    & (is_public == 0)
                    & (hide_msg_sender == 0)
                    & (is_static == 0);
                if matches {
                    matching_calls += 1;
                    matched_target = target;
                }
            }
        }

        assert(nonempty_calls == 1, "Expected exactly one call in payload");
        assert(matching_calls == 1, "Transfer does not match declared spending");
        matched_target
    }

    // Advances the ring to current_bucket, zeroing slots that fell out of the
    // window, adds amount to the current slot, returns (array, window total).
    //
    // Moving from last_bucket to current_bucket newly enters absolute buckets
    // (last_bucket, current_bucket]; whatever those slots hold is from a
    // previous wrap. Clearing is capped at BUCKET_COUNT so a long idle wipes
    // the window instead of wrapping and preserving stale volume.
    //
    // Pure, so nargo test can exercise every boundary with no sandbox.
    #[contract_library_method]
    fn advance_window(
        buckets: [u128; BUCKET_COUNT],
        last_bucket: u64,
        current_bucket: u64,
        amount: u128,
    ) -> ([u128; BUCKET_COUNT], u128) {
        // u64 subtraction is checked, so a backwards timestamp would be a
        // constraint failure rather than a wraparound. Assert it explicitly so
        // the failure names the cause.
        assert(current_bucket >= last_bucket, "Block timestamp went backwards");
        let elapsed = current_bucket - last_bucket;

        let bucket_count = BUCKET_COUNT as u64;
        let clear_count = if elapsed >= bucket_count { bucket_count } else { elapsed };

        let mut updated = buckets;
        // k runs 1..=BUCKET_COUNT so a full-window idle clears every slot. The
        // bound is constant, so constraint count does not vary with elapsed.
        for k in 1..(BUCKET_COUNT + 1) {
            if (k as u64) <= clear_count {
                let idx = ((last_bucket + k as u64) % bucket_count) as u32;
                updated[idx] = 0;
            }
        }

        let slot = (current_bucket % bucket_count) as u32;
        updated[slot] = updated[slot] + amount;

        let mut total: u128 = 0;
        for i in 0..BUCKET_COUNT {
            total = total + updated[i];
        }

        (updated, total)
    }

    #[contract_library_method]
    fn is_allowlisted(entries: [Field; ALLOWLIST_SIZE], recipient: Field) -> bool {
        let mut found = false;
        for i in 0..ALLOWLIST_SIZE {
            found = found | ((entries[i] == recipient) & (recipient != 0));
        }
        found
    }

    #[contract_library_method]
    fn count_nonzero(entries: [Field; ALLOWLIST_SIZE]) -> u32 {
        let mut n: u32 = 0;
        for i in 0..ALLOWLIST_SIZE {
            if entries[i] != 0 {
                n += 1;
            }
        }
        n
    }

    // Returns ALLOWLIST_SIZE when the list is full. An earlier version returned
    // (bool, u32) with index 0 on failure, so a caller who ignored the flag
    // silently overwrote slot 0 -- the seed recipient. An out-of-range index
    // cannot be used by accident: writing it would be a bounds failure.
    #[contract_library_method]
    fn first_free_slot(entries: [Field; ALLOWLIST_SIZE]) -> u32 {
        let mut index: u32 = ALLOWLIST_SIZE;
        for i in 0..ALLOWLIST_SIZE {
            if (entries[i] == 0) & (index == ALLOWLIST_SIZE) {
                index = i;
            }
        }
        index
    }

    // The hint must be `live` with some slots blanked IN PLACE.
    //
    // Positional, not set membership. One O(n) check gives three properties:
    // no address that is not live can appear, no duplicates can appear (live
    // holds none and position is pinned), and no reordering can appear. A set
    // check would need O(n^2) and would still admit [R,R,R,R,0,0,0,0], whose
    // four non-zero entries hide nothing.
    //
    // The zero branch is what lets a hint survive an ADDITION: a slot empty at
    // proof time reads zero here and passes whatever was later written.
    //
    // Zero is safe as a blank marker only because a zero recipient is rejected
    // in private, both at the entrypoint and inside is_allowlisted.
    #[contract_library_method]
    fn assert_hint_masks_live(
        hint: [Field; ALLOWLIST_SIZE],
        live: [Field; ALLOWLIST_SIZE],
        floor: u32,
    ) {
        for i in 0..ALLOWLIST_SIZE {
            assert(
                (hint[i] == live[i]) | (hint[i] == 0),
                "Allowlist changed since this transaction was proven",
            );
        }

        // Anonymity floor. Duplicates are impossible, so a count of non-zero
        // entries is the size of the set the recipient hides in.
        //
        // The floor is passed in from stored state rather than derived from
        // `live`. An earlier revision computed it as min(k, live_count), which
        // meant an addition growing the list past k raised the floor underneath
        // transactions that were already proven and reverted them after their
        // fee had been committed. A stored floor only moves through
        // apply_limits, i.e. with the full timelock's notice.
        assert(count_nonzero(hint) >= floor, "Hint below minimum anonymity set");
    }

    // A floor of 1 means no floor: the recipient may be the only entry carried.
    // It cannot exceed the allowlist, which would make every hint unbuildable.
    #[contract_library_method]
    fn assert_anonymity_valid(floor: u32) {
        assert(floor >= 1, "Anonymity floor must be at least 1");
        assert(floor <= ALLOWLIST_SIZE, "Anonymity floor exceeds allowlist size");
    }

    // The untimelocked path may only LOWER the floor. Equality is rejected
    // too: a no-op write would let the admin present an unpause-shaped
    // transaction that changes nothing.
    #[contract_library_method]
    fn assert_anonymity_lowered(new_floor: u32, current: u32) {
        assert(new_floor < current, "Anonymity floor must decrease");
        assert_anonymity_valid(new_floor);
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
        assert(serialized[1] == 222, "function_selector expected at offset 1");
        assert(serialized[2] == 333, "target_address expected at offset 2");
        assert(serialized[3] == 0, "is_public expected at offset 3");
        assert(serialized[4] == 0, "hide_msg_sender expected at offset 4");
        assert(serialized[5] == 0, "is_static expected at offset 5");
    }

    // Pins the selector constant. This is a typo-guard on the signature string,
    // NOT a check that Aztec's own ABI is unchanged -- it compares a
    // string-derived constant against a literal and never reads the Token
    // artifact. The Aztec-side drift check belongs in TypeScript.
    #[test]
    fn transfer_to_private_selector_pin() {
        assert(
            TRANSFER_TO_PRIVATE_SELECTOR == 0x89758b40,
            "transfer_to_private selector changed",
        );
    }

    // Builds a well-formed single-call payload: matching args_hash, the pinned
    // selector, a non-zero target, and all three flags clear.
    global TEST_TOKEN: Field = 42;

    #[contract_library_method]
    fn valid_payload(args_hash: Field) -> [Field; 31] {
        let mut serialized = [0; 31];
        serialized[0] = args_hash;
        serialized[1] = TRANSFER_TO_PRIVATE_SELECTOR;
        serialized[2] = TEST_TOKEN;
        serialized
    }

    // A payload with exactly one non-empty call whose args_hash matches the
    // declared reconstruction is accepted.
    #[test]
    fn single_matching_call_passes() {
        let _ = assert_single_call_matches(valid_payload(999), 999);
    }

    // Declaring a value that does not match the executed transfer reverts. This
    // is the core protection: declare amount=1, transfer more -> rejected.
    #[test(should_fail_with = "Transfer does not match declared spending")]
    fn mismatched_transfer_reverts() {
        let _ = assert_single_call_matches(valid_payload(111), 999);
    }

    // A call to `fn noop(a: Field, b: Field)` on an attacker-deployed contract:
    // args_hash reconstructs and the target is non-zero, but nothing moves.
    #[test(should_fail_with = "Transfer does not match declared spending")]
    fn wrong_selector_reverts() {
        let mut serialized = valid_payload(999);
        serialized[1] = 0xdeadbeef;
        let _ = assert_single_call_matches(serialized, 999);
    }

    // execute_calls does not pass function_selector on the public branch, so an
    // unpinned is_public would make the selector pin dead data there.
    #[test(should_fail_with = "Transfer does not match declared spending")]
    fn public_call_reverts() {
        let mut serialized = valid_payload(999);
        serialized[3] = 1;
        let _ = assert_single_call_matches(serialized, 999);
    }

    #[test(should_fail_with = "Transfer does not match declared spending")]
    fn hidden_msg_sender_reverts() {
        let mut serialized = valid_payload(999);
        serialized[4] = 1;
        let _ = assert_single_call_matches(serialized, 999);
    }

    #[test(should_fail_with = "Transfer does not match declared spending")]
    fn static_call_reverts() {
        let mut serialized = valid_payload(999);
        serialized[5] = 1;
        let _ = assert_single_call_matches(serialized, 999);
    }

    // H3: the guard now REPORTS the target rather than judging it;
    // check_spending_public compares it to permitted_token in public, where the
    // read needs no initialization nullifier. Covered end to end by the e2e
    // suite, which is the only place a public read can be exercised.
    #[test]
    fn guard_reports_the_call_target() {
        let mut serialized = valid_payload(999);
        serialized[2] = 43;
        assert(assert_single_call_matches(serialized, 999) == 43, "target reported");
    }

    // A hidden second call cannot ride along with a matching first call.
    #[test(should_fail_with = "Expected exactly one call in payload")]
    fn hidden_second_call_reverts() {
        let mut serialized = valid_payload(999);
        serialized[6] = 999; // call 1 non-empty
        serialized[8] = 43; // different target, still non-empty
        let _ = assert_single_call_matches(serialized, 999);
    }

    // The guard must find the match wherever it sits in the five slots.
    #[test]
    fn matching_call_in_a_later_slot_passes() {
        let mut serialized = [0; 31];
        serialized[12] = 999;
        serialized[13] = TRANSFER_TO_PRIVATE_SELECTOR;
        serialized[14] = TEST_TOKEN;
        let _ = assert_single_call_matches(serialized, 999);
    }

    // An empty payload (no transfer) is rejected.
    #[test(should_fail_with = "Expected exactly one call in payload")]
    fn empty_payload_reverts() {
        let serialized = [0; 31];
        let _ = assert_single_call_matches(serialized, 999);
    }

    // ---- M2/L2: allowlist masking ----

    global A: Field = 0xaaaa;
    global B: Field = 0xbbbb;
    global C: Field = 0xcccc;
    global D: Field = 0xdddd;

    #[contract_library_method]
    fn live4() -> [Field; ALLOWLIST_SIZE] {
        let mut e: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        e[0] = A;
        e[1] = B;
        e[2] = C;
        e[3] = D;
        e
    }

    #[test]
    fn full_hint_is_accepted() {
        assert_hint_masks_live(live4(), live4(), 4);
    }

    #[test]
    fn membership_is_proven_against_the_hint() {
        assert(is_allowlisted(live4(), C), "C is allowlisted");
        assert(!is_allowlisted(live4(), 0x9999), "unlisted address rejected");
    }

    // The zero recipient must not match a blanked slot. This is guard (2) of
    // the five-assert invariant on allowlist_hint.
    #[test]
    fn zero_recipient_never_matches_a_blank_slot() {
        let e: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        assert(!is_allowlisted(e, 0), "zero must never be allowlisted");
    }

    // THE L2 GUARANTEE. A hint proven before a removal no longer masks live,
    // so the transaction cannot be included. Deleting the masking check in
    // check_spending_public makes this test fail.
    #[test(should_fail_with = "Allowlist changed since this transaction was proven")]
    fn stale_hint_is_rejected() {
        let hint = live4();
        let mut after_removal = live4();
        after_removal[2] = 0; // C revoked
        assert_hint_masks_live(hint, after_removal, 4);
    }

    // A fabricated entry is not live at its position.
    #[test(should_fail_with = "Allowlist changed since this transaction was proven")]
    fn fabricated_hint_entry_is_rejected() {
        let mut hint = live4();
        hint[1] = 0x9999;
        assert_hint_masks_live(hint, live4(), 4);
    }

    // Positional, so a permutation of the same set is not a valid mask. A set
    // subset check would accept this.
    #[test(should_fail_with = "Allowlist changed since this transaction was proven")]
    fn permuted_hint_is_rejected() {
        let mut hint = live4();
        hint[0] = B;
        hint[1] = A;
        assert_hint_masks_live(hint, live4(), 4);
    }

    // THE M2 GUARANTEE. A hint carrying only the recipient publishes it, so the
    // floor rejects it.
    #[test(should_fail_with = "Hint below minimum anonymity set")]
    fn minimal_hint_is_rejected() {
        let mut hint: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        hint[2] = C;
        assert_hint_masks_live(hint, live4(), 4);
    }

    // Duplicates cannot inflate the count past the floor, because position is
    // pinned: [C,C,C,C,...] does not mask live at any slot.
    #[test(should_fail_with = "Allowlist changed since this transaction was proven")]
    fn duplicated_hint_cannot_fake_the_floor() {
        let mut hint: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        hint[0] = C;
        hint[1] = C;
        hint[2] = C;
        hint[3] = C;
        assert_hint_masks_live(hint, live4(), 4);
    }

    // ADDITIONS must not invalidate in-flight transactions: a slot empty at
    // proof time reads zero in the hint and passes whatever was written later.
    // This is what the whole-array digest design got wrong.
    #[test]
    fn addition_does_not_invalidate_an_inflight_hint() {
        let hint = live4();
        let mut after_addition = live4();
        after_addition[4] = 0xeeee;
        assert_hint_masks_live(hint, after_addition, 4);
    }

    // A floor equal to live_count is the boundary: the hint carries every live
    // slot and just clears it.
    //
    // The previous name for this test claimed the floor "degrades to
    // live_count". It does not. assert_hint_masks_live uses the stored floor
    // verbatim -- there is no min() anywhere -- and this test only passed
    // because it happened to pick floor == live_count. The other side of the
    // boundary is below.
    #[test]
    fn floor_equal_to_live_count_is_satisfiable() {
        let mut live: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        live[0] = A;
        live[1] = B;
        // Floor of 2 is what an operator would set for a 2-entry allowlist.
        assert_hint_masks_live(live, live, 2);
    }

    // The state lower_min_anonymity exists to undo. A hint carries at most
    // live_count entries, since every non-zero slot must mask a live one, so a
    // floor above live_count can never be met and EVERY transfer reverts.
    //
    // Reachable two ways with no timelock in between: remove_recipient taking
    // the list below the floor, or an operator raising the floor ahead of the
    // allowlist.
    #[test(should_fail_with = "Hint below minimum anonymity set")]
    fn floor_above_live_count_is_unsatisfiable() {
        let mut live: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        live[0] = A;
        live[1] = B;
        // Carrying every live slot is the most a client can do, and it is not
        // enough.
        assert_hint_masks_live(live, live, 3);
    }

    // ---- Anonymity floor: the untimelocked lowering path ----

    #[test]
    fn floor_may_be_lowered() {
        assert_anonymity_lowered(2, 4);
    }

    #[test(should_fail_with = "Anonymity floor must decrease")]
    fn floor_may_not_be_raised_without_the_timelock() {
        assert_anonymity_lowered(5, 4);
    }

    // A no-op write would let the admin present a floor-lowering transaction
    // that changes nothing.
    #[test(should_fail_with = "Anonymity floor must decrease")]
    fn floor_may_not_be_set_to_itself() {
        assert_anonymity_lowered(4, 4);
    }

    #[test(should_fail_with = "Anonymity floor must be at least 1")]
    fn floor_may_not_be_lowered_to_zero() {
        assert_anonymity_lowered(0, 4);
    }

    // REGRESSION. With the floor derived as min(k, live_count), growing the
    // list past k raised the floor under already-proven transactions and
    // reverted them. The floor is stored now, so an addition cannot move it and
    // a hint built before the addition still passes.
    #[test]
    fn addition_past_the_floor_does_not_invalidate_an_inflight_hint() {
        let mut live_before: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        live_before[0] = A;
        live_before[1] = B;
        let hint = live_before; // carries both live slots, floor was 2

        let mut live_after = live_before;
        live_after[2] = C;
        live_after[3] = D; // list grows to 4, past the old derived floor

        assert_hint_masks_live(hint, live_after, 2);
    }

    #[test]
    fn floor_is_enforced_as_given() {
        let mut hint = live4();
        hint[3] = 0; // carry 3 of 4
        assert_hint_masks_live(hint, live4(), 3);
    }

    #[test(should_fail_with = "Anonymity floor must be at least 1")]
    fn zero_anonymity_floor_rejected() {
        assert_anonymity_valid(0);
    }

    #[test(should_fail_with = "Anonymity floor exceeds allowlist size")]
    fn oversized_anonymity_floor_rejected() {
        assert_anonymity_valid(ALLOWLIST_SIZE + 1);
    }

    #[test]
    fn first_free_slot_finds_the_lowest_gap() {
        assert(first_free_slot(live4()) == 4, "lowest free slot is 4");
    }

    #[test]
    fn first_free_slot_reports_a_full_allowlist() {
        let mut e: [Field; ALLOWLIST_SIZE] = [0; ALLOWLIST_SIZE];
        for i in 0..ALLOWLIST_SIZE {
            e[i] = (i as Field) + 1;
        }
        assert(
            first_free_slot(e) == ALLOWLIST_SIZE,
            "a full allowlist reports an out-of-range slot",
        );
    }

    // ---- M1: bucketed sliding window ----

    // The invariant the whole guarantee rests on. Deleting this test deletes
    // the only mechanical link between WINDOW_SECONDS and actual behaviour: a
    // retune to 24 buckets would otherwise compile and ship a 23-hour window.
    #[test]
    fn window_parameterisation_is_exact() {
        assert(
            (BUCKET_COUNT as u64 - 1) * BUCKET_SECONDS == WINDOW_SECONDS,
            "(N-1)*W must equal WINDOW_SECONDS",
        );
        assert(BUCKET_SECONDS == 3600, "hourly buckets expected");
    }

    #[contract_library_method]
    fn empty_buckets() -> [u128; BUCKET_COUNT] {
        [0; BUCKET_COUNT]
    }

    #[test]
    fn cold_start_does_not_underflow() {
        let (_updated, total) = advance_window(empty_buckets(), 0, 500_000, 100);
        assert(total == 100, "first spend accumulates");
    }

    #[test]
    fn same_bucket_accumulates() {
        let (b1, _t1) = advance_window(empty_buckets(), 0, 1_000, 100);
        let (_b2, total) = advance_window(b1, 1_000, 1_000, 50);
        assert(total == 150, "two spends in one bucket sum");
    }

    // Crossing a bucket boundary must not reset anything.
    #[test]
    fn boundary_crossing_does_not_reset() {
        let (b1, _t1) = advance_window(empty_buckets(), 0, 1_000, 100);
        let (_b2, total) = advance_window(b1, 1_000, 1_001, 50);
        assert(total == 150, "crossing a bucket must not reset the window");
    }

    // Still inside a 25-bucket window. A 24-bucket design expires this, which
    // is what lets 2L fit inside 24 hours.
    #[test]
    fn spend_24_buckets_ago_is_still_counted() {
        let (b1, _t1) = advance_window(empty_buckets(), 0, 1_000, 100);
        let (_b2, total) = advance_window(b1, 1_000, 1_024, 50);
        assert(total == 150, "24 buckets ago must still be in the window");
    }

    #[test]
    fn spend_25_buckets_ago_has_expired() {
        let (b1, _t1) = advance_window(empty_buckets(), 0, 1_000, 100);
        let (_b2, total) = advance_window(b1, 1_000, 1_025, 50);
        assert(total == 50, "25 buckets ago must have left the window");
    }

    // An idle of exactly one window must clear everything. Computing the clear
    // count as `elapsed % BUCKET_COUNT` instead of `min(elapsed, BUCKET_COUNT)`
    // clears nothing here and silently preserves a full window of stale volume.
    #[test]
    fn idle_of_exactly_one_window_clears_all() {
        let (b1, _t1) = advance_window(empty_buckets(), 0, 1_000, 100);
        let (_b2, total) = advance_window(b1, 1_000, 1_000 + BUCKET_COUNT as u64, 10);
        assert(total == 10, "a full-window idle must clear every slot");
    }

    #[test]
    fn long_idle_clears_all() {
        let (b1, _t1) = advance_window(empty_buckets(), 0, 1_000, 100);
        let (_b2, total) = advance_window(b1, 1_000, 9_999, 10);
        assert(total == 10, "a long idle must clear every slot");
    }

    #[test]
    fn partial_expiry_clears_only_stale_slots() {
        let (b1, _t1) = advance_window(empty_buckets(), 0, 1_000, 100);
        let (b2, t2) = advance_window(b1, 1_000, 1_010, 30);
        assert(t2 == 130, "both spends live");
        // Now push past the first spend only.
        let (_b3, t3) = advance_window(b2, 1_010, 1_026, 5);
        assert(t3 == 35, "only the expired slot is cleared");
    }

    // 18-decimal scale, which the old u64 ceiling made unrepresentable.
    #[test]
    fn window_handles_18_decimal_scale() {
        let one_thousand_tokens: u128 = 1_000_000_000_000_000_000_000;
        let (b1, _t1) = advance_window(empty_buckets(), 0, 1_000, one_thousand_tokens);
        let (_b2, total) = advance_window(b1, 1_000, 1_001, one_thousand_tokens);
        assert(total == one_thousand_tokens * 2, "18-decimal amounts accumulate");
    }

    #[test(should_fail_with = "Block timestamp went backwards")]
    fn window_rejects_backwards_timestamp() {
        let _ = advance_window(empty_buckets(), 1_000, 999, 1);
    }

    // ---- Limit validation ----

    #[test]
    fn valid_limits_accepted() {
        assert_limits_valid(1_000, 10_000);
    }

    #[test]
    fn eighteen_decimal_limits_accepted() {
        // 1000 tokens at 18 decimals. Rejected outright under the old u64
        // ceiling, which topped out at 18.45 tokens.
        assert_limits_valid(1_000_000_000_000_000_000_000, 10_000_000_000_000_000_000_000);
    }

    #[test(should_fail_with = "Per-tx limit must be non-zero")]
    fn zero_per_tx_rejected() {
        assert_limits_valid(0, 10_000);
    }

    #[test(should_fail_with = "Daily limit must be non-zero")]
    fn zero_daily_rejected() {
        assert_limits_valid(1_000, 0);
    }

    #[test(should_fail_with = "Daily limit must be >= per-tx max")]
    fn daily_below_per_tx_rejected() {
        assert_limits_valid(10_000, 1_000);
    }
}
