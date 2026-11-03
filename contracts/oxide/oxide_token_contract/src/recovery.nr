//! Withdrawal recovery chunks reach the token in capsules, not in call arguments.
//!
//! A chunk holds the TEE's withdrawal signature, which exists only after the TEE has signed the simulated tx. An owner
//! who delegates `withdraw` signs an authwit over the call's arguments, and a wallet may have to get that signature
//! before it simulates (for example, a passkey prompt at the user's click). If the chunk were an argument, the authwit
//! would have to cover data that does not exist yet.
//!
//! So the tx sender supplies the chunks, and the owner's authwit does not cover them. Recovery assumes that the sender
//! cooperates. An authwit over the chunks would not remove this assumption: the sender supplies the randomness seed of
//! the withdrawal message, so the owner depends on the sender for the recovery data in any case.
//!
//! The client puts the chunks of the k-th withdrawal of the tx in a `CapsuleArray` at `recovery_chunks_capsule_slot(k)`.
//! The token counts its withdrawals in a `TransientValue`, which all its call frames in the tx share. Each chunk that
//! the token emits must have a capsule, also in the simulation.

use aztec::{
    capsules::CapsuleArray,
    messages::logs::event::MAX_EVENT_SERIALIZED_LEN,
    protocol::{address::AztecAddress, hash::{poseidon2_hash, sha256_to_field}},
    transient::TransientValue,
};

pub global OXIDE_TOKEN_RECOVERY_CHUNKS_CAPSULE_SLOT: Field = sha256_to_field("OXIDE_TOKEN::RECOVERY_CHUNKS".as_bytes());

global OXIDE_TOKEN_WITHDRAWAL_INDEX_TRANSIENT_SLOT: Field = sha256_to_field("OXIDE_TOKEN::WITHDRAWAL_INDEX".as_bytes());

/// Returns the slot of the recovery chunks capsule array of the next withdrawal of the tx.
pub unconstrained fn next_recovery_chunks_slot() -> Field {
    let withdrawal_index = TransientValue::at(OXIDE_TOKEN_WITHDRAWAL_INDEX_TRANSIENT_SLOT);
    let current = withdrawal_index.read().unwrap_or(0);
    withdrawal_index.store(current + 1);
    recovery_chunks_capsule_slot(current)
}

/// Returns chunk at `index` of the recovery chunks capsule array at `chunks_slot`.
pub unconstrained fn get_recovery_chunk(
    contract_address: AztecAddress,
    chunks_slot: Field,
    index: u32,
) -> [Field; MAX_EVENT_SERIALIZED_LEN] {
    let chunks = CapsuleArray::at(contract_address, chunks_slot, AztecAddress::zero());
    assert(index < chunks.len(), f"Recovery chunk {index} is missing");
    chunks.get(index)
}

/// Returns the number of recovery chunks of capsule array at `chunks_slot`.
pub unconstrained fn get_recovery_chunk_count(contract_address: AztecAddress, chunks_slot: Field) -> u32 {
    CapsuleArray::<[Field; MAX_EVENT_SERIALIZED_LEN]>::at(contract_address, chunks_slot, AztecAddress::zero()).len()
}

pub fn recovery_chunks_capsule_slot(withdrawal_index: Field) -> Field {
    poseidon2_hash([OXIDE_TOKEN_RECOVERY_CHUNKS_CAPSULE_SLOT, withdrawal_index])
}

mod test {
    use super::{get_recovery_chunk, get_recovery_chunk_count, next_recovery_chunks_slot, recovery_chunks_capsule_slot};
    use aztec::{
        capsules::CapsuleArray, messages::logs::event::MAX_EVENT_SERIALIZED_LEN, protocol::address::AztecAddress,
        test::helpers::test_environment::TestEnvironment,
    };

    #[test]
    unconstrained fn reads_the_chunks_of_each_withdrawal_from_its_own_array() {
        let mut env = TestEnvironment::new();
        let token = env.create_light_account();
        env.utility_context_at(token, |context| {
            let address = context.this_address();
            let first = CapsuleArray::at(
                address,
                recovery_chunks_capsule_slot(0),
                AztecAddress::zero(),
            );
            first.push([1; MAX_EVENT_SERIALIZED_LEN]);
            first.push([2; MAX_EVENT_SERIALIZED_LEN]);
            let second = CapsuleArray::at(
                address,
                recovery_chunks_capsule_slot(1),
                AztecAddress::zero(),
            );
            second.push([3; MAX_EVENT_SERIALIZED_LEN]);

            let first_slot = next_recovery_chunks_slot();
            assert_eq(get_recovery_chunk(address, first_slot, 0), [1; MAX_EVENT_SERIALIZED_LEN]);
            assert_eq(get_recovery_chunk(address, first_slot, 1), [2; MAX_EVENT_SERIALIZED_LEN]);
            assert_eq(get_recovery_chunk_count(address, first_slot), 2);
            let second_slot = next_recovery_chunks_slot();
            assert_eq(get_recovery_chunk(address, second_slot, 0), [3; MAX_EVENT_SERIALIZED_LEN]);
            assert_eq(get_recovery_chunk_count(address, second_slot), 1);
        });
    }

    #[test(should_fail_with = "Recovery chunk 0 is missing")]
    unconstrained fn rejects_a_missing_chunk() {
        let mut env = TestEnvironment::new();
        let token = env.create_light_account();
        env.utility_context_at(token, |context| {
            let _ = get_recovery_chunk(context.this_address(), next_recovery_chunks_slot(), 0);
        });
    }
}
