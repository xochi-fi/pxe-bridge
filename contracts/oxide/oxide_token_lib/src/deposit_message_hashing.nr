use aztec::{
    hash::compute_l1_to_l2_message_hash,
    protocol::{
        address::{AztecAddress, EthAddress},
        constants::DOM_SEP__NHK_M,
        hash::{compute_app_siloed_secret_key, compute_siloed_nullifier, poseidon2_hash_with_separator, sha256_to_field},
        scalar::Scalar,
        traits::FromField,
    },
};

use oxide_lib::constants::DOM_SEP__DEPOSIT_MESSAGE_NULLIFIER;

/// Must match `OxidePortal.sol::deposit`
pub fn get_deposit_message_content_hash(amount: u128) -> Field {
    let selector: [u8; 4] = comptime {
        let h: [u8; 32] = keccak256::keccak256("deposit(uint256)".as_bytes(), 16);
        [h[0], h[1], h[2], h[3]]
    };
    let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();
    let hash_bytes = selector.concat(amount_bytes);
    sha256_to_field(hash_bytes)
}

pub fn compute_deposit_message_hash(
    l1_portal: EthAddress,
    chain_id: Field,
    l2_token: AztecAddress,
    rollup_version: Field,
    shared_secret_salt: Field,
    recipient: AztecAddress,
    amount: u128,
    leaf_index: Field,
) -> Field {
    compute_l1_to_l2_message_hash(
        l1_portal,
        chain_id,
        l2_token,
        rollup_version,
        get_deposit_message_content_hash(amount),
        oxide_lib::recipient_commitment::compute_recipient_commitment(shared_secret_salt, recipient),
        leaf_index,
    )
}

pub fn compute_deposit_message_nullifier(message_hash: Field, nhk_app: Field) -> Field {
    poseidon2_hash_with_separator([message_hash, nhk_app], DOM_SEP__DEPOSIT_MESSAGE_NULLIFIER)
}

// Cross-implementation parity test. The `expected_*` values are written by the TS test at
// `yarn-project/oxide-lib/src/deposit_message_hashing.test.ts` via `updateInlineTestData`. Regenerate after
// touching either implementation:
//   OXIDE_GENERATE_TEST_DATA=1 yarn workspace @oxide/oxide-lib test deposit_message_hashing
#[test]
fn ts_parity() {
    // Fixtures must match deposit_message_hashing.test.ts.
    let fixture_shared_secret_salt: Field = 0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff;
    let fixture_l2_recipient: Field = 0x0ead00000000000000000000000000000000000000000000000000000000bee0;
    let fixture_amount: u128 = 1234567890;
    let fixture_l1_portal: Field = 0x1122334455667788990011223344556677889900;
    let fixture_chain_id: Field = 31337;
    let fixture_l2_token: Field = 0x0abc00000000000000000000000000000000000000000000000000000000cba0;
    let fixture_rollup_version: Field = 42;
    let fixture_leaf_index: Field = 1025;
    // 128-bit limbs of the recipient's master nullifier hiding key (a Grumpkin scalar).
    let fixture_nhk_m_hi: Field = 0x22223333444455556666777788889999;
    let fixture_nhk_m_lo: Field = 0x00001111bbbbccccddddeeeeffff0000;

    // Updated by `OXIDE_GENERATE_TEST_DATA=1 yarn workspace @oxide/oxide-lib test deposit_message_hashing`.
    let expected_deposit_message_content_hash: Field =
        0x009fd9a30be1e999ee89f99ec76efc2f9f2fb16399e29943592aa4b5749ed86f;
    let expected_deposit_message_hash: Field = 0x004ff64030f3a064714344a22bf5a0bd6acb03c969360639faa227371a5d0d13;
    let expected_deposit_message_nullifier: Field = 0x23a8c6f45f5e5245c1872d348426816fdaa80b72c906daf4db7d97d86bc9be30;

    let recipient = AztecAddress::from_field(fixture_l2_recipient);
    let l1_portal = EthAddress::from_field(fixture_l1_portal);
    let l2_token = AztecAddress::from_field(fixture_l2_token);

    let deposit_message_content_hash = get_deposit_message_content_hash(fixture_amount);
    assert_eq(deposit_message_content_hash, expected_deposit_message_content_hash);

    let message_hash = compute_deposit_message_hash(
        l1_portal,
        fixture_chain_id,
        l2_token,
        fixture_rollup_version,
        fixture_shared_secret_salt,
        recipient,
        fixture_amount,
        fixture_leaf_index,
    );
    assert_eq(message_hash, expected_deposit_message_hash);

    // The TS mirror pins the siloed form (what the kernel emits and the refund circuits check), deriving nhk_app
    // from the master key exactly like the refund circuits do.
    let fixture_nhk_m = Scalar { lo: fixture_nhk_m_lo, hi: fixture_nhk_m_hi };
    let nhk_app = compute_app_siloed_secret_key(fixture_nhk_m, l2_token, DOM_SEP__NHK_M as Field);
    let nullifier = compute_deposit_message_nullifier(message_hash, nhk_app);
    let siloed_nullifier = compute_siloed_nullifier(l2_token, nullifier);
    assert_eq(siloed_nullifier, expected_deposit_message_nullifier);
}
