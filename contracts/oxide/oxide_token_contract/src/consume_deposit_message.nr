use aztec::{
    context::PrivateContext,
    oracle::get_l1_to_l2_membership_witness::{get_l1_to_l2_membership_witness, UnsiloedNullifier},
    protocol::{address::{AztecAddress, EthAddress}, merkle_tree::root::root_from_sibling_path},
};
use oxide_token_lib::deposit_message_hashing::{compute_deposit_message_hash, compute_deposit_message_nullifier};

/// Consumes an L1 -> L2 deposit message like `PrivateContext::consume_l1_to_l2_message`, but uses a custom nullifier
/// scheme.
///
/// We use custom nullifier scheme here as both `shared_secret_salt` and `recipient` are known by the resolver. Hence
/// if we used the default Aztec.nr nullifier scheme we wouldn't get spending privacy from resolver.
pub fn consume_deposit_message(
    context: &mut PrivateContext,
    l1_portal: EthAddress,
    shared_secret_salt: Field,
    recipient: AztecAddress,
    amount: u128,
    leaf_index: Field,
    nhk_app: Field,
) {
    let message_hash = compute_deposit_message_hash(
        l1_portal,
        context.chain_id(),
        context.this_address(),
        context.version(),
        shared_secret_salt,
        recipient,
        amount,
        leaf_index,
    );
    let nullifier = compute_deposit_message_nullifier(message_hash, nhk_app);

    // Safety: the witness is only a hint that makes the constrained root check below pass.
    let (_witness_index, sibling_path) = unsafe {
        get_l1_to_l2_membership_witness(
            message_hash,
            Option::some(
                UnsiloedNullifier { contract_address: context.this_address(), nullifier },
            ),
        )
    };
    let root = root_from_sibling_path(message_hash, leaf_index, sibling_path);
    assert_eq(root, context.get_anchor_block_header().state.l1_to_l2_message_tree.root, "Message not in state");

    context.push_nullifier_unsafe(nullifier);
}
