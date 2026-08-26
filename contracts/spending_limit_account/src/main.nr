mod public_key_note;

// SpendingLimitAccount: Schnorr account with on-chain per-tx caps, a bucketed
// daily volume window, a Merkle recipient allowlist, and timelocked limits.
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
            hash::poseidon2_hash_with_separator,
            merkle_tree::root::root_from_sibling_path,
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

    // Allowlist tree height, so capacity is 2^10 = 1,024 recipients.
    //
    // Like ALLOWLIST_SIZE before it, this is welded to the account address: it
    // is the sibling path length in the entrypoint ABI. Unlike ALLOWLIST_SIZE,
    // it costs nothing ON CHAIN. The array design read every slot in public on
    // every transfer, so capacity was 1,290 L2 gas per slot per transfer
    // forever; a root is one read whatever the height.
    //
    // What bounds the height is the CLIENT, and it is the per-leaf salting that
    // does it. Distinct salts on empty leaves mean there are no canonical
    // empty-subtree roots to short-circuit, so the tree is dense from everyone's
    // point of view and building the root costs 2^height - 1 hashes. Measured
    // against this SDK's Poseidon2 at 0.32ms, height 10 is 0.33s and height 16
    // is 21s. The bridge builds the tree at startup and rebuilds on each
    // update, so seconds there are not free.
    //
    // 1,024 against an allowlist the fix review assumed held 4 to 8 addresses.
    // Growing past it is an address migration, which is the same cost
    // ALLOWLIST_SIZE carried, but the headroom is now two orders of magnitude
    // rather than none.
    global ALLOWLIST_TREE_HEIGHT: u32 = 10;

    // Domain separator for combined (payload + spending info) hash.
    // Must match DOM_SEP_SPENDING_LIMIT in the TypeScript entrypoint.
    global DOM_SEP__SPENDING_LIMIT: u32 = 10042;

    // Domain separator for allowlist leaf commitments.
    //
    // Distinct from DOM_SEP__MERKLE_HASH, which merkle_hash uses for internal
    // nodes. Without the split, a leaf and an internal node are the same
    // two-field Poseidon2 and an internal node can be presented as a leaf, so a
    // sibling path one level short proves membership of something that is not a
    // recipient. Must match DOM_SEP_ALLOWLIST_LEAF in the TypeScript wrapper.
    global DOM_SEP__ALLOWLIST_LEAF: u32 = 10043;

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
        // Root of a height-ALLOWLIST_TREE_HEIGHT Merkle tree whose leaves are
        // commitments h(recipient, salt) under DOM_SEP__ALLOWLIST_LEAF. The set
        // itself never touches the chain: membership is proven in private and
        // only the root is compared in public.
        //
        // Replaces an 8-slot address map. That map published every entry,
        // because the admin's own add and remove calls carried the address as a
        // public argument, so the per-transfer recipient was narrowed to a
        // member of a small published set. NM-1019 [Medium] is that narrowing.
        //
        // Per-leaf random salts are load-bearing, not decoration. Empty slots
        // are h(0, salt_i) with a fresh salt each, so no two empties are equal:
        // an observer cannot tell an addition from a substitution by watching
        // for a repeated old_leaf, and the canonical empty-subtree roots never
        // appear in a sibling path to give away how sparse the tree is.
        allowlist_root: PublicMutable<Field, Context>,

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
        initial_allowlist_root: Field,
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
                initial_allowlist_root,
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
        initial_allowlist_root: Field,
    ) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(
            caller == self.context.this_address(),
            "Only callable internally",
        );
        assert(!self.storage.initialized.read(), "Already initialized");

        assert_limits_valid(initial_max_per_tx, initial_daily_limit);
        assert_construction_addresses_valid(admin_address, token_address);
        assert_root_valid(initial_allowlist_root);

        self.storage.max_amount_per_tx.write(initial_max_per_tx);
        self.storage.daily_limit.write(initial_daily_limit);
        // The whole allowlist arrives here, as one root. The array design could
        // only seed a single recipient, because every further addition wrote an
        // address into a slot in its own transaction, so a deployment either
        // started with one recipient or spent a day per cutover waiting out
        // timelocks. Building the tree off-chain removes both the cost and the
        // disclosure: the admin never has to publish the set to install it.
        self.storage.allowlist_root.write(initial_allowlist_root);
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
        // Membership witness for declared_recipient's leaf. NOT signed and NOT
        // trusted; the root it produces is re-checked against live storage in
        // public.
        //
        // Not signing it is deliberate and matches what allowlist_hint did
        // before. A witness is a snapshot of state the signer cannot know at
        // signing time, and signing it would only pin which stale snapshot the
        // transaction is allowed to carry. What makes it safe is that the leaf
        // is rebuilt here from declared_recipient, which IS signed, so a
        // witness for anyone else proves nothing about this transfer.
        //
        // INVARIANT -- SIX asserts make these parameters safe, across two
        // execution contexts. Removing any one of them lets an unsigned,
        // caller-supplied witness decide who may be paid:
        //   1. !declared_recipient.is_zero()               (private, below)
        //   2. declared == the payload's actual transfer   (private, below)
        //   3. leaf is rebuilt from declared_recipient     (private, below)
        //   4. witness reproduces claimed_root             (private, below)
        //   5. claimed_root == stored root  (PUBLIC, inclusion time)
        //   6. call_target == permitted_token (PUBLIC, inclusion time)
        //
        // (5) is the one that looks redundant beside (4) and is therefore the
        // one a maintainer would delete. It is the only membership check
        // evaluated at inclusion time and so the only thing that makes
        // revocation bite a transaction already in flight.
        // `stale_witness_is_rejected` fails if it goes.
        //
        // (6) is not redundant beside the comptime selector pin: the pin fixes
        // WHICH function is called, not WHOSE. Deleting it lets any
        // attacker-deployed contract exposing the signature satisfy the payload
        // guard, which is NM-1019's second [High] by another route.
        leaf_salt: Field,
        leaf_index: Field,
        sibling_path: [Field; ALLOWLIST_TREE_HEIGHT],
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

        // The membership decision is made HERE, in private, against a root the
        // caller claims. The enqueued public call never sees the recipient, the
        // salt or the path; it only checks that the claimed root is the one the
        // account currently stores.
        //
        // This is what the array design could not do. There the public side
        // received the candidate set itself, so the recipient was published as
        // one of at most eight addresses that the admin's own transactions had
        // already put on chain. Here public receives a single field that is
        // equal to the stored root or is not.
        assert(!declared_recipient.is_zero(), "Recipient must not be zero");
        let claimed_root = root_from_sibling_path(
            allowlist_leaf(declared_recipient.to_field(), leaf_salt),
            leaf_index,
            sibling_path,
        );

        // --- Execute the actual calls ---
        app_payload.execute_calls(self.context);

        // --- Enqueue public spending checks ---
        // All limit checking happens in public context since spending
        // limits are stored in public state. If limits are exceeded, the
        // entire tx reverts atomically (including the private calls above).
        SpendingLimitAccount::at(self.context.this_address())
            .check_spending_public(declared_amount, claimed_root, call_target)
            .enqueue(self.context);

        // --- Cancellation ---
        // NOT SUPPORTED, and no longer advertised. NM-1019 [Low] observed that
        // this account pushed a cancellation nullifier while offering no way to
        // use it: the only path through this entrypoint is a real transfer, so
        // cancelling meant sending another one, which costs an allowlisted
        // recipient, unspent per-tx cap and room in the daily window. There are
        // reachable states with none of those, and they are exactly the states
        // where cancelling matters.
        //
        // The branch is deleted rather than completed. Completing it means
        // NM-1019's recommendation, branching on zero non-empty calls, which
        // skips assert_declared_matches_transfer, the zero-recipient assert,
        // the membership proof and the check_spending_public enqueue together.
        // That path can move no value, but it is a second shape through the
        // entrypoint and the fee branch still runs on it, so a compromised
        // signing key could burn fee juice on empty cancellations. Deleting
        // keeps the entrypoint single-shape and fails safe: if a future SDK
        // makes cancellation the default, this account offers none rather than
        // advertising one it cannot honour, which was the trigger the finding
        // named.
        //
        // The `cancellable` ABI parameter stays. The SDK encodes entrypoint
        // arguments positionally, so removing it would shift every argument
        // after it. It is now read and ignored.
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
        claimed_root: Field,
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
        //
        // One read, flat in capacity. The array design read every slot here,
        // 8 x 1290 = 10,320 L2 gas on every transfer, purely to rebuild the
        // candidate set that the masking check then compared against. Growing
        // that set meant paying for it on every transfer forever; growing this
        // one is free.
        //
        // NOTE: every root change invalidates in-flight transactions, additions
        // included. Under the array an addition was survivable, because a slot
        // empty at proof time read zero in the hint and passed whatever was
        // written later. There is no equivalent here and deliberately so: a
        // grace window would have to accept a superseded root, and since
        // update_recipient cannot tell an addition from a removal, accepting a
        // superseded root would also mean accepting a revoked recipient for the
        // length of the window. Additions are scheduled by the operator, so the
        // procedure is to stop accepting sends, update, then resume; revocation
        // is not scheduled by anyone and has to bite now.
        assert(
            claimed_root == self.storage.allowlist_root.read(),
            "Allowlist changed since this transaction was proven",
        );

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
    fn propose_limits(new_max_per_tx: u128, new_daily_limit: u128) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");
        // Validate at PROPOSE time as well as at APPLY time, so an invalid
        // proposal cannot sit armed for the whole timelock.
        assert_limits_valid(new_max_per_tx, new_daily_limit);
        self.storage.pending_max_amount.write(new_max_per_tx);
        self.storage.pending_daily_limit.write(new_daily_limit);

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

        // Same validation as construction: an unvalidated write here can store
        // limits that make every subsequent spend revert.
        assert_limits_valid(new_max, new_daily);

        self.storage.max_amount_per_tx.write(new_max);
        self.storage.daily_limit.write(new_daily);

        // Clear pending state
        self.storage.pending_max_amount.write(0);
        self.storage.pending_daily_limit.write(0);
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
    // This is now the ONLY immediate, untargeted stop. Under the array design
    // the alternative was removing every allowlist entry, one transaction per
    // recipient. update_recipient can still revoke a specific recipient in one
    // transaction, but emptying the set is no longer a thing an operator can do
    // without knowing every leaf, so pause carries more weight than it did.
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

    // There is deliberately no admin reset of the spending counter: an
    // untimelocked write of zero is the counter-reset impact by another route.

    // Replace ONE leaf. This is the whole allowlist API: addition, removal and
    // substitution are the same operation on a tree whose leaves are
    // commitments, and the contract cannot tell which one it is being asked to
    // perform. That indistinguishability is the point, and it is what
    // add/remove could not offer.
    //
    // CONSTRAINED TO A SINGLE LEAF, which is the property that survives from
    // the array design. A bare `set_root(new_root)` would let one admin call
    // replace the entire set, and the 24h notice it would give is one opaque
    // hash becoming another. Verifying the supplied path against the CURRENT
    // root with old_leaf, then recomputing at the same index with new_leaf,
    // proves that everything except position `index` is unchanged, without the
    // contract ever learning what any of it is.
    //
    // It also means the caller must already know the tree. An attacker holding
    // only the admin key cannot produce a valid sibling path, so the off-chain
    // tree is a second factor on every allowlist change. That is the defence
    // that replaces the 24h notice, and it is stronger: the notice assumed the
    // account owner could react in time, and this account gives them nothing to
    // react with (pause and revocation are both admin-gated, and the entrypoint
    // only pays allowlisted recipients, so a compromised admin closes the
    // escape window immediately).
    //
    // UNTIMELOCKED, which is a deliberate change from propose/apply. The
    // timelock protected against a compromised admin adding an address they
    // control, but an admin alone cannot spend: paying the new recipient still
    // needs the signing key. What the timelock actually bought was public
    // notice, and under a secret set there is nothing legible to notice. It
    // cost revocation latency, and revocation is the direction that has to be
    // immediate. Reinstating a timelock later means wrapping this function, not
    // changing apply_leaf_update.
    #[external("public")]
    fn update_recipient(
        index: u32,
        old_leaf: Field,
        new_leaf: Field,
        sibling_path: [Field; ALLOWLIST_TREE_HEIGHT],
    ) {
        let caller = self.context.maybe_msg_sender().unwrap();
        assert(caller == self.storage.admin.read(), "Not admin");

        let new_root = apply_leaf_update(
            self.storage.allowlist_root.read(),
            index,
            old_leaf,
            new_leaf,
            sibling_path,
        );
        self.storage.allowlist_root.write(new_root);
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

    // The stored root, so a client can check its off-chain tree against the
    // chain before building a witness against it.
    //
    // This replaces get_allowlist, which returned the set itself. There is no
    // longer a set to return: the client supplies the leaves and this reports
    // the one value that says whether its copy is current. That makes drift
    // detectable rather than silent -- without it, a stale tree shows up as
    // every transfer reverting on a root mismatch with no way to tell which
    // side is behind.
    #[external("utility")]
    unconstrained fn get_allowlist_root() -> pub Field {
        self.storage.allowlist_root.read()
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

    // Leaf commitment. Domain-separated from merkle_hash, which builds internal
    // nodes, so the two can never be confused: without the split a caller could
    // present an internal node as a leaf and prove membership with a path one
    // level short.
    //
    // The salt is what makes the set secret rather than merely unpublished.
    // Addresses are low-entropy and enumerable, so h(addr) alone would let an
    // observer test any candidate against a leaf. It also makes empty leaves
    // h(0, salt_i) mutually unrecognisable, so the tree's sparsity and the
    // add-versus-substitute distinction stay hidden.
    #[contract_library_method]
    fn allowlist_leaf(recipient: Field, salt: Field) -> Field {
        poseidon2_hash_with_separator([recipient, salt], DOM_SEP__ALLOWLIST_LEAF)
    }

    // Verify the path against `current_root` with `old_leaf`, then recompute at
    // the same index with `new_leaf`. Returns the new root.
    //
    // Both halves matter. Verifying first is what limits the call to one leaf:
    // the path is only known to be the real path if it reproduces the current
    // root, and reusing it for the recomputation pins every other position.
    // Skipping the verification would turn this into an arbitrary root write.
    //
    // Pure, so nargo test can exercise it against a real tree with no sandbox.
    #[contract_library_method]
    fn apply_leaf_update(
        current_root: Field,
        index: u32,
        old_leaf: Field,
        new_leaf: Field,
        sibling_path: [Field; ALLOWLIST_TREE_HEIGHT],
    ) -> Field {
        // A literal zero leaf is recognisable as empty to anyone reading the
        // call, which is exactly the leak per-leaf salts exist to close. A
        // correctly built tree contains none: empties are h(0, salt).
        assert(old_leaf != 0, "Old leaf must not be zero");
        assert(new_leaf != 0, "New leaf must not be zero");
        // A no-op write would let the admin present an update-shaped
        // transaction that changes nothing.
        assert(old_leaf != new_leaf, "Leaf unchanged");

        // root_from_sibling_path takes the low ALLOWLIST_TREE_HEIGHT bits of
        // the index, so without this every index has aliases that traverse
        // identically. Harmless to the root, but the index is PUBLISHED in this
        // call and off-chain tooling reconciles against it, so two different
        // published numbers naming one leaf is a reconciliation bug waiting to
        // happen. The entrypoint needs no equivalent: an aliased index there
        // either reproduces the stored root or does not.
        assert(index < 1 << ALLOWLIST_TREE_HEIGHT, "Leaf index out of range");

        assert(
            root_from_sibling_path(old_leaf, index as Field, sibling_path) == current_root,
            "Old leaf is not in the allowlist",
        );

        root_from_sibling_path(new_leaf, index as Field, sibling_path)
    }

    // Zero is rejected for the same reason the addresses are: it is a
    // well-formed Field that no real tree produces, so accepting it means a
    // deployment that looks fine and can never transfer. Every witness would
    // have to reproduce 0, and a Poseidon2 root is not 0.
    //
    // An empty allowlist is still expressible and is NOT rejected here: a tree
    // of all-empty leaves has an ordinary non-zero root. That deployment cannot
    // transfer until the admin installs a recipient, which is a state the
    // operator chose rather than one they fell into.
    #[contract_library_method]
    fn assert_root_valid(root: Field) {
        assert(root != 0, "Allowlist root must not be zero");
    }

    // Zero is rejected in both slots. It would mean "unlimited", which is a
    // fail-open default for an operator who omits an env var.
    #[contract_library_method]
    fn assert_limits_valid(max_per_tx: u128, daily_limit: u128) {
        assert(max_per_tx != 0, "Per-tx limit must be non-zero");
        assert(daily_limit != 0, "Daily limit must be non-zero");
        assert(daily_limit >= max_per_tx, "Daily limit must be >= per-tx max");
    }

    // The two addresses fixed at construction. `0x00..0` is a well-formed
    // AztecAddress, so neither can be left to the caller to get right.
    //
    // Extracted rather than left inline for the same reason assert_limits_valid
    // is: initialize_public_state is a public external that asserts on
    // msg_sender, and no `nargo test` can build that context, so an inline
    // assert there is unreachable from the test suite. The token check was
    // inline and untested until this helper existed.
    #[contract_library_method]
    fn assert_construction_addresses_valid(admin: AztecAddress, token: AztecAddress) {
        assert(!token.is_zero(), "Token must not be zero");
        // `admin` is PublicImmutable with no rotation path, and every lever on
        // this account gates on `maybe_msg_sender().unwrap() == admin.read()`.
        // msg_sender is never the zero address, so a zero admin does not fail
        // the deployment -- it succeeds and produces an account nobody can ever
        // administer: no pause, no limit change, and an allowlist frozen at
        // whatever root construction installed. Terminal and silent, which is
        // why it is the worse of the two.
        assert(!admin.is_zero(), "Admin must not be zero");
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

    // ---- M2/L2: the allowlist Merkle tree ----
    //
    // Built at TEST_TREE_HEIGHT = 3 (8 leaves) rather than ALLOWLIST_TREE_HEIGHT
    // = 10, because MerkleTree<N> materialises all N leaves and the property
    // under test is the verify-then-recompute logic, which does not vary with
    // height. The production height is pinned separately by
    // allowlist_tree_height_is_pinned and exercised by the prod_root tests.
    //
    // These use root_from_sibling_path directly rather than apply_leaf_update
    // where the height differs, since apply_leaf_update takes the production
    // path length.

    global A: Field = 0xaaaa;
    global B: Field = 0xbbbb;
    global C: Field = 0xcccc;
    global D: Field = 0xdddd;

    // Distinct salts per leaf, including the empty ones. Reusing a salt is the
    // leak the design exists to close, so the fixture models it correctly.
    global SALT_A: Field = 0x1111;
    global SALT_B: Field = 0x2222;
    global SALT_C: Field = 0x3333;
    global SALT_D: Field = 0x4444;

    global TEST_TREE_HEIGHT: u32 = 3;
    global TEST_TREE_LEAVES: u32 = 8;

    // Four real recipients and four distinctly-salted empties, which is the
    // shape a half-filled production tree has.
    #[contract_library_method]
    fn test_leaves() -> [Field; TEST_TREE_LEAVES] {
        [
            allowlist_leaf(A, SALT_A),
            allowlist_leaf(B, SALT_B),
            allowlist_leaf(C, SALT_C),
            allowlist_leaf(D, SALT_D),
            allowlist_leaf(0, 0x5555),
            allowlist_leaf(0, 0x6666),
            allowlist_leaf(0, 0x7777),
            allowlist_leaf(0, 0x8888),
        ]
    }

    #[contract_library_method]
    fn test_tree() -> aztec::protocol::merkle_tree::merkle_tree::MerkleTree<TEST_TREE_LEAVES> {
        aztec::protocol::merkle_tree::merkle_tree::MerkleTree::new(test_leaves())
    }

    // The production height is in the entrypoint ABI and therefore in the
    // account address. Changing it is an address migration, so it must be a
    // decision rather than a diff that slipped through.
    #[test]
    fn allowlist_tree_height_is_pinned() {
        assert(ALLOWLIST_TREE_HEIGHT == 10, "allowlist tree height changed");
    }

    // Leaves and internal nodes must not share a hash. Without the domain
    // split, an internal node is a well-formed leaf and a path one level short
    // proves membership of something that is not a recipient.
    #[test]
    fn leaf_and_node_hashes_are_domain_separated() {
        let l = allowlist_leaf(A, SALT_A);
        let n = aztec::protocol::merkle_tree::merkle_tree::merkle_hash(A, SALT_A);
        assert(l != n, "leaf and node hash must differ over the same inputs");
    }

    // The salt is what makes the set secret. Same recipient, different salt,
    // different leaf: an observer holding a candidate address cannot test it
    // against a leaf without also holding the salt.
    #[test]
    fn salt_hides_the_recipient() {
        assert(
            allowlist_leaf(A, SALT_A) != allowlist_leaf(A, SALT_B),
            "salt must change the commitment",
        );
    }

    // Empty leaves must not be mutually recognisable, or an observer can read
    // the tree's sparsity and tell an addition from a substitution.
    #[test]
    fn empty_leaves_are_not_recognisable() {
        let leaves = test_leaves();
        assert(leaves[4] != leaves[5], "distinctly salted empties must differ");
        assert(leaves[4] != 0, "an empty leaf is not the zero field");
    }

    // THE M2 GUARANTEE. Membership is proven in private against a root, so the
    // public side receives one field instead of the candidate set. Nothing
    // about which leaf was proven is recoverable from the root.
    #[test]
    fn membership_is_proven_against_the_root() {
        let tree = test_tree();
        let path: [Field; TEST_TREE_HEIGHT] = tree.get_sibling_path(2);
        let root = root_from_sibling_path(allowlist_leaf(C, SALT_C), 2, path);
        assert(root == tree.get_root(), "C's witness must reproduce the root");
    }

    // A recipient who is not in the tree cannot produce the root, whatever
    // index or path they pick.
    #[test]
    fn unlisted_recipient_cannot_reproduce_the_root() {
        let tree = test_tree();
        let path: [Field; TEST_TREE_HEIGHT] = tree.get_sibling_path(2);
        let root = root_from_sibling_path(allowlist_leaf(0x9999, SALT_C), 2, path);
        assert(root != tree.get_root(), "an unlisted recipient must not verify");
    }

    // A real leaf presented at the wrong index does not verify: the path is
    // consumed left/right by the index bits, so position is bound.
    #[test]
    fn witness_at_the_wrong_index_is_rejected() {
        let tree = test_tree();
        let path: [Field; TEST_TREE_HEIGHT] = tree.get_sibling_path(2);
        let root = root_from_sibling_path(allowlist_leaf(C, SALT_C), 3, path);
        assert(root != tree.get_root(), "index must be bound to the path");
    }

    // Knowing the address is not enough. Without the salt the leaf is wrong, so
    // an attacker who learns a recipient out of band still cannot build a
    // witness for it.
    #[test]
    fn correct_recipient_with_wrong_salt_is_rejected() {
        let tree = test_tree();
        let path: [Field; TEST_TREE_HEIGHT] = tree.get_sibling_path(2);
        let root = root_from_sibling_path(allowlist_leaf(C, SALT_D), 2, path);
        assert(root != tree.get_root(), "the salt is part of the witness");
    }

    // THE L2 GUARANTEE. A witness proven before an update no longer reproduces
    // the stored root, so the transaction cannot be included. Deleting the root
    // equality in check_spending_public makes this test meaningless.
    #[test]
    fn stale_witness_is_rejected() {
        let before = test_tree();
        let path: [Field; TEST_TREE_HEIGHT] = before.get_sibling_path(2);
        let proven_root = root_from_sibling_path(allowlist_leaf(C, SALT_C), 2, path);

        // C revoked: its leaf becomes a freshly salted empty.
        let mut after_leaves = test_leaves();
        after_leaves[2] = allowlist_leaf(0, 0x9abc);
        let after = aztec::protocol::merkle_tree::merkle_tree::MerkleTree::new(after_leaves);

        assert(
            proven_root != after.get_root(),
            "revocation must invalidate a witness already proven",
        );
    }

    // The flip side, and the cost of dropping the zero branch the array had:
    // an ADDITION also invalidates in-flight transactions. Recorded as a test
    // so the behaviour is a decision rather than a surprise. The operator
    // schedules additions; see the note in check_spending_public.
    #[test]
    fn addition_also_invalidates_an_inflight_witness() {
        let before = test_tree();
        let path: [Field; TEST_TREE_HEIGHT] = before.get_sibling_path(0);
        let proven_root = root_from_sibling_path(allowlist_leaf(A, SALT_A), 0, path);

        let mut after_leaves = test_leaves();
        after_leaves[4] = allowlist_leaf(0xeeee, 0x9abc); // fill an empty slot
        let after = aztec::protocol::merkle_tree::merkle_tree::MerkleTree::new(after_leaves);

        assert(
            proven_root != after.get_root(),
            "an addition moves the root, so in-flight transactions revert",
        );
    }

    // ---- The admin update path ----

    // Recompute at the test height, for the two tests that need a REAL tree to
    // check the result against. It deliberately mirrors only the recomputation,
    // not the asserts: every rejection case below runs against the production
    // apply_leaf_update instead, so deleting a guard there fails a test rather
    // than passing against a copy of itself.
    #[contract_library_method]
    fn test_leaf_update(
        current_root: Field,
        index: Field,
        old_leaf: Field,
        new_leaf: Field,
        sibling_path: [Field; TEST_TREE_HEIGHT],
    ) -> Field {
        assert(
            root_from_sibling_path(old_leaf, index, sibling_path) == current_root,
            "Old leaf is not in the allowlist",
        );
        root_from_sibling_path(new_leaf, index, sibling_path)
    }

    // A production-height tree whose sibling path is a known constant. Enough
    // to exercise apply_leaf_update's full ABI shape without materialising
    // 65,536 leaves.
    global PROD_PATH: [Field; ALLOWLIST_TREE_HEIGHT] = [0x1234; ALLOWLIST_TREE_HEIGHT];
    global PROD_INDEX: u32 = 5;

    #[contract_library_method]
    fn prod_root(leaf: Field) -> Field {
        root_from_sibling_path(leaf, PROD_INDEX as Field, PROD_PATH)
    }

    // An update produces exactly the root of the tree with that one leaf
    // replaced. This is the property that makes the call single-leaf: the
    // result is checkable against an independently built tree.
    #[test]
    fn update_replaces_exactly_one_leaf() {
        let before = test_tree();
        let path: [Field; TEST_TREE_HEIGHT] = before.get_sibling_path(1);
        let new_leaf = allowlist_leaf(0xeeee, 0x9abc);

        let produced = test_leaf_update(
            before.get_root(),
            1,
            allowlist_leaf(B, SALT_B),
            new_leaf,
            path,
        );

        let mut expected_leaves = test_leaves();
        expected_leaves[1] = new_leaf;
        let expected = aztec::protocol::merkle_tree::merkle_tree::MerkleTree::new(expected_leaves);

        assert(produced == expected.get_root(), "update must move exactly one leaf");
    }

    // Addition and removal are the same call. Filling an empty slot is an
    // addition; the contract cannot distinguish it from a substitution, which
    // is the point.
    #[test]
    fn addition_and_removal_are_the_same_operation() {
        let before = test_tree();

        // Addition: an empty leaf becomes a recipient.
        let add_path: [Field; TEST_TREE_HEIGHT] = before.get_sibling_path(4);
        let after_add = test_leaf_update(
            before.get_root(),
            4,
            allowlist_leaf(0, 0x5555),
            allowlist_leaf(0xeeee, 0x9abc),
            add_path,
        );
        assert(after_add != before.get_root(), "addition moves the root");

        // Removal: a recipient becomes a freshly salted empty. Same function,
        // same shape of arguments.
        let rm_path: [Field; TEST_TREE_HEIGHT] = before.get_sibling_path(3);
        let after_rm = test_leaf_update(
            before.get_root(),
            3,
            allowlist_leaf(D, SALT_D),
            allowlist_leaf(0, 0xdef0),
            rm_path,
        );
        assert(after_rm != before.get_root(), "removal moves the root");
    }

    // The happy path through the real helper, so the rejection tests below are
    // known to be rejecting rather than failing for an unrelated reason.
    #[test]
    fn production_height_update_round_trips() {
        let old_leaf = allowlist_leaf(A, SALT_A);
        let new_leaf = allowlist_leaf(B, SALT_B);

        let produced = apply_leaf_update(
            prod_root(old_leaf),
            PROD_INDEX,
            old_leaf,
            new_leaf,
            PROD_PATH,
        );

        assert(
            produced == prod_root(new_leaf),
            "production-height update must recompute at the same index",
        );
    }

    // THE SINGLE-LEAF GUARANTEE. Without the verify step this function is an
    // arbitrary root write, and a compromised admin replaces the whole set in
    // one call while the chain shows one opaque hash becoming another. A path
    // that does not reproduce the current root is refused.
    #[test(should_fail_with = "Old leaf is not in the allowlist")]
    fn update_with_a_forged_old_leaf_is_rejected() {
        let _ = apply_leaf_update(
            prod_root(allowlist_leaf(A, SALT_A)),
            PROD_INDEX,
            allowlist_leaf(0x9999, SALT_A), // never in the tree
            allowlist_leaf(B, SALT_B),
            PROD_PATH,
        );
    }

    // The path must belong to the index it is presented for, or an admin could
    // rewrite a different position than the one they named.
    #[test(should_fail_with = "Old leaf is not in the allowlist")]
    fn update_at_a_mismatched_index_is_rejected() {
        let leaf = allowlist_leaf(A, SALT_A);
        let _ = apply_leaf_update(
            prod_root(leaf),
            PROD_INDEX + 1, // path and root are for PROD_INDEX
            leaf,
            allowlist_leaf(B, SALT_B),
            PROD_PATH,
        );
    }

    // An update against a superseded root is refused, so two admins racing
    // cannot silently drop one of the two changes.
    #[test(should_fail_with = "Old leaf is not in the allowlist")]
    fn update_against_a_stale_root_is_rejected() {
        let _ = apply_leaf_update(
            0xbadbad, // not the current root
            PROD_INDEX,
            allowlist_leaf(A, SALT_A),
            allowlist_leaf(B, SALT_B),
            PROD_PATH,
        );
    }

    // A literal zero leaf is publicly recognisable as empty, which reintroduces
    // the leak per-leaf salts close.
    #[test(should_fail_with = "New leaf must not be zero")]
    fn update_to_a_zero_leaf_is_rejected() {
        let leaf = allowlist_leaf(A, SALT_A);
        let _ = apply_leaf_update(prod_root(leaf), PROD_INDEX, leaf, 0, PROD_PATH);
    }

    #[test(should_fail_with = "Old leaf must not be zero")]
    fn update_from_a_zero_leaf_is_rejected() {
        let leaf = allowlist_leaf(A, SALT_A);
        let _ = apply_leaf_update(prod_root(leaf), PROD_INDEX, 0, leaf, PROD_PATH);
    }

    // A no-op write would let the admin present an update-shaped transaction
    // that changes nothing.
    #[test(should_fail_with = "Leaf unchanged")]
    fn update_to_the_same_leaf_is_rejected() {
        let leaf = allowlist_leaf(A, SALT_A);
        let _ = apply_leaf_update(prod_root(leaf), PROD_INDEX, leaf, leaf, PROD_PATH);
    }

    // root_from_sibling_path reads only the low ALLOWLIST_TREE_HEIGHT bits, so
    // index and index + 2^16 traverse identically. Both would produce the same
    // root; only one is a legible thing to publish.
    #[test(should_fail_with = "Leaf index out of range")]
    fn update_at_an_aliased_index_is_rejected() {
        let leaf = allowlist_leaf(A, SALT_A);
        let _ = apply_leaf_update(
            prod_root(leaf),
            PROD_INDEX + (1 << ALLOWLIST_TREE_HEIGHT),
            leaf,
            allowlist_leaf(B, SALT_B),
            PROD_PATH,
        );
    }

    // ---- Root validation ----

    #[test]
    fn nonzero_root_accepted() {
        assert_root_valid(test_tree().get_root());
    }

    // Zero is a well-formed Field that no Poseidon2 tree produces, so a
    // deployment carrying it looks fine and can never transfer.
    #[test(should_fail_with = "Allowlist root must not be zero")]
    fn zero_root_rejected() {
        assert_root_valid(0);
    }

    // An all-empty allowlist has an ordinary root and is deliberately allowed:
    // it is a state the operator chose, not one they fell into.
    #[test]
    fn empty_allowlist_has_a_valid_root() {
        let empties = [
            allowlist_leaf(0, 0x11),
            allowlist_leaf(0, 0x22),
            allowlist_leaf(0, 0x33),
            allowlist_leaf(0, 0x44),
            allowlist_leaf(0, 0x55),
            allowlist_leaf(0, 0x66),
            allowlist_leaf(0, 0x77),
            allowlist_leaf(0, 0x88),
        ];
        let tree = aztec::protocol::merkle_tree::merkle_tree::MerkleTree::new(empties);
        assert_root_valid(tree.get_root());
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

    #[test]
    fn nonzero_construction_addresses_accepted() {
        assert_construction_addresses_valid(
            AztecAddress::from_field(1),
            AztecAddress::from_field(2),
        );
    }

    // The one that motivated the helper. A zero admin is not a failed
    // deployment, it is a successful one that can never be administered again,
    // and nothing above the contract stopped it: the bridge validated this
    // address with a hex-shape regex that `0x00..0` satisfies.
    #[test(should_fail_with = "Admin must not be zero")]
    fn zero_admin_rejected() {
        assert_construction_addresses_valid(
            AztecAddress::from_field(0),
            AztecAddress::from_field(2),
        );
    }

    #[test(should_fail_with = "Token must not be zero")]
    fn zero_token_rejected() {
        assert_construction_addresses_valid(
            AztecAddress::from_field(1),
            AztecAddress::from_field(0),
        );
    }
}
