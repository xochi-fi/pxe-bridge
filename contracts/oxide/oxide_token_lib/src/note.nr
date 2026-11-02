// Note-hash + nullifier formulas the L2 contract emits and the refund circuits recompute.
// The two must match byte-for-byte or the circuits' note-membership / nullifier-non-inclusion
// checks fail; this module is the single source of truth for both sides.

use aztec::protocol::{
    address::AztecAddress,
    constants::{DOM_SEP__NOTE_HASH, DOM_SEP__NOTE_NULLIFIER},
    hash::poseidon2_hash_with_separator,
    traits::ToField,
};

/// Inner note hash the L2 contract emits via `AssertedNote::compute_note_hash` and the refund
/// circuit recomputes when proving membership. The protocol siloes + uniquifies this further before
/// it lands in the note-hash tree - both call sites apply the same protocol-side post-processing.
pub fn compute_inner_note_hash(amount: u128, owner: AztecAddress, storage_slot: Field, randomness: Field) -> Field {
    poseidon2_hash_with_separator(
        [amount as Field, owner.to_field(), storage_slot, randomness],
        DOM_SEP__NOTE_HASH,
    )
}

/// Inner nullifier the L2 contract emits via `AssertedNote::compute_nullifier` and the refund
/// circuit recomputes for non-inclusion proofs. `note_hash_for_nullification` is the protocol's
/// unique note hash; `secret` is the owner's app-siloed nullifier key. The protocol siloes the
/// result under the contract address before insertion into the nullifier tree.
pub fn compute_inner_nullifier(note_hash_for_nullification: Field, secret: Field) -> Field {
    poseidon2_hash_with_separator(
        [note_hash_for_nullification, secret],
        DOM_SEP__NOTE_NULLIFIER,
    )
}
