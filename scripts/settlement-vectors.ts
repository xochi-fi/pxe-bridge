/**
 * Canonical `pxe-bridge.settlement.v2` vector, generated here in TypeScript
 * from the bridge's own schema, fingerprint and partial-note derivation
 * (decision D-C, docs/settlement-operations.md "Frozen encodings" and
 * "Partial-note randomness").
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
 * Every request value is `@xochi/spec` 0.9.0 `conformance/shielded.json`'s
 * `recipientBinding` "baseline" vector (network fixture-a, corridor, Aztec
 * recipient/token, descriptor digest), so the request names the same
 * NetworkIdentity whose digest that file pins. The corridor values are spec
 * fixtures, NOT the rev 1 corridor: those are still open and are deployment
 * configuration (PXE_BRIDGE_SETTLEMENT_CORRIDOR), refused when absent.
 *
 * The finalized observation's payout account, randomness, first nullifier and
 * note-hash position are the inputs of Riddler's
 * `test/support/vectors/aztec_payment_proof.json`; its recipient and amount
 * are this request's. Its effects are derived with the 6.0.0 hashes
 * (src/partial-note.ts), so `Shielded.PaymentProof.recipient_paid?/2` holds
 * over them for the request's terms.
 *
 * Every `expirationTimestamp` is the transaction's Aztec protocol expiry
 * (`tx.data.expirationTimestamp`), deliberately NOT `validUntil`: the bridge
 * enforces the two separately, and a consumer that equates them admits
 * nothing (axol-io/Riddler#1428). See `transactionExpiry` in the output.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address";
import { DomainSeparator, MAX_TX_LIFETIME } from "@aztec-labs/constants";
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import { MAY_BROADCAST_VERSION } from "../src/may-broadcast.js";
import {
  NOTE_COMPLETION_LOG_TAG_SEPARATOR,
  PARTIAL_NOTE_COMMITMENT_SEPARATOR,
  TOKEN_BALANCES_SLOT,
  payoutEvidence,
} from "../src/partial-note.js";
import {
  CreateNoteSchema,
  SETTLEMENT_VERSION,
  SETTLEMENT_VERSIONS_RETIRED,
  fingerprintLines,
  fingerprintTerms,
  termsFrom,
  type NetworkIdentity,
  type Observation,
} from "../src/settlement.js";
import { orderFingerprintMeta } from "../src/oxide/backend.js";
import { OXIDE_V6_MAINNET } from "../src/oxide/pins.js";
import {
  locatePayoutNoteHash,
  oxideInnerNoteHash,
  oxideNoteRandomness,
  oxideSiloedNoteHash,
  oxideUniqueNoteHash,
} from "../src/oxide/payout-proof.js";
import { BALANCES_STORAGE_SLOT } from "../src/oxide/vendor/oxide-lib-tee/oxide_constants.gen.js";

export const VECTOR_PATH = resolve(import.meta.dirname, "../docs/vectors/settlement-v2.json");

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

/**
 * The prepared transaction's anchor block timestamp. The spending-limit
 * entrypoint sets no expiry, so the PXE's tail output is the maximum,
 * anchor + MAX_TX_LIFETIME: whole hours past the anchor, the shape
 * `computeTxExpirationTimestamp` (@aztec-labs/pxe 6.0.0) rounds a lowered
 * expiry to as well. Anchored 10,045 s before `validUntil`, mined 45 s later.
 */
export const ANCHOR_BLOCK_TIMESTAMP = 1899989955n;
export const EXPIRATION_TIMESTAMP = (ANCHOR_BLOCK_TIMESTAMP + BigInt(MAX_TX_LIFETIME)).toString();
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
  sendMode: "spending_limit",
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

function withoutKey(params: typeof PARAMS, key: keyof typeof PARAMS): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = params;
  return rest;
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
  { name: "sendMode missing", params: withoutKey(PARAMS, "sendMode") },
  { name: "sendMode unknown", params: { ...PARAMS, sendMode: "transfer_to_private" } },
  { name: "sendMode null", params: { ...PARAMS, sendMode: null } },
  { name: "sendMode oxide with accountMode spending_limit", params: { ...PARAMS, sendMode: "oxide" } },
];

/**
 * Riddler `aztec_payment_proof.json` inputs (generated from the 6.0.0
 * runtime): the account that called `transfer_to_private`, the randomness,
 * the transaction's first nullifier and the note's position.
 */
export const PAYOUT_FIXTURE = {
  payoutAccount: "0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
  partialNoteRandomness: "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e",
  firstNullifier: "0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
  noteHashIndex: 5,
} as const;

/** The request's payout, finalized, with the effects its randomness proves. */
async function finalizedPayout(): Promise<{ observation: Observation; partialNote: Record<string, unknown> }> {
  const evidence = await payoutEvidence({
    token: AztecAddress.fromStringUnsafe(PARAMS.token),
    recipient: AztecAddress.fromStringUnsafe(PARAMS.recipient),
    payoutAccount: AztecAddress.fromStringUnsafe(PAYOUT_FIXTURE.payoutAccount),
    amount: BigInt(PARAMS.amount),
    randomness: Fr.fromString(PAYOUT_FIXTURE.partialNoteRandomness),
  });
  const uniqueNoteHash = (
    await evidence.uniqueNoteHash(Fr.fromString(PAYOUT_FIXTURE.firstNullifier), PAYOUT_FIXTURE.noteHashIndex)
  ).toString();
  // The tx's other note hashes (fee and change notes) are uninterpreted
  // evidence; fixed filler stands in for them. Filler must be BN254 field
  // elements, as every note hash a node reports is: a consumer that parses
  // effects as fields (Riddler's PaymentProof) refuses anything else.
  const noteHashes = Array.from({ length: PAYOUT_FIXTURE.noteHashIndex }, (_, i) =>
    "0x" + (i + 0x11).toString(16).repeat(32),
  );
  noteHashes.push(uniqueNoteHash);
  const observation: Observation = {
    state: "finalized",
    txHash: TX_HASH,
    expirationTimestamp: EXPIRATION_TIMESTAMP,
    executionResult: "success",
    blockHash: "0x" + "b1".repeat(32),
    blockNumber: "4242",
    receiptStatus: "finalized",
    observedAt: 1899990000,
    effects: {
      state: "available",
      noteHashes,
      nullifiers: [PAYOUT_FIXTURE.firstNullifier, evidence.siloedValidityNullifier.toString()],
    },
    partialNoteRandomness: PAYOUT_FIXTURE.partialNoteRandomness,
  };
  return {
    observation,
    partialNote: {
      note:
        "Recompute from the signed recipient, token and amount, the payout account and " +
        "observation.partialNoteRandomness; require uniqueNoteHash(i) in effects.noteHashes for some " +
        "i < 64 and siloedValidityNullifier in effects.nullifiers (effects.nullifiers[0] is the " +
        "nonce's first nullifier). Values are the @aztec-labs 6.0.0 hashes.",
      formula: {
        partialCommitment: "P2([recipient, partialNoteRandomness], DOM_SEP__PARTIAL_NOTE_COMMITMENT)",
        noteHash: "P2([TOKEN_BALANCES_SLOT, partialCommitment, amount], DOM_SEP__NOTE_HASH)",
        siloedNoteHash: "siloNoteHash(token, noteHash)",
        uniqueNoteHash: "computeUniqueNoteHash(computeNoteHashNonce(effects.nullifiers[0], i), siloedNoteHash)",
        siloedValidityNullifier:
          "siloNullifier(token, P2([partialCommitment, payoutAccount], DOM_SEP__PARTIAL_NOTE_VALIDITY_COMMITMENT))",
        completionLogTag: "P2([partialCommitment], DOM_SEP__NOTE_COMPLETION_LOG_TAG)",
      },
      constants: {
        DOM_SEP__PARTIAL_NOTE_COMMITMENT: PARTIAL_NOTE_COMMITMENT_SEPARATOR,
        DOM_SEP__NOTE_HASH: DomainSeparator.NOTE_HASH,
        DOM_SEP__PARTIAL_NOTE_VALIDITY_COMMITMENT: DomainSeparator.PARTIAL_NOTE_VALIDITY_COMMITMENT,
        DOM_SEP__NOTE_COMPLETION_LOG_TAG: NOTE_COMPLETION_LOG_TAG_SEPARATOR,
        TOKEN_BALANCES_SLOT: Number(TOKEN_BALANCES_SLOT),
      },
      inputs: {
        recipient: PARAMS.recipient,
        token: PARAMS.token,
        amount: PARAMS.amount,
        payoutAccount: PAYOUT_FIXTURE.payoutAccount,
        partialNoteRandomness: PAYOUT_FIXTURE.partialNoteRandomness,
        firstNullifier: PAYOUT_FIXTURE.firstNullifier,
        noteHashIndex: PAYOUT_FIXTURE.noteHashIndex,
      },
      partialCommitment: evidence.partialCommitment.toString(),
      noteHash: evidence.noteHash.toString(),
      siloedNoteHash: evidence.siloedNoteHash.toString(),
      uniqueNoteHash,
      siloedValidityNullifier: evidence.siloedValidityNullifier.toString(),
      completionLogTag: evidence.completionLogTag.toString(),
    },
  };
}

/**
 * The Oxide case (sendMode "oxide", pxe-bridge#84 decided 2026-11-03): the
 * same request as the spending_limit case on the standard account, paying the
 * pinned OXDAI token (`OXIDE_V6_MAINNET.bridge.l2Token`), 1 OXDAI.
 */
const OXIDE_PARAMS: typeof PARAMS = {
  ...PARAMS,
  operationId: "riddler-shielded-00000000-0000-4000-8000-000000000002",
  accountMode: "standard",
  sendMode: "oxide",
  token: OXIDE_V6_MAINNET.bridge.l2Token,
  amount: "1000000000000000000",
};

/**
 * `transfer(meta)` length of the OxideToken artifact at the pinned class
 * (`TRANSFER_META_LEN = MAX_EVENT_SERIALIZED_LEN - 3`, 7 in aztec-nr 6.0.0);
 * the sender reads it from the artifact, `tests/oxide-backend.test.ts`
 * checks it against a built one.
 */
export const OXIDE_TRANSFER_META_LEN = 7;

/**
 * Oxide payout-proof inputs. The randomness is the token's own derivation
 * (`randomness.nr`: `P2([seed, index])`) from a fixture seed; the tx's
 * first nullifier is a fixture; the payout note sits at position 1, between
 * two other note hashes (fixed filler: the fee payer's and the change note).
 */
export const OXIDE_PAYOUT_FIXTURE = {
  randomnessSeed: "0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d",
  randomnessIndex: 0,
  firstNullifier: "0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
  payoutNoteHashIndex: 1,
  noteHashCount: 3,
} as const;

async function oxideCase(spendingLimitFinalized: Observation): Promise<Record<string, unknown>> {
  const parsed = CreateNoteSchema.parse(OXIDE_PARAMS);
  const terms = termsFrom(parsed);
  const fingerprint = fingerprintTerms(terms);
  const spendingLimitCounterpart = fingerprintTerms({ ...terms, sendMode: "spending_limit" });
  if (fingerprint === spendingLimitCounterpart) throw new Error("sendMode does not move the fingerprint");
  if (fingerprintTerms(termsFrom(CreateNoteSchema.parse(shouted(OXIDE_PARAMS)))) !== fingerprint) {
    throw new Error("case changed the oxide fingerprint");
  }
  const meta = orderFingerprintMeta(fingerprint, OXIDE_TRANSFER_META_LEN).map((f) => f.toString());

  const randomness = (
    await oxideNoteRandomness(Fr.fromString(OXIDE_PAYOUT_FIXTURE.randomnessSeed), OXIDE_PAYOUT_FIXTURE.randomnessIndex)
  ).toString();
  const siloed = await oxideSiloedNoteHash({
    recipient: terms.recipient,
    token: terms.token,
    amount: BigInt(terms.amount),
    randomness,
  });
  const firstNullifier = Fr.fromString(OXIDE_PAYOUT_FIXTURE.firstNullifier);
  const unique = await oxideUniqueNoteHash(siloed, firstNullifier, OXIDE_PAYOUT_FIXTURE.payoutNoteHashIndex);
  const noteHashes = Array.from({ length: OXIDE_PAYOUT_FIXTURE.noteHashCount }, (_, i) =>
    i === OXIDE_PAYOUT_FIXTURE.payoutNoteHashIndex ? unique.toString() : "0x" + (i + 0x21).toString(16).repeat(32),
  );
  const effects = {
    state: "available" as const,
    noteHashes,
    nullifiers: [OXIDE_PAYOUT_FIXTURE.firstNullifier, "0x" + "2f".repeat(32)],
  };
  const located = await locatePayoutNoteHash(effects, siloed);
  if (located.kind !== "found" || located.index !== OXIDE_PAYOUT_FIXTURE.payoutNoteHashIndex) {
    throw new Error("the bridge does not locate the vector's payout note hash");
  }
  const mined = {
    txHash: "0x" + "7b".repeat(32),
    expirationTimestamp: EXPIRATION_TIMESTAMP,
    executionResult: "success" as const,
    blockHash: "0x" + "b2".repeat(32),
    blockNumber: "4243",
    observedAt: 1899990000,
    effects,
    partialNoteRandomness: randomness,
  };
  const finalized: Observation = {
    state: "finalized",
    ...mined,
    receiptStatus: "finalized",
    payoutNoteHashIndex: OXIDE_PAYOUT_FIXTURE.payoutNoteHashIndex,
  };
  const withAnotherOrder = noteHashes.filter((_, i) => i !== OXIDE_PAYOUT_FIXTURE.payoutNoteHashIndex);
  const absent = await locatePayoutNoteHash({ ...effects, noteHashes: withAnotherOrder }, siloed);
  if (absent.kind !== "unresolved" || absent.reason !== "payout_note_hash_absent") {
    throw new Error("a payout note hash at another position must be absent");
  }
  const payoutNoteCommitment = {
    scheme: "oxide-payout-note-v1" as const,
    partialNoteRandomness: randomness,
    siloedNoteHash: siloed.toString(),
  };
  const prepared: Observation = {
    state: "prepared",
    txHash: mined.txHash,
    expirationTimestamp: mined.expirationTimestamp,
    hold: "may_broadcast_unknown",
    payoutNoteCommitment,
  };
  const reverted: Observation = {
    state: "reverted",
    ...mined,
    executionResult: "reverted",
    receiptStatus: "finalized",
    effects: { ...effects, noteHashes: withAnotherOrder },
    payoutNoteHashIndex: null,
  };
  const { payoutNoteHashIndex: _omit, ...withoutIndex } = finalized as Observation & { payoutNoteHashIndex: number };

  return {
    note:
      "sendMode \"oxide\": the Oxide OXDAI sender. Same wire (pxe-bridge.settlement.v2) and request shape; " +
      "accountMode must be \"standard\". The fingerprint adds the line sendMode=oxide right after " +
      "accountMode=...; a spending_limit request adds no line, so its fingerprint is 0.3.0's.",
    createNote: {
      body: { jsonrpc: "2.0", id: 1, method: "aztec_createNote", params: [OXIDE_PARAMS] },
      canonicalTerms: terms,
      fingerprintLines: fingerprintLines(terms),
      fingerprint,
      spendingLimitCounterpart: {
        note: "The same terms with sendMode spending_limit (no sendMode line): a different fingerprint.",
        fingerprint: spendingLimitCounterpart,
      },
      result: {
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: { version: SETTLEMENT_VERSION, operationId: OXIDE_PARAMS.operationId, fingerprint, observation: finalized },
        },
      },
    },
    orderFingerprint: {
      note:
        "The order fingerprint the transfer carries in its private meta is the request fingerprint. " +
        "meta = [sha256ToField(tag), hi128, lo128, 0...], hi128/lo128 the fingerprint's first/last 16 bytes; " +
        "the length is the OxideToken transfer(meta) length.",
      tag: "pxe-bridge/oxide-order-fingerprint/v1",
      orderFingerprint: fingerprint,
      transferMetaLen: OXIDE_TRANSFER_META_LEN,
      meta,
    },
    payoutProof: {
      note:
        "Before source funds may move, persist preparedObservation.payoutNoteCommitment with the exact " +
        "prepared transaction. Recompute siloedNoteHash from the signed recipient, token and amount and " +
        "the committed partialNoteRandomness. A success requires uniqueNoteHash(payoutNoteHashIndex) == " +
        "effects.noteHashes[payoutNoteHashIndex]. A finalized revert is negative delivery evidence only " +
        "when every independently verified effect omits the committed note.",
      formula: {
        randomness: "P2([seed, index]) (OxideToken randomness.nr next_randomness)",
        noteHash: "P2WithSeparator([amount, recipient, BALANCES_STORAGE_SLOT, randomness], DOM_SEP__NOTE_HASH)",
        siloedNoteHash: "siloNoteHash(token, noteHash)",
        uniqueNoteHash:
          "computeUniqueNoteHash(computeNoteHashNonce(effects.nullifiers[0], payoutNoteHashIndex), siloedNoteHash)",
      },
      constants: { DOM_SEP__NOTE_HASH: DomainSeparator.NOTE_HASH, BALANCES_STORAGE_SLOT },
      inputs: {
        recipient: terms.recipient,
        token: terms.token,
        amount: terms.amount,
        randomnessSeed: OXIDE_PAYOUT_FIXTURE.randomnessSeed,
        randomnessIndex: OXIDE_PAYOUT_FIXTURE.randomnessIndex,
        partialNoteRandomness: randomness,
        firstNullifier: OXIDE_PAYOUT_FIXTURE.firstNullifier,
        payoutNoteHashIndex: OXIDE_PAYOUT_FIXTURE.payoutNoteHashIndex,
      },
      noteHash: (await oxideInnerNoteHash({ recipient: terms.recipient, token: terms.token, amount: BigInt(terms.amount), randomness })).toString(),
      siloedNoteHash: siloed.toString(),
      uniqueNoteHash: unique.toString(),
      preparedObservation: prepared,
      revertedObservation: reverted,
      refusals: [
        {
          name: "payoutNoteHashIndex names another note hash",
          observation: { ...finalized, payoutNoteHashIndex: 0 },
        },
        {
          name: "payoutNoteHashIndex out of range",
          observation: { ...finalized, payoutNoteHashIndex: OXIDE_PAYOUT_FIXTURE.noteHashCount },
        },
        { name: "payoutNoteHashIndex negative", observation: { ...finalized, payoutNoteHashIndex: -1 } },
        { name: "payoutNoteHashIndex null on a finalized success", observation: { ...finalized, payoutNoteHashIndex: null } },
        { name: "payoutNoteHashIndex missing on an oxide mined observation", observation: withoutIndex },
        {
          name: "randomness of another note",
          observation: { ...finalized, partialNoteRandomness: PAYOUT_FIXTURE.partialNoteRandomness },
        },
        {
          name: "spending_limit observation carrying payoutNoteHashIndex",
          sendMode: "spending_limit",
          observation: { ...spendingLimitFinalized, payoutNoteHashIndex: PAYOUT_FIXTURE.noteHashIndex },
        },
      ],
      bridgeHolds: {
        note:
          "When the bridge cannot find the payout's unique note hash at exactly one position of a mined " +
          "transaction's effects (effects unavailable, hash absent, or present twice) it answers this " +
          "instead of a mined observation; the operation stays marked and is never refundable on it.",
        observation: { state: "unknown", reason: "payout_note_hash_unresolved" },
      },
    },
  };
}

/**
 * What a consumer must know about `expirationTimestamp`: the Aztec protocol
 * expiry of the journaled transaction, the last block timestamp it can be
 * included at. It is fixed when the transaction is proven, at most
 * MAX_TX_LIFETIME past its anchor block, and independent of `validUntil`.
 */
function transactionExpiry(): Record<string, unknown> {
  const expiry = BigInt(EXPIRATION_TIMESTAMP);
  const validUntil = BigInt(PARAMS.validUntil);
  const lifetime = BigInt(MAX_TX_LIFETIME);
  if (expiry === validUntil || expiry < validUntil || expiry >= validUntil + lifetime) {
    throw new Error("vector expiry must lie in (validUntil, validUntil + MAX_TX_LIFETIME)");
  }
  if ((expiry - ANCHOR_BLOCK_TIMESTAMP) % 3600n !== 0n) {
    throw new Error("vector expiry must be whole hours past its anchor, as the PXE produces");
  }
  const prepared: Observation = {
    state: "prepared",
    txHash: TX_HASH,
    expirationTimestamp: EXPIRATION_TIMESTAMP,
    hold: "may_broadcast_unknown",
  };
  return {
    note:
      "expirationTimestamp is the transaction's Aztec protocol expiry (tx.data.expirationTimestamp), " +
      "NOT validUntil. The PXE sets it to min(anchor + MAX_TX_LIFETIME, any lower expiry a call set, " +
      "rounded down to whole hours, then 30 minutes, then seconds past the anchor). The bridge refuses " +
      "to send past either bound, but a transaction sent before validUntil can be included until " +
      "expirationTimestamp. A consumer admits validUntil <= expirationTimestamp < validUntil + " +
      "maxTxLifetime and must not refund before expirationTimestamp has passed.",
    maxTxLifetime: MAX_TX_LIFETIME,
    anchorBlockTimestamp: ANCHOR_BLOCK_TIMESTAMP.toString(),
    validUntil: PARAMS.validUntil,
    expirationTimestamp: EXPIRATION_TIMESTAMP,
    preparedObservation: prepared,
  };
}

export async function buildSettlementVectors(): Promise<Record<string, unknown>> {
  const parsed = CreateNoteSchema.parse(PARAMS);
  const terms = termsFrom(parsed);
  const fingerprint = fingerprintTerms(terms);
  const shout = shouted(PARAMS);
  if (fingerprintTerms(termsFrom(CreateNoteSchema.parse(shout))) !== fingerprint) {
    throw new Error("case changed the fingerprint");
  }
  for (const refusal of REFUSALS) {
    if (CreateNoteSchema.safeParse(refusal.params).success) {
      throw new Error(`refusal vector "${refusal.name}" is accepted`);
    }
  }
  if (networkIdentityDigest(SPEC_FIXTURE_A.network) !== SPEC_FIXTURE_A.networkIdentityDigest) {
    throw new Error("NetworkIdentity digest does not reproduce @xochi/spec fixture-a");
  }
  const payout = await finalizedPayout();
  return {
    version: 2,
    generator: "scripts/settlement-vectors.ts (npm run generate:settlement-vectors)",
    contract: SETTLEMENT_VERSION,
    source:
      "docs/settlement-operations.md; values from @xochi/spec 0.9.0 conformance/shielded.json " +
      "recipientBinding \"baseline\" (network fixture-a); payout inputs from Riddler " +
      "test/support/vectors/aztec_payment_proof.json",
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
      result: {
        note:
          "A finalized success for these terms. Every included/finalized/reverted observation carries " +
          "partialNoteRandomness (0x + 64 lowercase hex, or null for an attempt journaled before v2); " +
          "aztec_getSettlement answers the same observation.",
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            version: SETTLEMENT_VERSION,
            operationId: OPERATION_ID,
            fingerprint,
            observation: payout.observation,
          },
        },
      },
      partialNote: payout.partialNote,
    },
    transactionExpiry: transactionExpiry(),
    getSettlement: {
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "aztec_getSettlement",
        params: [{ version: SETTLEMENT_VERSION, operationId: OPERATION_ID }],
      },
    },
    retiredVersions: SETTLEMENT_VERSIONS_RETIRED.map((retired) => ({
      version: retired,
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "aztec_getSettlement",
        params: [{ version: retired, operationId: OPERATION_ID }],
      },
      error: {
        code: -32602,
        data: { reason: "settlement_version_unsupported", supported: SETTLEMENT_VERSION },
      },
    })),
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
    oxide: await oxideCase(payout.observation),
  };
}

export async function renderSettlementVectors(): Promise<string> {
  return JSON.stringify(await buildSettlementVectors(), null, 2) + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(VECTOR_PATH, await renderSettlementVectors());
  console.log(`wrote ${VECTOR_PATH}`);
}
