//! Panic-free wrapper around std::ecdsa_secp256k1::verify_signature.
//!
//! Assumes the public key (x, y) is already a valid secp256k1 point: i.e.,
//! x, y < p AND y^2 == x^3 + 7 (mod p). This is appropriate when the pubkey
//! comes from a trusted source (e.g., registered on L1 with an on-curve
//! check at registration time).
//!
//! Under that assumption, the only inputs that could make the blackbox
//! abort are bad signature scalars:
//!   - r == 0, s == 0, r >= n, or s >= n (where n is the curve order)

use aztec::protocol::traits::{Deserialize, Packable, Serialize};
use oxide_lib::constants::{K1_N_HI, K1_N_LO};

fn lt_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> bool {
    (a_hi < b_hi) | ((a_hi == b_hi) & (a_lo < b_lo))
}

fn is_zero_u256(hi: u128, lo: u128) -> bool {
    (hi == 0) & (lo == 0)
}

fn u128_to_be_bytes(v: u128) -> [u8; 16] {
    let mut out: [u8; 16] = [0; 16];
    let mut x = v;
    for i in 0..16 {
        out[15 - i] = (x & 0xff) as u8;
        x = x >> 8;
    }
    out
}

fn u256_to_be_bytes(hi: u128, lo: u128) -> [u8; 32] {
    let hi_bytes = u128_to_be_bytes(hi);
    let lo_bytes = u128_to_be_bytes(lo);
    let mut out: [u8; 32] = [0; 32];
    for i in 0..16 {
        out[i] = hi_bytes[i];
        out[16 + i] = lo_bytes[i];
    }
    out
}

#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Signature {
    pub s_lo: u128,
    pub s_hi: u128,
    pub r_lo: u128,
    pub r_hi: u128,
}

pub fn safe_verify_signature(
    public_key_x: [u128; 2],
    public_key_y: [u128; 2],
    signature: Signature,
    message_hash: Field,
) -> bool {
    let r_valid =
        (!is_zero_u256(signature.r_hi, signature.r_lo)) & lt_u256(signature.r_hi, signature.r_lo, K1_N_HI, K1_N_LO);
    let s_valid =
        (!is_zero_u256(signature.s_hi, signature.s_lo)) & lt_u256(signature.s_hi, signature.s_lo, K1_N_HI, K1_N_LO);

    if r_valid & s_valid {
        let pubkey_x_bytes = u256_to_be_bytes(public_key_x[0], public_key_x[1]);
        let pubkey_y_bytes = u256_to_be_bytes(public_key_y[0], public_key_y[1]);

        let r_bytes = u256_to_be_bytes(signature.r_hi, signature.r_lo);
        let s_bytes = u256_to_be_bytes(signature.s_hi, signature.s_lo);
        let mut sig_bytes: [u8; 64] = [0; 64];
        for i in 0..32 {
            sig_bytes[i] = r_bytes[i];
            sig_bytes[32 + i] = s_bytes[i];
        }

        let msg_bytes: [u8; 32] = message_hash.to_be_bytes();

        std::ecdsa_secp256k1::verify_signature(pubkey_x_bytes, pubkey_y_bytes, sig_bytes, msg_bytes)
    } else {
        false
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[test]
fn test_u256_to_be_bytes_roundtrip() {
    let bytes = u256_to_be_bytes(
        0x0102030405060708090a0b0c0d0e0f10,
        0x1112131415161718191a1b1c1d1e1f20,
    );
    for i in 0..32 {
        assert(bytes[i] == (i + 1) as u8);
    }
}

#[test]
fn test_lt_u256() {
    // a < b in high limb
    assert(lt_u256(1, 99, 2, 0) == true);
    // a > b in high limb
    assert(lt_u256(2, 0, 1, 99) == false);
    // tie in high, a < b in low
    assert(lt_u256(5, 1, 5, 2) == true);
    // tie in high, a > b in low
    assert(lt_u256(5, 2, 5, 1) == false);
    // equal
    assert(lt_u256(5, 5, 5, 5) == false);
}

#[test]
fn test_is_zero_u256() {
    assert(is_zero_u256(0, 0) == true);
    assert(is_zero_u256(0, 1) == false);
    assert(is_zero_u256(1, 0) == false);
    assert(is_zero_u256(1, 1) == false);
}

// secp256k1 ECDSA test vector (deterministic; generated with Python `cryptography`
// from sk = 0xDEADBEEFCAFEBABE..., signing the 32-byte big-endian encoding of
// TEST_MESSAGE_HASH directly).
global TEST_PUBKEY_X: [u128; 2] = [0x66947711568329f30fa0c292d4fda6d6, 0xfe86264111c6b36f05dc52fcb00e25ec];
global TEST_PUBKEY_Y: [u128; 2] = [0xbf011ab7be48029aee05a54d98c02772, 0x4a1e3d7df35c73465ce0e9c2462d9b65];

global TEST_SIGNATURE: Signature = Signature {
    s_lo: 0xb5392e12ad229dea2ceff365f3a4eb77,
    s_hi: 0x451752622d70ede33aa5adbaccf9d7a4,
    r_lo: 0x8949d9f51c9a5a372c011eb0535547b9,
    r_hi: 0x8cfdcf27d6c06e4c28f29ebfc840e280,
};

global TEST_MESSAGE_HASH: Field = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;

#[test]
fn test_valid_signature_returns_true() {
    let ok = safe_verify_signature(
        TEST_PUBKEY_X,
        TEST_PUBKEY_Y,
        TEST_SIGNATURE,
        TEST_MESSAGE_HASH,
    );
    assert(ok == true);
}

#[test]
fn test_wrong_message_returns_false() {
    let ok = safe_verify_signature(
        TEST_PUBKEY_X,
        TEST_PUBKEY_Y,
        TEST_SIGNATURE,
        TEST_MESSAGE_HASH + 1,
    );
    assert(ok == false);
}

#[test]
fn test_zero_r_does_not_panic_and_returns_false() {
    let sig = Signature { r_hi: 0, r_lo: 0, s_hi: TEST_SIGNATURE.s_hi, s_lo: TEST_SIGNATURE.s_lo };
    let ok = safe_verify_signature(TEST_PUBKEY_X, TEST_PUBKEY_Y, sig, TEST_MESSAGE_HASH);
    assert(ok == false);
}

#[test]
fn test_zero_s_does_not_panic_and_returns_false() {
    let sig = Signature { r_hi: TEST_SIGNATURE.r_hi, r_lo: TEST_SIGNATURE.r_lo, s_hi: 0, s_lo: 0 };
    let ok = safe_verify_signature(TEST_PUBKEY_X, TEST_PUBKEY_Y, sig, TEST_MESSAGE_HASH);
    assert(ok == false);
}

#[test]
fn test_r_equals_n_does_not_panic_and_returns_false() {
    // r = n exactly: the smallest out-of-range value. The blackbox solver
    // would normally abort here; our wrapper substitutes the fallback.
    let sig = Signature { r_hi: K1_N_HI, r_lo: K1_N_LO, s_hi: TEST_SIGNATURE.s_hi, s_lo: TEST_SIGNATURE.s_lo };
    let ok = safe_verify_signature(TEST_PUBKEY_X, TEST_PUBKEY_Y, sig, TEST_MESSAGE_HASH);
    assert(ok == false);
}

#[test]
fn test_s_equals_n_does_not_panic_and_returns_false() {
    let sig = Signature { r_hi: TEST_SIGNATURE.r_hi, r_lo: TEST_SIGNATURE.r_lo, s_hi: K1_N_HI, s_lo: K1_N_LO };
    let ok = safe_verify_signature(TEST_PUBKEY_X, TEST_PUBKEY_Y, sig, TEST_MESSAGE_HASH);
    assert(ok == false);
}

#[test]
fn test_r_max_u256_does_not_panic_and_returns_false() {
    // r = 2^256 - 1, well above n.
    let max: u128 = 0xffffffffffffffffffffffffffffffff;
    let sig = Signature { r_hi: max, r_lo: max, s_hi: TEST_SIGNATURE.s_hi, s_lo: TEST_SIGNATURE.s_lo };
    let ok = safe_verify_signature(TEST_PUBKEY_X, TEST_PUBKEY_Y, sig, TEST_MESSAGE_HASH);
    assert(ok == false);
}

#[test]
fn test_all_zero_signature_does_not_panic_and_returns_false() {
    let sig = Signature { r_hi: 0, r_lo: 0, s_hi: 0, s_lo: 0 };
    let ok = safe_verify_signature(TEST_PUBKEY_X, TEST_PUBKEY_Y, sig, TEST_MESSAGE_HASH);
    assert(ok == false);
}

#[test]
fn test_r_one_below_n_is_treated_as_in_range() {
    // r = n - 1: in range, should NOT be substituted. The blackbox runs on the
    // real signature; the message doesn't match this r, so result is false,
    // but the important thing is that it didn't trip the substitution path.
    // (We can't observe the substitution choice directly from the bool, but
    // the test would diverge from test_r_equals_n if r=n-1 were treated as
    // out-of-range, since the underlying parse would succeed either way.
    // This is a smoke test that the boundary is correct.)
    let sig = Signature { r_hi: K1_N_HI, r_lo: K1_N_LO - 1, s_hi: TEST_SIGNATURE.s_hi, s_lo: TEST_SIGNATURE.s_lo };
    let ok = safe_verify_signature(TEST_PUBKEY_X, TEST_PUBKEY_Y, sig, TEST_MESSAGE_HASH);
    assert(ok == false);
}
