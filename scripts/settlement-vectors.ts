/**
 * Canonical `pxe-bridge.settlement.v1` request vector, generated here in
 * TypeScript from the bridge's own schema and fingerprint (decision D-C,
 * docs/settlement-operations.md "Frozen encodings").
 *
 * The bridge is the PRODUCER of this vector: the fingerprint is bridge-owned,
 * so the expectation must come from the code that computes it, and a consumer
 * (Riddler's `Settlement.AztecRpc`) vendors the file and checks its request
 * builder against it. Never hand-edit the JSON; regenerate:
 *
 *   npm run generate:settlement-vectors
 *
 * `tests/settlement-vectors.test.ts` fails when the committed file differs
 * from what this builds, so a schema or fingerprint change cannot land
 * without the vector moving in the same commit.
 *
 * Every value is `@xochi/spec` 0.9.0 `conformance/shielded.json`'s
 * `recipientBinding` "baseline" vector (network fixture-a, corridor, Aztec
 * recipient/token, descriptor digest), so the request names the same
 * NetworkIdentity whose digest that file pins. The corridor values are spec
 * fixtures, NOT the rev 1 corridor: those are still open and are deployment
 * configuration (PXE_BRIDGE_SETTLEMENT_CORRIDOR), refused when absent.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import { MAY_BROADCAST_VERSION } from "../src/may-broadcast.js";
import {
  CreateNoteV1Schema,
  SETTLEMENT_VERSION,
  fingerprintTerms,
  termsFrom,
  type NetworkIdentity,
} from "../src/settlement.js";

export const VECTOR_PATH = resolve(import.meta.dirname, "../docs/vectors/settlement-v1.json");

/** §7, byte for byte as `@xochi/spec` `shielded.json` `networkIdentity.typeString`. */
export const NETWORK_IDENTITY_TYPE_STRING =
  "NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address rollupAddress," +
  "uint256 l1ChainId,bytes32 genesisOrNetworkDigest)";

/**
 * `hashStruct(NetworkIdentity)`, the `network_identity_digest` the shielded
 * domain salts fold in. The bridge never needs it at runtime; it is here so
 * the vector can prove the request's `network` object IS the §7 struct, by
 * reproducing the digest `@xochi/spec` pins for the same values.
 */
export function networkIdentityDigest(network: NetworkIdentity): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        keccak256(stringToHex(NETWORK_IDENTITY_TYPE_STRING)),
        BigInt(network.aztecChainId),
        BigInt(network.protocolVersion),
        network.rollupAddress as Hex,
        BigInt(network.l1ChainId),
        network.genesisOrNetworkDigest as Hex,
      ],
    ),
  );
}

/** `@xochi/spec` 0.9.0 shielded.json `networkIdentity.vectors[0]` ("fixture-a"). */
export const SPEC_FIXTURE_A = {
  network: {
    aztecChainId: "11155111",
    protocolVersion: "3924331020",
    rollupAddress: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    l1ChainId: "11155111",
    genesisOrNetworkDigest: "0x9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e",
  },
  networkIdentityDigest: "0xf5046ae3e3c59d817787e4d1b3ae6d178280a4bf1b4dad404d4d31d5ca81e968",
} as const;

const OPERATION_ID = "riddler-shielded-00000000-0000-4000-8000-000000000001";
const TX_HASH = "0x" + "7a".repeat(32);
const NETWORK: NetworkIdentity = { ...SPEC_FIXTURE_A.network };

const PARAMS = {
  version: SETTLEMENT_VERSION,
  operationId: OPERATION_ID,
  network: NETWORK,
  corridor: {
    corridorId: "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    corridorRevision: 1,
    manifestDigest: "0x4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d",
  },
  accountMode: "spending_limit",
  recipient: "0x1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c",
  recipientDescriptorDigest: "0xd5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5",
  token: "0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b",
  amount: "1000000",
  validUntil: 1900000000,
};

/** Uppercase hex everywhere it is accepted: canonicalizes to the same terms. */
function shouted(params: typeof PARAMS): typeof PARAMS {
  const up = (hex: string) => "0x" + hex.slice(2).toUpperCase();
  return {
    ...params,
    network: {
      ...params.network,
      rollupAddress: up(params.network.rollupAddress),
      genesisOrNetworkDigest: up(params.network.genesisOrNetworkDigest),
    },
    corridor: {
      ...params.corridor,
      corridorId: up(params.corridor.corridorId),
      manifestDigest: up(params.corridor.manifestDigest),
    },
    recipient: up(params.recipient),
    recipientDescriptorDigest: up(params.recipientDescriptorDigest),
    token: up(params.token),
  };
}

/** Refused at the schema (-32602), each a single change to the canonical params. */
const REFUSALS: { name: string; params: Record<string, unknown> }[] = [
  { name: "aztecChainId zero", params: { ...PARAMS, network: { ...PARAMS.network, aztecChainId: "0" } } },
  {
    name: "protocolVersion at the BN254 modulus",
    params: {
      ...PARAMS,
      network: {
        ...PARAMS.network,
        protocolVersion: "21888242871839275222246405745257275088548364400416034343698204186575808495617",
      },
    },
  },
  { name: "l1ChainId zero", params: { ...PARAMS, network: { ...PARAMS.network, l1ChainId: "0" } } },
  { name: "l1ChainId as a JSON number", params: { ...PARAMS, network: { ...PARAMS.network, l1ChainId: 11155111 } } },
  {
    name: "rollupAddress zero",
    params: { ...PARAMS, network: { ...PARAMS.network, rollupAddress: "0x" + "00".repeat(20) } },
  },
  {
    name: "genesisOrNetworkDigest zero",
    params: { ...PARAMS, network: { ...PARAMS.network, genesisOrNetworkDigest: "0x" + "00".repeat(32) } },
  },
  { name: "recipient as a 20-byte EVM address", params: { ...PARAMS, recipient: "0x" + "1c".repeat(20) } },
  { name: "amount with a leading zero", params: { ...PARAMS, amount: "01000000" } },
  { name: "amount as a JSON number", params: { ...PARAMS, amount: 1000000 } },
  { name: "an unknown member", params: { ...PARAMS, chainId: 1 } },
];

export function buildSettlementVectors(): Record<string, unknown> {
  const parsed = CreateNoteV1Schema.parse(PARAMS);
  const terms = termsFrom(parsed);
  const fingerprint = fingerprintTerms(terms);
  const shout = shouted(PARAMS);
  if (fingerprintTerms(termsFrom(CreateNoteV1Schema.parse(shout))) !== fingerprint) {
    throw new Error("case changed the fingerprint");
  }
  for (const refusal of REFUSALS) {
    if (CreateNoteV1Schema.safeParse(refusal.params).success) {
      throw new Error(`refusal vector "${refusal.name}" is accepted`);
    }
  }
  if (networkIdentityDigest(SPEC_FIXTURE_A.network) !== SPEC_FIXTURE_A.networkIdentityDigest) {
    throw new Error("NetworkIdentity digest does not reproduce @xochi/spec fixture-a");
  }
  return {
    version: 1,
    generator: "scripts/settlement-vectors.ts (npm run generate:settlement-vectors)",
    contract: SETTLEMENT_VERSION,
    source:
      "docs/settlement-operations.md; values from @xochi/spec 0.9.0 conformance/shielded.json " +
      "recipientBinding \"baseline\" (network fixture-a)",
    networkIdentity: {
      typeString: NETWORK_IDENTITY_TYPE_STRING,
      typehash: keccak256(stringToHex(NETWORK_IDENTITY_TYPE_STRING)),
      note:
        "The request's `network` object is @xochi/spec's NetworkIdentity, member for member; " +
        "its hashStruct reproduces the spec's networkIdentityDigest.",
      networkIdentityDigest: networkIdentityDigest(terms.network),
    },
    createNote: {
      http: {
        method: "POST",
        path: "/",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer <PXE_BRIDGE_API_KEY>",
          "Idempotency-Key": OPERATION_ID,
        },
      },
      body: { jsonrpc: "2.0", id: 1, method: "aztec_createNote", params: [PARAMS] },
      canonicalTerms: terms,
      fingerprint,
      sameFingerprint: [
        { name: "uppercase hex in every hex member", params: shout },
        { name: "another JSON-RPC id", body: { jsonrpc: "2.0", id: "retry-7", method: "aztec_createNote" } },
      ],
      refusals: REFUSALS.map((r) => ({ ...r, error: { code: -32602 } })),
    },
    getSettlement: {
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "aztec_getSettlement",
        params: [{ version: SETTLEMENT_VERSION, operationId: OPERATION_ID }],
      },
    },
    mayBroadcast: {
      request: {
        method: "POST",
        url: "<PXE_BRIDGE_MAY_BROADCAST_URL>",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer <PXE_BRIDGE_MAY_BROADCAST_TOKEN>",
        },
        body: { version: MAY_BROADCAST_VERSION, operationId: OPERATION_ID, fingerprint, txHash: TX_HASH },
      },
      marks: { status: 200, body: { version: MAY_BROADCAST_VERSION, operationId: OPERATION_ID, decision: "allow" } },
      holds: [
        { status: 200, body: { version: MAY_BROADCAST_VERSION, operationId: OPERATION_ID, decision: "deny" } },
        { status: 200, body: { version: MAY_BROADCAST_VERSION, operationId: OPERATION_ID, decision: "unknown" } },
        { status: 200, body: { version: MAY_BROADCAST_VERSION, operationId: "another-operation", decision: "allow" } },
        { status: 202, body: { version: MAY_BROADCAST_VERSION, operationId: OPERATION_ID, decision: "allow" } },
      ],
    },
  };
}

export function renderSettlementVectors(): string {
  return JSON.stringify(buildSettlementVectors(), null, 2) + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(VECTOR_PATH, renderSettlementVectors());
  console.log(`wrote ${VECTOR_PATH}`);
}
