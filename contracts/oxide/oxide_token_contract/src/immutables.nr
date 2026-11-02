//! The token's immutables.
//!
//! The token's address commits to a hash of the immutables, not to the values. The values are stored in a capsule, and
//! each read constrains them against the hash in the token's instance.

use aztec::{
    oracle::{capsules, get_contract_instance::get_contract_instance},
    protocol::{
        address::{AztecAddress, EthAddress},
        hash::{poseidon2_hash_with_separator, sha256_to_field},
        traits::{Deserialize, Serialize},
    },
};
use compressed_string::FieldCompressedString;
use oxide_lib::constants::DOM_SEP__TOKEN_IMMUTABLES;

global OXIDE_TOKEN_IMMUTABLES_CAPSULE_SLOT: Field = sha256_to_field("OXIDE_TOKEN::IMMUTABLES".as_bytes());

#[derive(Deserialize, Eq, Serialize)]
pub struct OxideTokenImmutables {
    /// The L1 portal this token is bound to.
    pub(crate) portal: EthAddress,
    /// The L1 TEE registry whose registrations this token trusts.
    pub(crate) tee_registry: EthAddress,
    pub(crate) name: FieldCompressedString,
    pub(crate) symbol: FieldCompressedString,
    pub(crate) decimals: u8,
    /// The largest amount one note can hold.
    ///
    /// It must equal the portal's per-tx cap.
    pub(crate) max_note_amount: u128,
}

impl OxideTokenImmutables {
    pub(crate) fn hash(self) -> Field {
        poseidon2_hash_with_separator(self.serialize(), DOM_SEP__TOKEN_IMMUTABLES)
    }
}

/// Returns this token's immutables and checks them against its address.
pub(crate) fn get_immutables(contract_address: AztecAddress) -> OxideTokenImmutables {
    // Safety: `assert_committed` checks the values against the address preimage.
    let immutables = unsafe { load_immutables(contract_address) };
    assert_committed(contract_address, immutables);
    immutables
}

/// Stores `immutables` after it checks them against the address.
pub(crate) unconstrained fn store_immutables(contract_address: AztecAddress, immutables: OxideTokenImmutables) {
    assert_committed(contract_address, immutables);
    capsules::store(
        contract_address,
        OXIDE_TOKEN_IMMUTABLES_CAPSULE_SLOT,
        immutables,
        AztecAddress::zero(),
    );
}

unconstrained fn load_immutables(contract_address: AztecAddress) -> OxideTokenImmutables {
    capsules::load(
        contract_address,
        OXIDE_TOKEN_IMMUTABLES_CAPSULE_SLOT,
        AztecAddress::zero(),
    )
        .unwrap_or_else(|| panic(
            f"Immutables of token {contract_address} are not stored. Call `store_immutables` first",
        ))
}

fn assert_committed(contract_address: AztecAddress, immutables: OxideTokenImmutables) {
    let instance = get_contract_instance(contract_address);
    assert_eq(instance.immutables_hash, immutables.hash(), "Token immutables do not match the token address");
}

mod test {
    use crate::test::MAX_NOTE_AMOUNT;
    use super::{get_immutables, OXIDE_TOKEN_IMMUTABLES_CAPSULE_SLOT, OxideTokenImmutables, store_immutables};
    use aztec::{
        oracle::capsules,
        protocol::address::{AztecAddress, EthAddress},
        test::helpers::test_environment::{DeployOptions, TestEnvironment},
    };
    use compressed_string::FieldCompressedString;

    #[test]
    unconstrained fn get_immutables_returns_the_stored_immutables() {
        let mut env = TestEnvironment::new();
        let immutables = default_immutables();
        let token = deploy(&mut env, immutables);
        env.utility_context_at(token, |_| {
            store_immutables(token, immutables);
            assert_eq(get_immutables(token), immutables);
        });
    }

    #[test(should_fail_with = "Token immutables do not match the token address")]
    unconstrained fn store_immutables_rejects_values_the_address_does_not_commit_to() {
        let mut env = TestEnvironment::new();
        let token = deploy(&mut env, default_immutables());
        let mut other = default_immutables();
        other.portal = EthAddress::from_field(1);
        env.utility_context_at(token, |_| store_immutables(token, other));
    }

    #[test(should_fail_with = "Token immutables do not match the token address")]
    unconstrained fn get_immutables_rejects_stored_values_the_address_does_not_commit_to() {
        let mut env = TestEnvironment::new();
        let token = deploy(&mut env, default_immutables());
        let mut other = default_immutables();
        other.portal = EthAddress::from_field(1);
        env.utility_context_at(token, |_| {
            capsules::store(
                token,
                OXIDE_TOKEN_IMMUTABLES_CAPSULE_SLOT,
                other,
                AztecAddress::zero(),
            );
            let _ = get_immutables(token);
        });
    }

    unconstrained fn default_immutables() -> OxideTokenImmutables {
        OxideTokenImmutables {
            portal: EthAddress::zero(),
            tee_registry: EthAddress::zero(),
            name: FieldCompressedString::from_string("OxideToken                     "),
            symbol: FieldCompressedString::from_string("ATKN                           "),
            decimals: 18,
            max_note_amount: MAX_NOTE_AMOUNT,
        }
    }

    unconstrained fn deploy(env: &mut TestEnvironment, immutables: OxideTokenImmutables) -> AztecAddress {
        // No keys, like a real token.
        env
            .deploy_opts(DeployOptions::new().with_immutables_hash(immutables.hash()).with_secret(0), "OxideToken")
            .without_initializer()
    }
}
