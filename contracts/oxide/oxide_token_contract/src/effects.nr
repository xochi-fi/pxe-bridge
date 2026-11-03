// Offchain effects reporting what a simulated spend did to the client's effects collector. Spends select notes and
// deposits inside unconstrained contract code, so without these effects the client would not know which inputs the
// simulation consumed or which outputs it produced. The collector forwards the collected data to the TEE, which
// verifies both sides of the balance invariant (spent notes + spent deposits == created notes + withdrawals) and
// signs the operation's outputs.
//
// One effect type per balance-invariant term:
// - `NullificationEffect`: a spent note (input). Carries the note's TEE signature so the TEE can verify the value
//   entering the spend was previously attested.
// - `DepositEffect`: a spent L1 -> L2 deposit (input). Value entering with no TEE-signed note behind it; the
//   TEE instead verifies the message against the L1 -> L2 message tree and binds its deposit-message nullifier into
//   the signature so the same deposit cannot fund more than one signed operation.
// - `InsertionEffect`: a created note (output). What the TEE attests to with its signature.
// - `WithdrawalEffect`: an L2 -> L1 withdrawal (output). Attested so the portal will release the funds on L1.
//
// Every effect serializes as `[ACCOUNTING_EFFECT_IDENTIFIER, typ, ...payload]`. The identifier namespaces the effects
// on the shared `emit_offchain_effect` channel; the collector keeps effects that carry it and skips everything else.
use crate::{asserted_note::AssertedNote, k1_verify::Signature};
use aztec::{
    note::{ConfirmedNote, note_interface::NoteHash, note_metadata::NoteMetadata},
    oracle::{notes::get_settled_note_origin, offchain_effect::emit_offchain_effect},
    protocol::{address::{AztecAddress, EthAddress}, traits::{Deserialize, Serialize}},
};

use oxide_lib::constants::{
    ACCOUNTING_EFFECT_IDENTIFIER, DEPOSIT_EFFECT_TYPE, INSERTION_EFFECT_TYPE, NULLIFICATION_EFFECT_TYPE,
    WITHDRAWAL_EFFECT_TYPE,
};

#[derive(Serialize, Deserialize)]
struct NullificationEffect {
    identifier: Field,
    typ: u8,
    amount: u128,
    owner: AztecAddress,
    randomness: Field,
    storage_slot: Field,
    proven_note_hash: Field,
    metadata: NoteMetadata,
    signature: Signature,
    creation_tx_hash: Field,
}

impl NullificationEffect {
    fn new(note: ConfirmedNote<AssertedNote>, creation_tx_hash: Field) -> Self {
        Self {
            identifier: ACCOUNTING_EFFECT_IDENTIFIER,
            typ: NULLIFICATION_EFFECT_TYPE,
            amount: note.note.amount,
            owner: note.owner,
            randomness: note.note.randomness,
            storage_slot: note.storage_slot,
            proven_note_hash: note.proven_note_hash,
            metadata: note.metadata,
            signature: note.note.signature,
            creation_tx_hash,
        }
    }
}

pub unconstrained fn emit_nullification_effect(contract_address: AztecAddress, note: ConfirmedNote<AssertedNote>) {
    // A pending note is created by the transaction that spends it, so it has no creation tx to report. The collector
    // reads a zero `creation_tx_hash` as a pending note.
    let creation_tx_hash = if note.metadata.is_settled() {
        let note_hash = note.note.compute_note_hash(note.owner, note.storage_slot, note.randomness);
        let note_nonce = note.metadata.to_settled().note_nonce();
        get_settled_note_origin(note_hash, contract_address, note_nonce)
            .expect(f"settled note with hash {note_hash} and nonce {note_nonce} has no origin in the PXE note store")
            .tx_hash
    } else {
        0
    };
    emit_offchain_effect(NullificationEffect::new(note, creation_tx_hash));
}

#[derive(Serialize, Deserialize)]
struct InsertionEffect {
    identifier: Field,
    typ: u8,
    amount: u128,
    owner: AztecAddress,
    randomness: Field,
    storage_slot: Field,
}

impl InsertionEffect {
    fn new(amount: u128, owner: AztecAddress, randomness: Field, storage_slot: Field) -> Self {
        Self {
            identifier: ACCOUNTING_EFFECT_IDENTIFIER,
            typ: INSERTION_EFFECT_TYPE,
            amount,
            owner,
            randomness,
            storage_slot,
        }
    }
}

pub unconstrained fn emit_insertion_effect(amount: u128, owner: AztecAddress, randomness: Field, storage_slot: Field) {
    emit_offchain_effect(
        InsertionEffect::new(amount, owner, randomness, storage_slot),
    );
}

#[derive(Serialize, Deserialize)]
struct WithdrawalEffect {
    identifier: Field,
    typ: u8,
    executor: EthAddress,
    user_payload_hash: Field,
    amount: u128,
    prover_tip: u128,
    randomness: Field,
}

impl WithdrawalEffect {
    fn new(executor: EthAddress, user_payload_hash: Field, amount: u128, prover_tip: u128, randomness: Field) -> Self {
        Self {
            identifier: ACCOUNTING_EFFECT_IDENTIFIER,
            typ: WITHDRAWAL_EFFECT_TYPE,
            executor,
            user_payload_hash,
            amount,
            prover_tip,
            randomness,
        }
    }
}

pub unconstrained fn emit_withdrawal_effect(
    executor: EthAddress,
    user_payload_hash: Field,
    amount: u128,
    prover_tip: u128,
    randomness: Field,
) {
    emit_offchain_effect(
        WithdrawalEffect::new(executor, user_payload_hash, amount, prover_tip, randomness),
    );
}

#[derive(Serialize, Deserialize)]
struct DepositEffect {
    identifier: Field,
    typ: u8,
    recipient: AztecAddress,
    amount: u128,
    shared_secret_salt: Field,
    inbox_index: Field,
    message_hash: Field,
}

impl DepositEffect {
    fn new(
        recipient: AztecAddress,
        amount: u128,
        shared_secret_salt: Field,
        inbox_index: Field,
        message_hash: Field,
    ) -> Self {
        Self {
            identifier: ACCOUNTING_EFFECT_IDENTIFIER,
            typ: DEPOSIT_EFFECT_TYPE,
            recipient,
            amount,
            shared_secret_salt,
            inbox_index,
            message_hash,
        }
    }
}

pub unconstrained fn emit_deposit_effect(
    recipient: AztecAddress,
    amount: u128,
    shared_secret_salt: Field,
    inbox_index: Field,
    message_hash: Field,
) {
    emit_offchain_effect(
        DepositEffect::new(
            recipient,
            amount,
            shared_secret_salt,
            inbox_index,
            message_hash,
        ),
    );
}
