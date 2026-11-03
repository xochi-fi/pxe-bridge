//! In-circuit verification of a WebAuthn assertion made by a P-256 passkey.
//!
//! A WebAuthn authenticator signs `sha256(authenticatorData || sha256(clientDataJSON))` and `clientDataJSON` carries
//! the challenge the relying party supplied, base64url-encoded without padding. The caller gives the message it wants
//! authorized as the challenge, so a valid assertion proves that the passkey holder approved that exact message.
//!
//! The verifier also requires the user-presence and the user-verification flags in `authenticatorData`. The assertion
//! must therefore come from a ceremony that the authenticator gated behind a biometric or a PIN.

use base64::BASE64_URL_ENCODER;
use sha256::sha256_var;

use crate::account_address::PasskeyPublicKey;
use crate::constants::{
    WEBAUTHN_AUTHENTICATOR_DATA_LEN, WEBAUTHN_CHALLENGE_LEN, WEBAUTHN_CHALLENGE_OFFSET, WEBAUTHN_FLAG_USER_PRESENT,
    WEBAUTHN_FLAG_USER_VERIFIED, WEBAUTHN_FLAGS_OFFSET, WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
};

/// The `clientDataJSON` bytes before the challenge, for an authentication ceremony.
global CLIENT_DATA_JSON_PREFIX: [u8; WEBAUTHN_CHALLENGE_OFFSET] =
    "{\"type\":\"webauthn.get\",\"challenge\":\"".as_bytes();

/// The `"` that closes the challenge string.
global CHALLENGE_QUOTE: u8 = 0x22;

pub struct WebAuthnAuth {
    pub authenticator_data: [u8; WEBAUTHN_AUTHENTICATOR_DATA_LEN],
    /// Zero-padded past `client_data_json_len`.
    pub client_data_json: [u8; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN],
    pub client_data_json_len: u32,
    /// P-256 ECDSA signature, `r || s`, 32 big-endian bytes each. `std::ecdsa_secp256r1::verify_signature` accepts
    /// only the canonical low-s form, that is `s <= n / 2` for the curve order `n`. ECDSA signatures are malleable and
    /// an authenticator can emit either form, so the client must replace `s` with `n - s` when `s > n / 2`.
    pub signature: [u8; 64],
}

/// Assert that `auth` is a valid WebAuthn assertion by `passkey` over `challenge`.
pub fn assert_valid_webauthn_signature(passkey: PasskeyPublicKey, challenge: Field, auth: WebAuthnAuth) {
    // Ensure that the `client_data_json` contains the entire challenge value and its closing quote, so the challenge
    // being signed cannot be truncated or replaced by a shorter string, which would allow unauthorized messages.
    // The upper bound is checked by `sha256_var`.
    assert(
        auth.client_data_json_len >= WEBAUTHN_CHALLENGE_OFFSET + WEBAUTHN_CHALLENGE_LEN + 1,
        "clientDataJSON is too short",
    );

    // The base offset for the challenge is set based on the authentication ceremony format. Registration ceremonies use
    // `"type":"webauthn.create"`, which is three characters longer, shifting all subsequent fields. By checking that
    // the clientDataJSON starts exactly with the authentication ceremony preamble, we ensure this function is used only
    // for authentications, and not registrations or other flows.
    for i in 0..WEBAUTHN_CHALLENGE_OFFSET {
        assert_eq(
            auth.client_data_json[i],
            CLIENT_DATA_JSON_PREFIX[i],
            "clientDataJSON is not an authentication ceremony",
        );
    }

    // The signature alone proves only that somebody holds the passkey. The user-verification flag proves that the
    // authenticator released the assertion only after a biometric or a PIN check, and the user-presence flag proves
    // that a person completed the ceremony.
    let required_flags = WEBAUTHN_FLAG_USER_PRESENT | WEBAUTHN_FLAG_USER_VERIFIED;
    assert_eq(
        auth.authenticator_data[WEBAUTHN_FLAGS_OFFSET] & required_flags,
        required_flags,
        "WebAuthn assertion lacks user presence or user verification",
    );

    let challenge_bytes: [u8; 32] = challenge.to_be_bytes();
    let challenge_base64: [u8; WEBAUTHN_CHALLENGE_LEN] = BASE64_URL_ENCODER::encode(challenge_bytes);
    for i in 0..WEBAUTHN_CHALLENGE_LEN {
        assert_eq(
            auth.client_data_json[WEBAUTHN_CHALLENGE_OFFSET + i],
            challenge_base64[i],
            "clientDataJSON challenge does not match the expected challenge",
        );
    }

    // Check that the challenge in the clientDataJSON is immediately followed by a closing quote, ensuring nothing is
    // appended to the challenge and preventing attacks using longer or modified values.
    assert_eq(
        auth.client_data_json[WEBAUTHN_CHALLENGE_OFFSET + WEBAUTHN_CHALLENGE_LEN],
        CHALLENGE_QUOTE,
        "clientDataJSON challenge is not terminated",
    );

    let client_data_json_hash: [u8; 32] = sha256_var(auth.client_data_json, auth.client_data_json_len as u64);

    let mut signed_data: [u8; WEBAUTHN_AUTHENTICATOR_DATA_LEN + 32] = [0; WEBAUTHN_AUTHENTICATOR_DATA_LEN + 32];
    for i in 0..WEBAUTHN_AUTHENTICATOR_DATA_LEN {
        signed_data[i] = auth.authenticator_data[i];
    }
    for i in 0..32 {
        signed_data[WEBAUTHN_AUTHENTICATOR_DATA_LEN + i] = client_data_json_hash[i];
    }
    let hashed_data = sha256_var(signed_data, (WEBAUTHN_AUTHENTICATOR_DATA_LEN + 32) as u64);

    assert(
        std::ecdsa_secp256r1::verify_signature(passkey.x, passkey.y, auth.signature, hashed_data),
        "invalid WebAuthn signature",
    );
}

mod tests {
    use crate::account_address::PasskeyPublicKey;
    use crate::constants::{WEBAUTHN_CHALLENGE_OFFSET, WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN};
    use super::{assert_valid_webauthn_signature, WebAuthnAuth};

    // Pinned vector made with the stub P-256 passkey (`@noble/curves`) in `yarn-project/deploy-lib`, see
    // `passkey_test_account/stub_passkey_signer.test.ts`. If this test fails, the TS signer and this verifier disagree on
    // the assertion layout.
    global TEST_PASSKEY: PasskeyPublicKey = PasskeyPublicKey {
        x: [
            0xd8, 0xcd, 0x12, 0xea, 0x5c, 0x67, 0xf2, 0xf8, 0xa0, 0x0c, 0x11, 0x24, 0x89, 0x3e, 0xdc, 0xfa, 0x67, 0x54,
            0xc4, 0xd6, 0xce, 0xde, 0x6b, 0xe1, 0x3b, 0xdf, 0x22, 0x95, 0xc8, 0x10, 0xa9, 0x7f,
        ],
        y: [
            0xa5, 0xa8, 0x9d, 0x2d, 0x2a, 0x36, 0x0c, 0x0c, 0xa9, 0xa4, 0xd6, 0xc7, 0xc9, 0xed, 0x4b, 0x28, 0xd3, 0xe1,
            0x99, 0xd6, 0x62, 0x7f, 0x2e, 0x69, 0x6d, 0x68, 0x9c, 0x31, 0x0a, 0x5b, 0x0f, 0x48,
        ],
    };
    global TEST_CHALLENGE: Field = 0x18380a3a4dec4daa04fe30592fa1f43bce1fb7e07fbcf136954ce1d9ce76cf98;
    global TEST_AUTHENTICATOR_DATA: [u8; 37] = [
        0x06, 0xcc, 0x72, 0xc2, 0xe6, 0x6c, 0xe5, 0x75, 0x4e, 0xa5, 0x79, 0x2b, 0xa3, 0x91, 0x9b, 0x3e, 0x49, 0x35,
        0xe7, 0x01, 0x9a, 0x17, 0x23, 0xe2, 0x5c, 0xab, 0xde, 0x11, 0x34, 0xef, 0xc6, 0xf9, 0x05, 0x00, 0x00, 0x00,
        0x07,
    ];
    // `{"type":"webauthn.get","challenge":"GDgKOk3sTaoE_jBZL6H0O84ft-B_vPE2lUzh2c52z5g","origin":"https://stub.passkey.test","crossOrigin":false}`
    global TEST_CLIENT_DATA_JSON_LEN: u32 = 138;
    global TEST_CLIENT_DATA_JSON: [u8; 138] = [
        0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x77, 0x65, 0x62, 0x61, 0x75, 0x74, 0x68, 0x6e, 0x2e,
        0x67, 0x65, 0x74, 0x22, 0x2c, 0x22, 0x63, 0x68, 0x61, 0x6c, 0x6c, 0x65, 0x6e, 0x67, 0x65, 0x22, 0x3a, 0x22,
        0x47, 0x44, 0x67, 0x4b, 0x4f, 0x6b, 0x33, 0x73, 0x54, 0x61, 0x6f, 0x45, 0x5f, 0x6a, 0x42, 0x5a, 0x4c, 0x36,
        0x48, 0x30, 0x4f, 0x38, 0x34, 0x66, 0x74, 0x2d, 0x42, 0x5f, 0x76, 0x50, 0x45, 0x32, 0x6c, 0x55, 0x7a, 0x68,
        0x32, 0x63, 0x35, 0x32, 0x7a, 0x35, 0x67, 0x22, 0x2c, 0x22, 0x6f, 0x72, 0x69, 0x67, 0x69, 0x6e, 0x22, 0x3a,
        0x22, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f, 0x73, 0x74, 0x75, 0x62, 0x2e, 0x70, 0x61, 0x73, 0x73,
        0x6b, 0x65, 0x79, 0x2e, 0x74, 0x65, 0x73, 0x74, 0x22, 0x2c, 0x22, 0x63, 0x72, 0x6f, 0x73, 0x73, 0x4f, 0x72,
        0x69, 0x67, 0x69, 0x6e, 0x22, 0x3a, 0x66, 0x61, 0x6c, 0x73, 0x65, 0x7d,
    ];
    global TEST_SIGNATURE: [u8; 64] = [
        0xcc, 0x37, 0x3c, 0x50, 0x5a, 0x3e, 0x68, 0x9a, 0x64, 0xd0, 0x54, 0x8f, 0x07, 0x66, 0xe6, 0xf5, 0xf3, 0x68,
        0xd1, 0x57, 0x0f, 0xe0, 0x38, 0x19, 0xd8, 0x18, 0xb9, 0xee, 0xb0, 0x77, 0x53, 0x1a, 0x61, 0xe5, 0x9a, 0x8c,
        0x9c, 0x0c, 0x7e, 0x38, 0xcb, 0xee, 0x29, 0x6f, 0x44, 0xdf, 0x3b, 0xe1, 0x8d, 0xec, 0x79, 0x6c, 0x3c, 0x01,
        0x23, 0xed, 0xc9, 0xd1, 0xee, 0x89, 0x92, 0xf0, 0x03, 0xd9,
    ];

    fn test_auth() -> WebAuthnAuth {
        let mut client_data_json: [u8; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN] = [0; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN];
        for i in 0..TEST_CLIENT_DATA_JSON_LEN {
            client_data_json[i] = TEST_CLIENT_DATA_JSON[i];
        }
        WebAuthnAuth {
            authenticator_data: TEST_AUTHENTICATOR_DATA,
            client_data_json,
            client_data_json_len: TEST_CLIENT_DATA_JSON_LEN,
            signature: TEST_SIGNATURE,
        }
    }

    #[test]
    fn ts_assertion_verifies() {
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE, test_auth());
    }

    #[test(should_fail_with = "clientDataJSON challenge does not match the expected challenge")]
    fn rejects_other_challenge() {
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE + 1, test_auth());
    }

    #[test(should_fail_with = "invalid WebAuthn signature")]
    fn rejects_tampered_signature() {
        let mut auth = test_auth();
        auth.signature[0] = auth.signature[0] ^ 0x01;
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE, auth);
    }

    #[test(should_fail_with = "invalid WebAuthn signature")]
    fn rejects_tampered_authenticator_data() {
        let mut auth = test_auth();
        auth.authenticator_data[36] = 0x08;
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE, auth);
    }

    #[test(should_fail_with = "WebAuthn assertion lacks user presence or user verification")]
    fn rejects_assertion_without_user_verification() {
        let mut auth = test_auth();
        // Pinned flags are 0x05 (user present and user verified). Keep user presence only.
        auth.authenticator_data[32] = 0x01;
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE, auth);
    }

    #[test(should_fail_with = "WebAuthn assertion lacks user presence or user verification")]
    fn rejects_assertion_without_user_presence() {
        let mut auth = test_auth();
        // Keep user verification only.
        auth.authenticator_data[32] = 0x04;
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE, auth);
    }

    #[test(should_fail_with = "invalid WebAuthn signature")]
    fn rejects_other_passkey() {
        let mut other = TEST_PASSKEY;
        other.x[0] = other.x[0] ^ 0x01;
        assert_valid_webauthn_signature(other, TEST_CHALLENGE, test_auth());
    }

    #[test(should_fail_with = "clientDataJSON is not an authentication ceremony")]
    fn rejects_a_registration_ceremony() {
        // A registration ceremony writes `{"type":"webauthn.create","challenge":"`, which is three characters longer,
        // so the challenge and every later field move. The prefix check runs before the signature check, so this
        // vector does not have to carry a valid signature.
        let registration_prefix: [u8; 39] = "{\"type\":\"webauthn.create\",\"challenge\":\"".as_bytes();
        let mut auth = test_auth();
        for i in 0..(TEST_CLIENT_DATA_JSON_LEN - WEBAUTHN_CHALLENGE_OFFSET) {
            auth.client_data_json[39 + i] = TEST_CLIENT_DATA_JSON[WEBAUTHN_CHALLENGE_OFFSET + i];
        }
        for i in 0..39 {
            auth.client_data_json[i] = registration_prefix[i];
        }
        auth.client_data_json_len = TEST_CLIENT_DATA_JSON_LEN + 3;
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE, auth);
    }

    // A second pinned vector from the same stub passkey. Its challenge is 33 bytes: the 32 bytes of `TEST_CHALLENGE`
    // and one more byte whose top two bits are zero. Such a challenge encodes to 44 base64url characters whose first
    // 43 equal the encoding of `TEST_CHALLENGE`, so only the closing quote separates it from the pinned vector.
    // `{"type":"webauthn.get","challenge":"GDgKOk3sTaoE_jBZL6H0O84ft-B_vPE2lUzh2c52z5gq","origin":"https://stub.passkey.test","crossOrigin":false}`
    global LONG_CHALLENGE_CLIENT_DATA_JSON_LEN: u32 = 139;
    global LONG_CHALLENGE_CLIENT_DATA_JSON: [u8; 139] = [
        0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x77, 0x65, 0x62, 0x61, 0x75, 0x74, 0x68, 0x6e, 0x2e,
        0x67, 0x65, 0x74, 0x22, 0x2c, 0x22, 0x63, 0x68, 0x61, 0x6c, 0x6c, 0x65, 0x6e, 0x67, 0x65, 0x22, 0x3a, 0x22,
        0x47, 0x44, 0x67, 0x4b, 0x4f, 0x6b, 0x33, 0x73, 0x54, 0x61, 0x6f, 0x45, 0x5f, 0x6a, 0x42, 0x5a, 0x4c, 0x36,
        0x48, 0x30, 0x4f, 0x38, 0x34, 0x66, 0x74, 0x2d, 0x42, 0x5f, 0x76, 0x50, 0x45, 0x32, 0x6c, 0x55, 0x7a, 0x68,
        0x32, 0x63, 0x35, 0x32, 0x7a, 0x35, 0x67, 0x71, 0x22, 0x2c, 0x22, 0x6f, 0x72, 0x69, 0x67, 0x69, 0x6e, 0x22,
        0x3a, 0x22, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f, 0x73, 0x74, 0x75, 0x62, 0x2e, 0x70, 0x61, 0x73,
        0x73, 0x6b, 0x65, 0x79, 0x2e, 0x74, 0x65, 0x73, 0x74, 0x22, 0x2c, 0x22, 0x63, 0x72, 0x6f, 0x73, 0x73, 0x4f,
        0x72, 0x69, 0x67, 0x69, 0x6e, 0x22, 0x3a, 0x66, 0x61, 0x6c, 0x73, 0x65, 0x7d,
    ];
    global LONG_CHALLENGE_SIGNATURE: [u8; 64] = [
        0xab, 0x5d, 0x20, 0xb0, 0x5b, 0xe4, 0x6d, 0x82, 0x70, 0x8b, 0x33, 0xde, 0x42, 0x16, 0x6b, 0x07, 0xed, 0xfa,
        0x47, 0x2c, 0x53, 0xa1, 0xe5, 0x2b, 0x49, 0x58, 0x8a, 0xf8, 0xf2, 0xd8, 0x5b, 0xa1, 0x02, 0x56, 0x2a, 0xb7,
        0x29, 0x77, 0x2d, 0xf5, 0xe5, 0xd1, 0x5a, 0x26, 0xb8, 0xcc, 0xe7, 0xf2, 0x15, 0x99, 0x93, 0x1e, 0x29, 0xd7,
        0xd2, 0x12, 0x01, 0x82, 0xf5, 0x73, 0x95, 0x9f, 0x2f, 0x3f,
    ];

    // `TEST_SIGNATURE` with `s` replaced by `n - s`, the other valid form of the same ECDSA signature. WebCrypto and
    // `@noble/curves` (with `lowS: false`) accept it over the same message and passkey.
    global HIGH_S_SIGNATURE: [u8; 64] = [
        0xcc, 0x37, 0x3c, 0x50, 0x5a, 0x3e, 0x68, 0x9a, 0x64, 0xd0, 0x54, 0x8f, 0x07, 0x66, 0xe6, 0xf5, 0xf3, 0x68,
        0xd1, 0x57, 0x0f, 0xe0, 0x38, 0x19, 0xd8, 0x18, 0xb9, 0xee, 0xb0, 0x77, 0x53, 0x1a, 0x9e, 0x1a, 0x65, 0x72,
        0x63, 0xf3, 0x81, 0xc8, 0x34, 0x11, 0xd6, 0x90, 0xbb, 0x20, 0xc4, 0x1e, 0x2e, 0xfa, 0x81, 0x41, 0x6b, 0x16,
        0x7a, 0x97, 0x29, 0xe7, 0xdc, 0x39, 0x69, 0x73, 0x21, 0x78,
    ];

    #[test(should_fail_with = "invalid WebAuthn signature")]
    fn rejects_the_high_s_form_of_a_valid_signature() {
        // This pins the canonical-form requirement of `std::ecdsa_secp256r1::verify_signature`.
        let mut auth = test_auth();
        auth.signature = HIGH_S_SIGNATURE;
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE, auth);
    }

    #[test(should_fail_with = "clientDataJSON challenge is not terminated")]
    fn rejects_an_unterminated_challenge() {
        // Every other check passes: the preamble, the flags, the first 43 challenge characters and the signature. Only
        // the closing quote separates this assertion from an assertion over `TEST_CHALLENGE`, so the test isolates
        // that check.
        let mut client_data_json: [u8; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN] = [0; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN];
        for i in 0..LONG_CHALLENGE_CLIENT_DATA_JSON_LEN {
            client_data_json[i] = LONG_CHALLENGE_CLIENT_DATA_JSON[i];
        }
        let auth = WebAuthnAuth {
            authenticator_data: TEST_AUTHENTICATOR_DATA,
            client_data_json,
            client_data_json_len: LONG_CHALLENGE_CLIENT_DATA_JSON_LEN,
            signature: LONG_CHALLENGE_SIGNATURE,
        };
        assert_valid_webauthn_signature(TEST_PASSKEY, TEST_CHALLENGE, auth);
    }
}
