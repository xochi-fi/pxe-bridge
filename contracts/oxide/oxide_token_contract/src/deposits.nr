//! Unspent deposit hints, kept in the PXE fact store.
//!
//! Every recorded deposit is one fact collection, scoped to its recipient and identified by the deposit's inbox
//! index. The collection holds a non-retractable fact with the deposit itself, and, once the deposit's nullifier is
//! seen in the tree, a retractable fact marking it spent. The spent fact's origin is the block that included the
//! nullifier, so if a reorg drops the spend PXE retracts the spent fact, which makes the deposit selectable again.
//! Once that block is finalized the spend can no longer be reorged and the whole collection is deleted.
//!
//! Spent-tracking happens during sync, not execution, by checking for existence of the nullifier. A transaction
//! simulation persists its store writes like any other job, so a fact recorded while executing a spend would be
//! persisted even if the transaction was never sent. Sync runs before every execution at the same anchor block, so
//! readers can rely on the spent facts being current.
use aztec::{
    context::UtilityContext,
    ephemeral::EphemeralArray,
    facts::{
        delete_fact_collection, Fact, FactCollection, FactScope, get_fact_collection, get_fact_collections_by_type,
        record_non_retractable_fact, record_retractable_fact,
    },
    keys::getters::{get_nhk_app, get_public_keys},
    oracle::{
        get_l1_to_l2_membership_witness::{get_l1_to_l2_membership_witness, UnsiloedNullifier},
        nullifiers::{check_nullifier_exists, get_nullifier_statuses, is_nullifier_pending},
    },
    protocol::{
        address::{AztecAddress, EthAddress},
        constants::MAX_NULLIFIERS_PER_CALL,
        hash::sha256_to_field,
        merkle_tree::root::root_from_sibling_path,
        traits::{Deserialize, Serialize},
    },
};
use oxide_token_lib::deposit_message_hashing::{compute_deposit_message_hash, compute_deposit_message_nullifier};

global DEPOSIT_FACT_COLLECTION_TYPE_ID: Field = sha256_to_field("OXIDE_TOKEN::DEPOSIT".as_bytes());

global DEPOSIT_RECORDED_FACT_TYPE_ID: Field = 1;
global DEPOSIT_SPENT_FACT_TYPE_ID: Field = 2;

/// Each spent deposit consumes one L1 -> L2 message, which emits one nullifier, so a single call can never spend more
/// deposits than the kernel's per-call nullifier budget.
pub global MAX_DEPOSITS_PER_CALL: u32 = MAX_NULLIFIERS_PER_CALL;

#[derive(Deserialize, Serialize)]
pub struct Deposit {
    pub inbox_index: Field,
    pub amount: u128,
    pub shared_secret_salt: Field,
    // The following values are stored just so that we don't waste time to re-deriving them
    pub message_hash: Field,
    pub nullifier: Field,
}

/// Records `recipient`'s unspent deposit at `inbox_index` as a spendable hint.
///
/// Fails if the deposit is already spent, already recorded, or not yet in the synced L1 -> L2 message tree.
pub unconstrained fn store_deposit(
    context: UtilityContext,
    portal: EthAddress,
    inbox_index: Field,
    amount: u128,
    recipient: AztecAddress,
    shared_secret_salt: Field,
) {
    let contract_address = context.this_address();

    let message_hash = compute_deposit_message_hash(
        portal,
        context.chain_id(),
        contract_address,
        context.version(),
        shared_secret_salt,
        recipient,
        amount,
        inbox_index,
    );

    // The membership-witness oracle only serves non-nullified messages so we check the nullifier first to not get
    // an incorrect error.
    let nhk_app = get_nhk_app(get_public_keys(recipient).npk_m_hash);
    let inner_nullifier = compute_deposit_message_nullifier(message_hash, nhk_app);
    assert(!check_nullifier_exists(inner_nullifier), "deposit already spent");
    assert(
        get_fact_collection(
            contract_address,
            FactScope::account(recipient),
            DEPOSIT_FACT_COLLECTION_TYPE_ID,
            inbox_index,
        )
            .is_none(),
        "deposit already stored",
    );

    let (_witness_index, sibling_path) = get_l1_to_l2_membership_witness(
        message_hash,
        Option::some(
            UnsiloedNullifier { contract_address, nullifier: inner_nullifier },
        ),
    );
    let root = root_from_sibling_path(message_hash, inbox_index, sibling_path);
    assert(root == context.block_header().state.l1_to_l2_message_tree.root, "deposit message does not exist");

    record_deposit(
        contract_address,
        recipient,
        Deposit { inbox_index, amount, shared_secret_salt, message_hash, nullifier: inner_nullifier },
    );
}

/// Records `deposit` as a spendable hint of `recipient`.
unconstrained fn record_deposit(contract_address: AztecAddress, recipient: AztecAddress, deposit: Deposit) {
    let payload: EphemeralArray<Field> = EphemeralArray::from_array(deposit.serialize());
    record_non_retractable_fact(
        contract_address,
        FactScope::account(recipient),
        DEPOSIT_FACT_COLLECTION_TYPE_ID,
        deposit.inbox_index,
        DEPOSIT_RECORDED_FACT_TYPE_ID,
        payload,
    );
}

/// Updates the spent state of `owner`'s deposit hints.
///
/// Marks a deposit as spent once its nullifier is in the tree, and forgets it once the spend can no longer be reorged.
///
/// Should be called during contract sync so that already spent deposits are not used again in follow-up
/// transactions.
pub unconstrained fn sync_deposits(contract_address: AztecAddress, owner: AztecAddress) {
    let unspent = unspent_deposits(contract_address, owner);
    let statuses = get_nullifier_statuses(unspent.map(|deposit: Deposit| deposit.nullifier));
    for i in 0..unspent.len() {
        let status = statuses.get(i);
        if status.exists {
            let deposit = unspent.get(i);
            let nullifier = deposit.nullifier;
            // Sync runs outside of any transaction, so there are no pending nullifiers - if they exist they must be
            // settled.
            let spent_at = status.origin_block.expect(f"deposit nullifier {nullifier} exists but is not in a block");
            let empty_payload: EphemeralArray<Field> = EphemeralArray::empty();
            record_retractable_fact(
                contract_address,
                FactScope::account(owner),
                DEPOSIT_FACT_COLLECTION_TYPE_ID,
                deposit.inbox_index,
                DEPOSIT_SPENT_FACT_TYPE_ID,
                empty_payload,
                spent_at,
            );
        }
    }

    // Read after recording, so that a spend recorded above whose block is already finalized is deleted in this sync.
    let collections = get_fact_collections_by_type(
        contract_address,
        FactScope::account(owner),
        DEPOSIT_FACT_COLLECTION_TYPE_ID,
    );
    for i in 0..collections.len() {
        let collection = collections.get(i);
        let maybe_spent = spent_fact(collection);
        if maybe_spent.is_some() {
            if maybe_spent.unwrap().origin_block.unwrap().block_state.is_finalized() {
                delete_fact_collection(
                    contract_address,
                    FactScope::account(owner),
                    DEPOSIT_FACT_COLLECTION_TYPE_ID,
                    collection.fact_collection_id,
                );
            }
        }
    }
}

/// Sum of `owner`'s recorded unspent deposits.
pub unconstrained fn balance(contract_address: AztecAddress, owner: AztecAddress) -> u128 {
    let deposits = unspent_deposits(contract_address, owner);
    let mut balance: u128 = 0;
    for i in 0..deposits.len() {
        balance += deposits.get(i).amount;
    }
    balance
}

/// Selects up to `max_deposits` unspent deposits, stopping once `amount` is reached.
///
/// Only callable from private execution: it consults the transaction's pending nullifiers so that a deposit consumed
/// by an earlier call of the same transaction is not selected twice.
pub unconstrained fn next_deposits(
    contract_address: AztecAddress,
    owner: AztecAddress,
    amount: u128,
    max_deposits: u32,
) -> BoundedVec<Deposit, MAX_DEPOSITS_PER_CALL> {
    assert(max_deposits <= MAX_DEPOSITS_PER_CALL);
    let deposits = unspent_deposits(contract_address, owner);
    let mut result = BoundedVec::new();
    let mut selected: u128 = 0;
    for i in 0..deposits.len() {
        if (result.len() < max_deposits) & (selected < amount) {
            let deposit = deposits.get(i);
            if !is_nullifier_pending(deposit.nullifier, contract_address) {
                result.push(deposit);
                selected += deposit.amount;
            }
        }
    }
    result
}

/// Recorded deposits whose spend has not been observed at the synced anchor block.
unconstrained fn unspent_deposits(contract_address: AztecAddress, owner: AztecAddress) -> EphemeralArray<Deposit> {
    get_fact_collections_by_type(
        contract_address,
        FactScope::account(owner),
        DEPOSIT_FACT_COLLECTION_TYPE_ID,
    )
        .filter(|collection: FactCollection| spent_fact(collection).is_none())
        .map(|collection: FactCollection| recorded_deposit(collection))
}

unconstrained fn recorded_deposit(collection: FactCollection) -> Deposit {
    let fact = collection.facts.find(|f: Fact| f.fact_type_id == DEPOSIT_RECORDED_FACT_TYPE_ID).unwrap();
    let mut fields = [0; <Deposit as Deserialize>::N];
    for i in 0..fields.len() {
        fields[i] = fact.payload.get(i);
    }
    Deposit::deserialize(fields)
}

unconstrained fn spent_fact(collection: FactCollection) -> Option<Fact> {
    collection.facts.find(|f: Fact| f.fact_type_id == DEPOSIT_SPENT_FACT_TYPE_ID)
}

mod test {
    use super::{balance, Deposit, DEPOSIT_FACT_COLLECTION_TYPE_ID, next_deposits, record_deposit, sync_deposits};
    use aztec::{
        facts::{FactScope, get_fact_collection},
        protocol::address::AztecAddress,
        test::helpers::test_environment::TestEnvironment,
    };

    global INBOX_INDEX: Field = 7;
    global AMOUNT: u128 = 100;
    global NULLIFIER: Field = 0x1234;

    global DEPOSIT: Deposit = Deposit {
        inbox_index: INBOX_INDEX,
        amount: AMOUNT,
        shared_secret_salt: 1,
        message_hash: 2,
        nullifier: NULLIFIER,
    };

    /// Returns the test environment and a deposit owner.
    unconstrained fn setup() -> (TestEnvironment, AztecAddress) {
        let mut env = TestEnvironment::new();
        let owner = env.create_light_account();
        (env, owner)
    }

    #[test]
    unconstrained fn sync_keeps_an_unspent_deposit() {
        let (env, owner) = setup();
        env.utility_context(|context| record_deposit(context.this_address(), owner, DEPOSIT));

        env.utility_context(|context| {
            let contract_address = context.this_address();
            sync_deposits(contract_address, owner);
            assert_eq(balance(contract_address, owner), AMOUNT);
        });
    }

    #[test]
    unconstrained fn sync_deletes_a_deposit_once_its_spend_is_finalized() {
        let (env, owner) = setup();
        env.utility_context(|context| record_deposit(context.this_address(), owner, DEPOSIT));

        env.private_context(|context| {
            sync_deposits(context.this_address(), owner);
            context.push_nullifier_unsafe(NULLIFIER);
        });

        // TXE finalizes all blocks immediately, so the previous nullifier is finalized already
        env.utility_context(|context| {
            let contract_address = context.this_address();
            sync_deposits(contract_address, owner);

            assert_eq(balance(contract_address, owner), 0);

            assert(get_fact_collection(
                contract_address,
                FactScope::account(owner),
                DEPOSIT_FACT_COLLECTION_TYPE_ID,
                INBOX_INDEX,
            )
                .is_none());
        });
    }

    #[test]
    unconstrained fn next_deposits_skips_a_deposit_spent_earlier_in_the_transaction() {
        let (env, owner) = setup();
        env.utility_context(|context| record_deposit(context.this_address(), owner, DEPOSIT));

        env.private_context(|context| {
            let contract_address = context.this_address();
            assert_eq(next_deposits(contract_address, owner, AMOUNT, 1).len(), 1);
            context.push_nullifier_unsafe(NULLIFIER);
            assert_eq(next_deposits(contract_address, owner, AMOUNT, 1).len(), 0);
        });
    }
}
