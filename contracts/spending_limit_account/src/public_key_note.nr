use aztec::{macros::notes::note, protocol::traits::Packable};

// Stores a Schnorr public key as two field elements (curve point coordinates).
// Identical to the standard SchnorrAccount public key note.
#[derive(Eq, Packable)]
#[note]
pub struct PublicKeyNote {
    pub x: Field,
    pub y: Field,
}
