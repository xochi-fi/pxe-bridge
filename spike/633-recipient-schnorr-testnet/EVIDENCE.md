# Recipient Schnorr class on the Aztec public testnet (xochi-fi/xochi#633)

Re-run of the xochi-fi/pxe-bridge#51 recipient-class spike (tag
`evidence/633-recipient-schnorr-5.2.0`, `642a80f`) against the public
testnet, properties (a)-(d) only. Not for merge; nothing under `src/` changes.
This directory has its own `package.json`, so the bridge's `@aztec/*` 5.2.0
runtime is untouched and no script imports `../../src`.

## Network and SDK

| | |
|---|---|
| node | `https://aztec-testnet.drpc.org` (the RPC listed at docs.aztec.network/networks) |
| `node_getNodeVersion` | `6.0.0` (not 6.0.0-rc.3, which the request assumed) |
| L1 chain id / rollup version | `11155111` / `679261766` (rollup `0x1f435a7f…efba`) |
| SDK | `@aztec-labs/*` `6.0.0`, the version the node reports. v6 moved npm to the `@aztec-labs` scope (`@aztec/*` stops at 5.x) |
| fee payment | the documented SponsoredFPC `0x2d8fff82…69d3`; the 6.0.0 SDK derives that address, and its on-chain class `0x23339131…3335` matches the 6.0.0 artifact |

## Pinned values (SDK 6.0.0, asserted in `expected.ts`)

| | |
|---|---|
| class | `@aztec-labs/accounts/schnorr` `SchnorrAccount` (NOT `SchnorrInitializerlessAccount`, `0x222287bf…659b`) |
| class id | `0x2f7d07db78643da21eefb63ee07d28d1cc23dd86ec9b3a9fa29323bf17269d15` |
| artifactHash | `0x0b0ac14534e632fe31df7b90d8dc8c2a7a0d815bb6768d9e72b1c23a9c3b646d` |
| sha256 `artifacts/SchnorrAccount.json` | `f701e393d933a3229ada1e121113a540c9906d0cc9b1cd4450252888b29ab9f9` |
| artifact `noir_version` | `1.0.0-rc.3+5a7ee9bf5ed8973076df7bb0d2b723024db09ae7` |

The class differs from every other pin. Each network needs its own:

| SDK | SchnorrAccount class id | artifact sha256 |
|---|---|---|
| 5.2.0 (`evidence/633-recipient-schnorr-5.2.0`) | `0x0833459d…0edd` | `d6f896b4…74aa` |
| 6.0.0-rc.3 (`rc3/class-id.ts`, offline only) | `0x2a5784fa8315d0150f36a1fba87b41cdb9cd8ebea611ceaa80c7a787e83efa60` | `9aebda2a…cdc8` |
| 6.0.0 (this run, live testnet) | `0x2f7d07db…9d15` | `f701e393…b9f9` |

The function surface is the same in all three. The `noir_version` of the rc.3
artifact also matches 6.0.0's. The class id still differs.

## Results (2026-10-24)

The live run (`run.sh`, 77 PASS / 0 FAIL, 2165 s, state kept outside the repo) used the harness as committed here, except for three review fixes made afterwards:
- `class-identity.ts` generates its secret and signing keys at runtime instead of using fixed values;
- `testnet-node.ts` also queries the rc.3 class id and the publication block of each class record;
- `check-descriptor.ts` asserts that publication block.

Those fixes were re-run read-only, with no new deploy, all PASS: `class-identity.ts`, `rc3/class-id.ts`, `testnet-node.ts`, and `check-descriptor.ts` against the live run's public state. The block numbers below come from those re-runs.

**(a) Class identity.** `class-identity.ts` computes the class id, artifactHash and file sha256 from the shipped 6.0.0 artifact and holds them to `expected.ts`. The 6.0.0 id is asserted not equal to the 5.2.0 pin.

Before the live run, the node had no record for `0x2f7d07db…` or for the 5.2.0 pin: the live `testnet-node.ts` returned null for both. Private-only accounts never need their class published, so the deploy below published it (`skipClassPublication: false`).

In the read-only re-run, `testnet-node.ts` shows the node dates the 6.0.0 record to `l2BlockNumber` 2985, and has no record for the 5.2.0 or rc.3 ids. `check-descriptor.ts` asserts that 2985 is this run's deploy block.

`check-descriptor.ts` also recomputes the class id from the node's record and gets the pin: the node's artifactHash and privateFunctionsRoot, plus the commitment recomputed from the served bytecode (`0x0ce4c618…f33e`). This shows the network's record matches the pin and was published by this run.

**(b) The key is in the address.** The constructor takes `(signing_pub_key_x, signing_pub_key_y)`, so the key goes into initializationHash and from there into the address. Offline, one runtime-random secret and a fixed public salt with two runtime-random signing keys give two different addresses. For each key, three paths agree: the SDK, a manual derivation from the descriptor (`derive.ts`) and the stdlib instance.

On the testnet account, the address re-derived from the published descriptor equals the claimed address. The node's instance has exactly the descriptor's initializationHash, salt, deployer (zero), immutablesHash (zero) and publicKeys. With the two key coordinates swapped, the address changes to `0x11f62f58…3bca`, and no instance exists there.

**(c) No key-rotation function.** The ABI surface is the same as 5.2.0:
- private: `constructor` (initializer), `entrypoint`, `verify_private_authwit`
- utility: `lookup_validity`, `offchain_receive`, `sync_state`
- public: `public_dispatch`

Storage is `signing_public_key` only, of type `SinglePrivateImmutable`. Its only accesses are `constructor: initialize`, `is_valid_impl: get_note` and `lookup_validity: view_note`, with 4 mentions in `main.nr`.

This covers the CLASS only. `ContractInstanceRegistry.update` still lets an account schedule its own class change. `check-descriptor.ts` reads the update slot for the account (`0x1df9452f…a8b9`) at the latest block: all zero, so no update was scheduled or applied. That is one point in time; a verifier must re-check at every use (xochi-fi/xochi#671).

**(d) Live deploy and finality.** The recipient ran its own EmbeddedWallet and PXE with client-side proving on (`proverEnabled=true`). It deployed throwaway account `0x1bf2d48c76d8f607bc8f74e7228c292cd652b3883966287cdb3892535e3bedc3` through the SponsoredFPC, taking 22 s including client proving:

- tx `0x073a8810e461d4f6811c294706f301a601b8f5f8676c458025d24b992bb15943`: status `proposed`, block 2985, `executionResult: success`, fee `759000121440000000`.
- `check-descriptor.ts`: the node's instance has `currentContractClassId == originalContractClassId == 0x2f7d07db…9d15`.
- `finality.ts` polled with no L1 mining. The receipt went checkpointed (+46 s), then proven (+1056 s, proven tip 2995), then `finalized` (+2065 s, finalized tip 2995 ≥ 2985).
- The siloed private initialization nullifier `0x1193f2f9e1f0580b40173be24b52f80e38af89ce1e0b9a3d286b2dcfb4348e70` was recomputed from (address, initializationHash). It appears in the tx's effects (5 nullifiers). It is a member of the nullifier tree at finalized block 2995 and at block 2985 (leaf index 33156), and absent at block 2984.
- The public initialization nullifier is not emitted, which is expected for a class whose only public function is `public_dispatch`.

**Descriptor gate.** All four forged descriptors are refused before any derivation or node call, each for its own reason: initializerless class id, nonzero immutablesHash, artifactHash+1 and initializationHash+1.

## Blockers hit, and what cleared them

- **The documented RPC rejects SDK batching.** drpc.org's free plan refuses a JSON-RPC batch of more than 3 calls (`"Batch of more than 3 requests are not allowed on free plan"`, HTTP 500). The SDK client batches up to 100 calls, so the first deploy attempt failed in the PXE's `prefetchUpdatedClassIdHints` before sending anything. `common.ts` now sets `maxBatchSize: 3` on every node client and on the wallet's (`SPIKE_RPC_MAX_BATCH` overrides it). This is a transport setting only. A paid drpc key or a self-run node would not need it.
- **No funding needed.** The testnet SponsoredFPC paid the fee: no faucet, no credentials, no fee juice bridged.

## Scope not re-run from #51

#51 also ran a sender/token payment, a receive and spend, and the Schnorr signature verifier table (pure-JS, bb.js and workerd). None of these is needed for (a)-(d), and none was run here.

## Run

```bash
(cd spike/633-recipient-schnorr-testnet && npm ci)
(cd spike/633-recipient-schnorr-testnet/rc3 && npm ci)
spike/633-recipient-schnorr-testnet/run.sh   # AZTEC_NODE_URL, SPIKE_STATE_DIR, FINALITY_SECONDS (default 5400)
```

Each run generates fresh throwaway keys into `SPIKE_STATE_DIR/recipient/secret.json` (mode 0600). The account they control never holds funds.
