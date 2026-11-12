# Vendored: Oxide client subset

The OXDAI send pipeline (xochi-fi/pxe-bridge#84) uses Oxide's own client code
rather than a reimplementation: the enclave transport and HPKE sealing, the
attestation parser, the TokenOperation collector, the capsule layout and the
token registration. It is copied here, not depended on, because upstream
publishes no package.

| | |
| --- | --- |
| Source | https://github.com/aztec-labs-eng/zkmoney-public, `vendor/oxide/yarn-project/` |
| Commit | `8fd198412a956f214639b5782d3a86e3d47ca60e` (2026-10-27) |
| Oxide subset | `3b5e1f7c8f18e24f74d463911b319aac101f0aee` (`EXPORT-MANIFEST.json` `oxidePin`) |
| Deployment it serves | Oxide v6 mainnet, manifest `gitSha` `dab3d38be1719346b717a025fa608b65c859f760` (pinned in `../pins.ts`; re-pinned from `3d8e29dc359023012a91d75538ed757dc9add937` on 2026-11-12: none of the vendored files changed upstream between `8fd1984` and `8f26cec`, and PCR0 is unchanged) |
| License | MIT, Copyright (c) 2026 Aztec Labs: `LICENSE` and `NOTICE` here are upstream's, byte for byte. None of these files carries an SPDX header, so the repository's MIT license applies to all of them (upstream `NOTICE`). No Solidity (Apache-2.0) is vendored. |

## What was changed

Applied to every file, mechanically:

- import specifiers `@oxide/<pkg>/<path>.js` rewritten to the relative path of
  the vendored copy (`<pkg>/src/` is flattened to `<pkg>/`);
- `'zod'` rewritten to `'zod4'`, an npm alias of `zod@4.4.3`: upstream is on zod
  4, this repository on zod 3.

Three files were edited beyond that; each carries a header comment saying so,
and the table below marks them. Everything else is byte-for-byte upstream after
the two rewrites. Upstream's `submit()` (`l2_operations.ts`) is not vendored:
`../backend.ts` reimplements its transfer-only path, split so the proven
transaction is journaled before it is sent.

`tsconfig.json` here compiles the subset under upstream's own compiler options
(`tsconfig.base.json` at that commit) as a project reference, so the files need
no edits for this repository's stricter flags. Build with `tsc -b` (the
`build` and `typecheck` scripts do).

## Noir sources and the OxideToken artifact

The sender registers the OxideToken contract, so it needs its compiled
artifact (~4 MB). The artifact is not committed; its sources are.
`../../../contracts/oxide/` holds `noir-projects/{oxide_token_contract,
oxide_token_lib, oxide_lib}` from the same upstream commit, byte for byte
(`Nargo.toml` and `src/` of each; the relative `path` dependencies between
them are unchanged), with upstream's `LICENSE` and `NOTICE`.

`npm run build:oxide-token` (`scripts/build-oxide-token.sh`) compiles it the
way upstream's `noir-projects/bootstrap.sh` does, with the toolchain upstream
pins in `vendor/oxide/aztec-toolchain.sh`:

- aztec-up `6.0.0` (`aztec --version` is asserted; nargo
  `1.0.0-rc.3+5a7ee9bf`), `NARGO`/`BB`/`BB_BINARY_PATH` unset;
- `aztec compile --silence-warnings --inliner-aggressiveness 0 --package oxide_token_contract`,
  with `HARDWARE_CONCURRENCY=1` (the CI `contract` job's reason);
- git dependencies by tag: aztec-node `v6.0.0`, noir-lang keccak256 `v0.1.3`,
  sha256 `v0.2.1`, noir_base64 `v0.5.1`.

It writes `contracts/oxide/oxide_token_contract/target/oxide_token_contract-OxideToken.json`
and then runs `npm run check:oxide-token`, which is the sender's own load gate
(`loadOxideTokenArtifact`): it refuses the artifact unless its class is the
deployed OXDAI class `0x27df40f9...3f949`. The class ID covers the private
functions' verification keys, the public bytecode and the artifact hash, and
the artifact hash leaves out `file_map`, so the absolute build paths the
artifact records do not move it: a native arm64 build under two different
checkout paths (2026-11-03) gave exactly the deployed class. A tag that moved,
another toolchain or other flags fail the check. CI builds and checks it in the
`contract` job and hands it to the `docker` job; the image's builder stage runs
the check again on whatever artifact the build context carries.

## Not vendored

- `@oxide/l1-contracts` (generated ABIs and viem wrappers): the three view
  calls the sender needs are declared in `../enclave.ts`.

## Files

| Here | Upstream | Status |
| --- | --- | --- |
| `oxide-client/archive_ref.ts` | `vendor/oxide/yarn-project/oxide-client/src/archive_ref.ts` | unmodified |
| `oxide-client/capsules.ts` | `vendor/oxide/yarn-project/oxide-client/src/capsules.ts` | unmodified |
| `oxide-client/chain_data_source.ts` | `vendor/oxide/yarn-project/oxide-client/src/chain_data_source.ts` | unmodified |
| `oxide-client/enclave_transport.ts` | `vendor/oxide/yarn-project/oxide-client/src/enclave_transport.ts` | unmodified |
| `oxide-client/errors.ts` | `vendor/oxide/yarn-project/oxide-client/src/errors.ts` | unmodified |
| `oxide-client/fleet_signer.ts` | `vendor/oxide/yarn-project/oxide-client/src/fleet_signer.ts` | **modified**: L1 reads through an injected `FleetRegistry` (no `@oxide/l1-contracts`); pinned portal domain; `verifyAndPin` calls `registry.verifyAttestation` (PCR0 + Nitro chain) before trusting any key; `TEEKeys` declared locally |
| `oxide-client/node_read_memo.ts` | `vendor/oxide/yarn-project/oxide-client/src/node_read_memo.ts` | unmodified |
| `oxide-client/pinned_enclave.ts` | `vendor/oxide/yarn-project/oxide-client/src/pinned_enclave.ts` | unmodified |
| `oxide-client/produce_tx_effects_hints.ts` | `vendor/oxide/yarn-project/oxide-client/src/produce_tx_effects_hints.ts` | unmodified |
| `oxide-client/signer_registration.ts` | `vendor/oxide/yarn-project/oxide-client/src/signer_registration.ts` | unmodified |
| `oxide-client/spend_metadata.ts` | `vendor/oxide/yarn-project/oxide-client/src/spend_metadata.ts` | unmodified |
| `oxide-client/token_operations_collector.ts` | `vendor/oxide/yarn-project/oxide-client/src/token_operations_collector.ts` | unmodified |
| `oxide-client/token_registration.ts` | `vendor/oxide/yarn-project/oxide-client/src/token_registration.ts` | **modified**: `readOxideTokenImmutables` removed (it derives name/symbol from the underlying ERC-20, so it never gives the deployed token); its `OxidePortalContract` and `viem` imports removed |
| `oxide-client/types.ts` | `vendor/oxide/yarn-project/oxide-client/src/types.ts` | **modified**: `L1SubmitContext` and its `@oxide/l1-contracts` / `ChainDataSource` / `AztecAddress` imports removed |
| `oxide-lib/attestation/attestation_data.ts` | `vendor/oxide/yarn-project/oxide-lib/src/attestation/attestation_data.ts` | unmodified |
| `oxide-lib/attestation/nitro_attestation/parsers.ts` | `vendor/oxide/yarn-project/oxide-lib/src/attestation/nitro_attestation/parsers.ts` | unmodified |
| `oxide-lib/attestation/nitro_attestation/verify_nitro_attestation.ts` | `vendor/oxide/yarn-project/oxide-lib/src/attestation/nitro_attestation/verify_nitro_attestation.ts` | unmodified |
| `oxide-lib/attestation/pcr0.ts` | `vendor/oxide/yarn-project/oxide-lib/src/attestation/pcr0.ts` | unmodified |
| `oxide-lib/attestation/user_data.ts` | `vendor/oxide/yarn-project/oxide-lib/src/attestation/user_data.ts` | unmodified |
| `oxide-lib/attestation/verify_tee_attestation.ts` | `vendor/oxide/yarn-project/oxide-lib/src/attestation/verify_tee_attestation.ts` | unmodified |
| `oxide-lib/codec.ts` | `vendor/oxide/yarn-project/oxide-lib/src/codec.ts` | unmodified |
| `oxide-lib/content_hash.ts` | `vendor/oxide/yarn-project/oxide-lib/src/content_hash.ts` | unmodified |
| `oxide-lib/da_extractors.ts` | `vendor/oxide/yarn-project/oxide-lib/src/da_extractors.ts` | unmodified |
| `oxide-lib/encryption.ts` | `vendor/oxide/yarn-project/oxide-lib/src/encryption.ts` | unmodified |
| `oxide-lib/field_bytes.ts` | `vendor/oxide/yarn-project/oxide-lib/src/field_bytes.ts` | unmodified |
| `oxide-lib/framing.ts` | `vendor/oxide/yarn-project/oxide-lib/src/framing.ts` | unmodified |
| `oxide-lib/hash.ts` | `vendor/oxide/yarn-project/oxide-lib/src/hash.ts` | unmodified |
| `oxide-lib/oxide_constants.gen.ts` | `vendor/oxide/yarn-project/oxide-lib/src/oxide_constants.gen.ts` | unmodified |
| `oxide-lib-tee/account_address.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/account_address.ts` | unmodified |
| `oxide-lib-tee/attestation/attestation_data.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/attestation/attestation_data.ts` | unmodified |
| `oxide-lib-tee/attestation/user_data.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/attestation/user_data.ts` | unmodified |
| `oxide-lib-tee/codec.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/codec.ts` | unmodified |
| `oxide-lib-tee/content_hash.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/content_hash.ts` | unmodified |
| `oxide-lib-tee/da_extractors.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/da_extractors.ts` | unmodified |
| `oxide-lib-tee/encryption.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/encryption.ts` | unmodified |
| `oxide-lib-tee/framing.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/framing.ts` | unmodified |
| `oxide-lib-tee/recipient_commitment.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/recipient_commitment.ts` | unmodified; canonical helper used by `npm run fund-oxide` |
| `oxide-lib-tee/grumpkin_schnorr_signature.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/grumpkin_schnorr_signature.ts` | unmodified |
| `oxide-lib-tee/hash.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/hash.ts` | unmodified |
| `oxide-lib-tee/migration_signature.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/migration_signature.ts` | unmodified |
| `oxide-lib-tee/oxide_constants.gen.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/oxide_constants.gen.ts` | unmodified |
| `oxide-lib-tee/tx_effect_hint.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/tx_effect_hint.ts` | unmodified |
| `oxide-lib-tee/types.ts` | `vendor/oxide/yarn-project/oxide-lib-tee/src/types.ts` | unmodified |
| `oxide-lib/token_immutables.ts` | `vendor/oxide/yarn-project/oxide-lib/src/token_immutables.ts` | unmodified |
| `oxide-lib/tx_effect_hint.ts` | `vendor/oxide/yarn-project/oxide-lib/src/tx_effect_hint.ts` | unmodified |
| `oxide-lib/types.ts` | `vendor/oxide/yarn-project/oxide-lib/src/types.ts` | unmodified |
| `oxide-lib/withdrawal_finalization_data.ts` | `vendor/oxide/yarn-project/oxide-lib/src/withdrawal_finalization_data.ts` | unmodified |
| `oxide-lib/withdrawal_recovery_data.ts` | `vendor/oxide/yarn-project/oxide-lib/src/withdrawal_recovery_data.ts` | unmodified |

## Updating

1. Check out the new upstream commit, rerun the copy with the two rewrites over
   the same file list (plus anything new the import closure pulls in), and
   re-apply the three edits. Copy the three Noir packages into
   `contracts/oxide/` unchanged.
2. Update the commit, the Oxide pin and the deployment pins (`../pins.ts`)
   together; a new Oxide deployment is a new pin, reviewed, never absorbed.
   A new OxideToken class is `oxideTokenClassId` there.
3. `npm run build:oxide-token && npm run typecheck && npm test`.
