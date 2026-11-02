use aztec::{
    oracle::get_membership_witness::get_maybe_block_hash_membership_witness, protocol::abis::block_header::BlockHeader,
};

/// Returns whether `block_hash` is present in the archive tree anchored at `anchor_block_header`.
pub unconstrained fn is_block_in_archive(anchor_block_header: BlockHeader, block_hash: Field) -> bool {
    get_maybe_block_hash_membership_witness(anchor_block_header, block_hash).is_some()
}
