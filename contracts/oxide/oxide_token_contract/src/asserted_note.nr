use super::{k1_verify::Signature, randomness::next_randomness, strict_mode::is_strict_mode};
use aztec::{
    context::PrivateContext,
    keys::getters::{get_nhk_app, get_public_keys, try_get_public_keys},
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    oracle::capsules,
    protocol::{
        address::AztecAddress,
        hash::{poseidon2_hash, sha256_to_field},
        traits::{Deserialize, Packable, Serialize},
    },
};
use oxide_token_lib::note::{compute_inner_note_hash, compute_inner_nullifier};

#[derive(Deserialize, Eq, Packable, Serialize)]
#[custom_note]
pub struct AssertedNote {
    pub amount: u128,
    pub randomness: Field,
    pub signature: Signature,
}

impl NoteHash for AssertedNote {
    fn compute_note_hash(
        self,
        owner: AztecAddress,
        storage_slot: Field,
        _randomness: Field, // Aztec_nr randomness: unused
    ) -> Field {
        compute_inner_note_hash(self.amount, owner, storage_slot, self.randomness)
    }

    fn compute_nullifier(
        self,
        context: &mut PrivateContext,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let secret = context.request_nhk_app(owner_npk_m_hash);
        compute_inner_nullifier(note_hash_for_nullification, secret)
    }

    unconstrained fn compute_nullifier_unconstrained(
        self,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Option<Field> {
        try_get_public_keys(owner).map(|public_keys| {
            let owner_npk_m_hash = public_keys.npk_m_hash;
            let secret = get_nhk_app(owner_npk_m_hash);
            compute_inner_nullifier(note_hash_for_nullification, secret)
        })
    }
}

impl AssertedNote {
    pub fn create(context: &mut PrivateContext, amount: u128) -> Self {
        // Safety: Randomness is really just a prover chosen value.
        let randomness = unsafe { next_randomness(context.this_address()) };

        // Safety: The signature is verified on reception. We can't verify it on send by design.
        let signature = unsafe { load_signature(context.this_address(), randomness) };

        Self { amount, randomness, signature }
    }
}

pub global OXIDE_TOKEN_NOTE_SIGNATURE_CAPSULE_SLOT: Field = sha256_to_field("OXIDE_TOKEN::NOTE_SIGNATURE".as_bytes());

unconstrained fn load_signature(contract_address: AztecAddress, randomness: Field) -> Signature {
    let signature_capsule_slot = poseidon2_hash([OXIDE_TOKEN_NOTE_SIGNATURE_CAPSULE_SLOT, randomness]);

    let signature: Option<Signature> = capsules::load::<Signature>(
        contract_address,
        signature_capsule_slot,
        AztecAddress::zero(),
    );

    let strict_mode = is_strict_mode(contract_address);

    // Fail if signature not found in strict mode
    if strict_mode {
        signature.unwrap()
    } else {
        signature.unwrap_or(std::mem::zeroed())
    }
}
