// TODO(benesjan): Consider moving this into deposit_message_hashing.nr and merge oxide_token_lib and oxide_lib
use aztec::protocol::{
    address::AztecAddress, constants::DOM_SEP__SECRET_HASH, hash::poseidon2_hash_with_separator, traits::ToField,
};

/// The deposit message's secretHash slot: blinds the recipient behind `shared_secret_salt`, a high-entropy salt
/// known to the depositing application and the recipient.
pub fn compute_recipient_commitment(shared_secret_salt: Field, recipient: AztecAddress) -> Field {
    poseidon2_hash_with_separator(
        [shared_secret_salt, recipient.to_field()],
        DOM_SEP__SECRET_HASH,
    )
}
