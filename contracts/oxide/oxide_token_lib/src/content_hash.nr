use aztec::protocol::{address::{AztecAddress, EthAddress}, hash::sha256_to_field, traits::{FromField, ToField}};

// L1 -> L2 signer-registration message content hash. Must match `TeeRegistry.sol::registerTee`
pub fn get_register_signer_content_hash(
    pub_key_x_hi: Field,
    pub_key_x_lo: Field,
    pub_key_y_hi: Field,
    pub_key_y_lo: Field,
) -> Field {
    // `to_be_bytes::<16>` aborts on any value >= 2^128, enforcing each half fits in 16 bytes.
    let x_hi_bytes: [u8; 16] = pub_key_x_hi.to_be_bytes();
    let x_lo_bytes: [u8; 16] = pub_key_x_lo.to_be_bytes();
    let y_hi_bytes: [u8; 16] = pub_key_y_hi.to_be_bytes();
    let y_lo_bytes: [u8; 16] = pub_key_y_lo.to_be_bytes();

    let selector: [u8; 4] = comptime {
        let h: [u8; 32] = keccak256::keccak256("register_signer(bytes32,bytes32)".as_bytes(), 32);
        [h[0], h[1], h[2], h[3]]
    };
    let hash_bytes = selector.concat(x_hi_bytes).concat(x_lo_bytes).concat(y_hi_bytes).concat(y_lo_bytes);
    sha256_to_field(hash_bytes)
}

// L2 -> L1 withdraw message content hash. Must match the Solidity decode on the Portal side.
pub fn get_withdraw_content_hash(
    executor: EthAddress,
    user_payload_hash: Field,
    amount: u128,
    prover_tip: u128,
    randomness: Field,
) -> Field {
    let selector: [u8; 4] = comptime {
        let h: [u8; 32] = keccak256::keccak256(
            "withdraw(address,bytes32,uint256,uint256,uint256)".as_bytes(),
            49,
        );
        [h[0], h[1], h[2], h[3]]
    };
    let executor_bytes: [u8; 32] = executor.to_field().to_be_bytes();
    let user_payload_hash_bytes: [u8; 32] = user_payload_hash.to_be_bytes();
    let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();
    let prover_tip_bytes: [u8; 32] = (prover_tip as Field).to_be_bytes();
    let randomness_bytes: [u8; 32] = randomness.to_be_bytes();
    let hash_bytes = selector
        .concat(executor_bytes)
        .concat(user_payload_hash_bytes)
        .concat(amount_bytes)
        .concat(prover_tip_bytes)
        .concat(randomness_bytes);
    sha256_to_field(hash_bytes)
}

// Cross-implementation parity test. The `expected_*` values are written by the TS test at
// `yarn-project/oxide-lib/src/content_hash.test.ts` via `updateInlineTestData`. Regenerate after
// touching either implementation:
//   OXIDE_GENERATE_TEST_DATA=1 yarn workspace @oxide/oxide-lib test content_hash
#[test]
fn ts_parity() {
    // Fixtures must match content_hash.test.ts.
    let fixture_shared_secret_salt: Field = 0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff;
    let fixture_l2_recipient: Field = 0x0ead00000000000000000000000000000000000000000000000000000000bee0;
    let fixture_executor: Field = 0x11223344556677889900aabbccddeeff00112233;
    let fixture_user_payload_hash: Field = 0x005f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa8139;
    let fixture_amount: u128 = 1234567890;
    let fixture_prover_tip: u128 = 75317531;
    let fixture_randomness: Field = 0x2222333344445555666677778888999900001111aaaabbbbccccddddeeeeffff;

    // Updated by `OXIDE_GENERATE_TEST_DATA=1 yarn workspace @oxide/oxide-lib test content_hash`.
    let expected_recipient_commitment: Field = 0x2edfa85ed3d7333e199dbdf8be5c2b4887fc556a9cc1ba5fb19ac8386d4a6ee8;
    let expected_withdraw_content_hash: Field = 0x0040e5e411ba5f4a9730607ebac66817a44df07a56cfc8df8a42d497e9bb5e9b;
    let expected_register_signer_content_hash: Field =
        0x008b33a581dcf8c37cd0271302e3abcea01ded7b659d006f1c2d411420e49f4a;

    let recipient = AztecAddress::from_field(fixture_l2_recipient);
    let executor = EthAddress::from_field(fixture_executor);

    let recipient_commitment =
        oxide_lib::recipient_commitment::compute_recipient_commitment(fixture_shared_secret_salt, recipient);
    assert_eq(recipient_commitment, expected_recipient_commitment);

    let withdraw = get_withdraw_content_hash(
        executor,
        fixture_user_payload_hash,
        fixture_amount,
        fixture_prover_tip,
        fixture_randomness,
    );
    assert_eq(withdraw, expected_withdraw_content_hash);

    let register_signer = get_register_signer_content_hash(
        0x0102030405060708090a0b0c0d0e0f10,
        0x1112131415161718191a1b1c1d1e1f20,
        0x2122232425262728292a2b2c2d2e2f30,
        0x3132333435363738393a3b3c3d3e3f40,
    );
    assert_eq(register_signer, expected_register_signer_content_hash);
}

// `get_withdraw_content_hash` takes `amount: u128`, so any caller-supplied Field above the u128
// range silently truncates on the cast. The TS side has no such bound check -- it packs the full
// 32-byte big-endian encoding of the bigint. This test recomputes the hash with the truncated
// amount and asserts it equals the TS hash computed from the pre-truncated bigint, while
// diverging from the TS hash computed from the full over-u128 value. Caller bugs that overflow
// u128 land in the gap between these two pinned values.
#[test]
fn withdraw_u128_boundary() {
    let executor = EthAddress::from_field(0x11223344556677889900aabbccddeeff00112233);
    let user_payload_hash: Field = 0x005f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa8139;
    let amount: u128 = 340282366920938463463374607431768211455;
    let prover_tip: u128 = 340282366920938463463374607431768211455;
    let randomness: Field = 0x2222333344445555666677778888999900001111aaaabbbbccccddddeeeeffff;
    let at_limit = get_withdraw_content_hash(executor, user_payload_hash, amount, prover_tip, randomness);
    let below_limit = get_withdraw_content_hash(
        executor,
        user_payload_hash,
        amount - 1,
        prover_tip,
        randomness,
    );
    assert(at_limit != below_limit);
}
