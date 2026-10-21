/**
 * The xochi-fi/xochi#633 recipient class pin: stock @aztec/accounts 5.2.0
 * `SchnorrAccount`. A deliberate re-pin changes these constants and the plan
 * together; any other difference is drift and fails the spike.
 */
export const AZTEC_VERSION = "5.2.0";
export const ARTIFACT_NAME = "SchnorrAccount";
export const ARTIFACT_NOIR_VERSION = "1.0.0-beta.25+75061fab15986eedee4e7d9104ff87dd9fa4ca10";
export const ARTIFACT_SHA256 = "d6f896b457fb519a8228f51e70f4a441f3450908cc9eca96aabdd348197474aa";
export const PINNED_CLASS_ID = "0x0833459dfb3c430326e50f2367ec093e07b4ed37d23e85cc759ef4f9aa800edd";
export const PINNED_ARTIFACT_HASH =
  "0x153f4c0cf8c78f5d943aaa307706a90128eee86af5242b1eda55aeca7372591a";
/** The sibling class in the same entry point. The pin must refuse it. */
export const INITIALIZERLESS_CLASS_ID =
  "0x1c59d7500b7d8ba4bb13ace9e7c07e9576a11a5966624ced14f8efd117b9d5b2";

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
