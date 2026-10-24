/**
 * The xochi-fi/xochi#633 recipient class pin for the Aztec public testnet:
 * stock @aztec-labs/accounts 6.0.0 `SchnorrAccount`, the SDK matching the
 * version the testnet node reports. A deliberate re-pin changes these
 * constants and the plan together; any other difference is drift and fails
 * the spike.
 */
export const AZTEC_VERSION = "6.0.0";
export const ARTIFACT_NAME = "SchnorrAccount";
export const ARTIFACT_NOIR_VERSION = "1.0.0-rc.3+5a7ee9bf5ed8973076df7bb0d2b723024db09ae7";
export const ARTIFACT_SHA256 = "f701e393d933a3229ada1e121113a540c9906d0cc9b1cd4450252888b29ab9f9";
export const PINNED_CLASS_ID = "0x2f7d07db78643da21eefb63ee07d28d1cc23dd86ec9b3a9fa29323bf17269d15";
export const PINNED_ARTIFACT_HASH =
  "0x0b0ac14534e632fe31df7b90d8dc8c2a7a0d815bb6768d9e72b1c23a9c3b646d";
/** The sibling class in the same entry point. The pin must refuse it. */
export const INITIALIZERLESS_CLASS_ID =
  "0x222287bfcd04411264393983dd8d01ca5ea9ae305d1a10a1e6d8deef7f17659b";

/** The 5.2.0 pin (evidence/633-recipient-schnorr-5.2.0). Compared, never accepted. */
export const PIN_5_2_0_CLASS_ID = "0x0833459dfb3c430326e50f2367ec093e07b4ed37d23e85cc759ef4f9aa800edd";
/** The same class under 6.0.0-rc.3 (rc3/class-id.ts). Compared, never accepted. */
export const RC3_CLASS_ID = "0x2a5784fa8315d0150f36a1fba87b41cdb9cd8ebea611ceaa80c7a787e83efa60";

/** The whole callable surface: `type name init?`, in artifact order. */
export const FUNCTION_SURFACE = [
  "private constructor init",
  "private entrypoint",
  "utility lookup_validity",
  "private verify_private_authwit",
  "utility offchain_receive",
  "utility sync_state",
  "public public_dispatch",
];
export const STORAGE_SLOTS = ["signing_public_key"];
export const SIGNING_KEY_STATE_VAR = "SinglePrivateImmutable";
/** Every `signing_public_key.<method>(` in main.nr, as `enclosing fn: method`. */
export const SIGNING_KEY_ACCESSES = [
  "constructor: initialize",
  "is_valid_impl: get_note",
  "lookup_validity: view_note",
];

/**
 * The public testnet as documented at https://docs.aztec.network/networks
 * (read 2026-10-24) and as its node reports itself. testnet-node.ts fails if
 * the node disagrees.
 */
export const TESTNET_NODE_URL = "https://aztec-testnet.drpc.org";
export const TESTNET_NODE_VERSION = "6.0.0";
export const TESTNET_L1_CHAIN_ID = 11155111;
export const TESTNET_ROLLUP_VERSION = 679261766;
export const TESTNET_SPONSORED_FPC = "0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3";
