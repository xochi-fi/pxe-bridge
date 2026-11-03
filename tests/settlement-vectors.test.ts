import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address";
import {
  NETWORK_IDENTITY_TYPE_STRING,
  PAYOUT_FIXTURE,
  SPEC_FIXTURE_A,
  VECTOR_PATH,
  networkIdentityDigest,
  renderSettlementVectors,
} from "../scripts/settlement-vectors.js";
import { effectsProvePayout } from "../src/partial-note.js";
import {
  CreateNoteSchema,
  SETTLEMENT_VERSION,
  fingerprintLines,
  fingerprintTerms,
  termsFrom,
} from "../src/settlement.js";
import { orderFingerprintMeta } from "../src/oxide/backend.js";
import {
  locatePayoutNoteHash,
  oxideNoteRandomness,
  oxideSiloedNoteHash,
  oxideUniqueNoteHash,
} from "../src/oxide/payout-proof.js";

interface Vector {
  contract: string;
  networkIdentity: { typeString: string; typehash: string; networkIdentityDigest: string };
  createNote: {
    http: { headers: Record<string, string> };
    body: { params: [Record<string, unknown>] };
    canonicalTerms: unknown;
    fingerprint: string;
    sameFingerprint: { name: string; params?: Record<string, unknown> }[];
    refusals: { name: string; params: Record<string, unknown> }[];
    result: {
      body: {
        result: {
          fingerprint: string;
          observation: {
            state: string;
            expirationTimestamp: string;
            partialNoteRandomness: string;
            effects: { noteHashes: string[]; nullifiers: string[] };
          };
        };
      };
    };
  };
  mayBroadcast: { request: { body: { fingerprint: string; operationId: string } } };
  transactionExpiry: {
    maxTxLifetime: number;
    anchorBlockTimestamp: string;
    validUntil: number;
    expirationTimestamp: string;
    preparedObservation: { state: string; expirationTimestamp: string };
  };
}

const committed = readFileSync(VECTOR_PATH, "utf8");
const vector = JSON.parse(committed) as Vector;

describe("docs/vectors/settlement-v2.json (D-C canonical vector)", () => {
  it("is exactly what the generator builds: regenerate, never hand-edit", async () => {
    expect(committed).toBe(await renderSettlementVectors());
  });

  it("names the current contract version", () => {
    expect(vector.contract).toBe(SETTLEMENT_VERSION);
    expect(SETTLEMENT_VERSION).toBe("pxe-bridge.settlement.v2");
  });

  // Riddler#1428: a vector whose expiry equals validUntil hid that consumers
  // compared the two. The expiry is the transaction's own protocol bound.
  it("journals the transaction's protocol expiry, distinct from validUntil", () => {
    const expiry = vector.transactionExpiry;
    const validUntil = Number(vector.createNote.body.params[0]["validUntil"]);
    const expirationTimestamp = Number(expiry.expirationTimestamp);
    expect(expiry.maxTxLifetime).toBe(86400);
    expect(expiry.validUntil).toBe(validUntil);
    expect(expirationTimestamp).not.toBe(validUntil);
    expect(expirationTimestamp).toBeGreaterThan(validUntil);
    expect(expirationTimestamp).toBeLessThan(validUntil + expiry.maxTxLifetime);
    expect(expirationTimestamp - Number(expiry.anchorBlockTimestamp)).toBe(expiry.maxTxLifetime);
    expect(expiry.preparedObservation).toMatchObject({ state: "prepared", expirationTimestamp: expiry.expirationTimestamp });
    expect(vector.createNote.result.body.result.observation.expirationTimestamp).toBe(expiry.expirationTimestamp);
  });

  // The vector's finalized observation must be one Riddler's recipient check
  // accepts for the vector's own terms, and must fail it for any other
  // recipient: the proof this contract version exists to carry.
  it("carries randomness that proves the payout to the signed recipient, and only to it", async () => {
    const params = vector.createNote.body.params[0];
    const { observation } = vector.createNote.result.body.result;
    expect(vector.createNote.result.body.result.fingerprint).toBe(vector.createNote.fingerprint);
    expect(observation.partialNoteRandomness).toMatch(/^0x[0-9a-f]{64}$/);
    // Every published effect is a field element, as on a real chain; out-of-field
    // filler would make a strict consumer refuse the vector's own proof.
    for (const value of [...observation.effects.noteHashes, ...observation.effects.nullifiers]) {
      expect(() => Fr.fromString(value)).not.toThrow();
    }
    const proof = {
      token: AztecAddress.fromStringUnsafe(String(params["token"])),
      recipient: AztecAddress.fromStringUnsafe(String(params["recipient"])),
      payoutAccount: AztecAddress.fromStringUnsafe(PAYOUT_FIXTURE.payoutAccount),
      amount: BigInt(String(params["amount"])),
      randomness: Fr.fromString(observation.partialNoteRandomness),
    };
    expect(await effectsProvePayout(observation.effects, proof)).toBe(true);
    expect(
      await effectsProvePayout(observation.effects, {
        ...proof,
        recipient: AztecAddress.fromStringUnsafe("0x" + "1d".repeat(32)),
      }),
    ).toBe(false);
    expect(await effectsProvePayout(observation.effects, { ...proof, amount: proof.amount + 1n })).toBe(false);
  });

  it("is a request the bridge accepts, with the fingerprint it computes", () => {
    const params = vector.createNote.body.params[0];
    const parsed = CreateNoteSchema.parse(params);
    expect(termsFrom(parsed)).toEqual(vector.createNote.canonicalTerms);
    expect(fingerprintTerms(termsFrom(parsed))).toBe(vector.createNote.fingerprint);
    expect(vector.createNote.http.headers["Idempotency-Key"]).toBe(params["operationId"]);
    expect(vector.mayBroadcast.request.body).toMatchObject({
      operationId: params["operationId"],
      fingerprint: vector.createNote.fingerprint,
    });
  });

  it("names @xochi/spec's NetworkIdentity, reproducing its pinned digest", () => {
    expect(vector.networkIdentity.typeString).toBe(NETWORK_IDENTITY_TYPE_STRING);
    // @xochi/spec 0.9.0 shielded.json networkIdentity.typehash.
    expect(vector.networkIdentity.typehash).toBe(
      "0xd30a9f62f8e7b404cb3181a16d547adec2b019fa08cadb19ea0a97528c727cff",
    );
    expect(networkIdentityDigest(SPEC_FIXTURE_A.network)).toBe(SPEC_FIXTURE_A.networkIdentityDigest);
    expect(vector.networkIdentity.networkIdentityDigest).toBe(SPEC_FIXTURE_A.networkIdentityDigest);
  });

  it("keeps the fingerprint under case changes and refuses every refusal vector", () => {
    for (const same of vector.createNote.sameFingerprint) {
      if (!same.params) continue;
      expect(fingerprintTerms(termsFrom(CreateNoteSchema.parse(same.params))), same.name).toBe(
        vector.createNote.fingerprint,
      );
    }
    for (const refusal of vector.createNote.refusals) {
      expect(CreateNoteSchema.safeParse(refusal.params).success, refusal.name).toBe(false);
    }
  });
});

interface MinedVectorObservation {
  state: string;
  partialNoteRandomness: string | null;
  payoutNoteHashIndex?: number | null;
  effects: { state: string; noteHashes: string[]; nullifiers: string[] };
}

interface OxideVector {
  createNote: {
    body: { params: [Record<string, unknown>] };
    canonicalTerms: Record<string, unknown>;
    fingerprintLines: string[];
    fingerprint: string;
    spendingLimitCounterpart: { fingerprint: string };
    result: { body: { result: { fingerprint: string; observation: MinedVectorObservation } } };
  };
  orderFingerprint: { tag: string; orderFingerprint: string; transferMetaLen: number; meta: string[] };
  payoutProof: {
    inputs: { randomnessSeed: string; randomnessIndex: number; partialNoteRandomness: string; payoutNoteHashIndex: number };
    siloedNoteHash: string;
    uniqueNoteHash: string;
    preparedObservation: {
      state: string;
      payoutNoteCommitment: {
        scheme: string;
        partialNoteRandomness: string;
        siloedNoteHash: string;
      };
    };
    revertedObservation: MinedVectorObservation;
    refusals: { name: string; sendMode?: string; observation: MinedVectorObservation }[];
    bridgeHolds: { observation: { state: string; reason: string } };
  };
}

/**
 * What a consumer (Riddler `Shielded.PaymentProof`, oxide) checks of an oxide
 * mined success: the index is an integer in range, and the unique note hash
 * recomputed from the signed terms, the randomness and that index is the
 * published note hash there.
 */
async function oxideObservationProves(
  observation: MinedVectorObservation,
  terms: { recipient: string; token: string; amount: string },
): Promise<boolean> {
  const index = observation.payoutNoteHashIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return false;
  if (index >= observation.effects.noteHashes.length || observation.partialNoteRandomness === null) return false;
  const siloed = await oxideSiloedNoteHash({
    recipient: terms.recipient,
    token: terms.token,
    amount: BigInt(terms.amount),
    randomness: observation.partialNoteRandomness,
  });
  const unique = await oxideUniqueNoteHash(siloed, Fr.fromString(observation.effects.nullifiers[0]!), index);
  return unique.equals(Fr.fromString(observation.effects.noteHashes[index]!));
}

describe("docs/vectors/settlement-v2.json oxide case (sendMode, pxe-bridge#84)", () => {
  const oxide = (vector as unknown as { oxide: OxideVector }).oxide;
  const params = oxide.createNote.body.params[0];

  // 0.3.0's committed vector fingerprint for these terms: adding sendMode
  // must not move a single journaled spending_limit operation.
  it("keeps the spending_limit fingerprint byte-identical to 0.3.0", () => {
    expect(vector.createNote.fingerprint).toBe("0xef29c46772683bcab6d096ab4b5288111ba8f64cb8392ba6c72b802fcdbb6f88");
    const { sendMode: _s, ...legacy } = termsFrom(CreateNoteSchema.parse(vector.createNote.body.params[0]));
    expect(fingerprintTerms(legacy)).toBe(vector.createNote.fingerprint);
  });

  it("hashes sendMode oxide as one line right after accountMode", () => {
    const terms = termsFrom(CreateNoteSchema.parse(params));
    expect(terms).toEqual(oxide.createNote.canonicalTerms);
    expect(fingerprintTerms(terms)).toBe(oxide.createNote.fingerprint);
    expect(fingerprintLines(terms)).toEqual(oxide.createNote.fingerprintLines);
    const at = oxide.createNote.fingerprintLines.indexOf("accountMode=standard");
    expect(oxide.createNote.fingerprintLines[at + 1]).toBe("sendMode=oxide");
    expect(oxide.createNote.fingerprintLines.filter((l) => l.startsWith("sendMode="))).toHaveLength(1);
    expect(oxide.createNote.spendingLimitCounterpart.fingerprint).toBe(
      fingerprintTerms({ ...terms, sendMode: "spending_limit" }),
    );
    expect(oxide.createNote.spendingLimitCounterpart.fingerprint).not.toBe(oxide.createNote.fingerprint);
    expect(oxide.createNote.result.body.result.fingerprint).toBe(oxide.createNote.fingerprint);
  });

  it("carries the request fingerprint as the order fingerprint in the transfer meta", () => {
    expect(oxide.orderFingerprint.orderFingerprint).toBe(oxide.createNote.fingerprint);
    expect(oxide.orderFingerprint.tag).toBe("pxe-bridge/oxide-order-fingerprint/v1");
    const meta = orderFingerprintMeta(oxide.createNote.fingerprint, oxide.orderFingerprint.transferMetaLen);
    expect(meta.map((f) => f.toString())).toEqual(oxide.orderFingerprint.meta);
    const fp = oxide.createNote.fingerprint.slice(2);
    expect(BigInt(oxide.orderFingerprint.meta[1]!)).toBe(BigInt(`0x${fp.slice(0, 32)}`));
    expect(BigInt(oxide.orderFingerprint.meta[2]!)).toBe(BigInt(`0x${fp.slice(32)}`));
    expect(oxide.orderFingerprint.meta.slice(3).every((f) => BigInt(f) === 0n)).toBe(true);
  });

  it("proves the payout from the mined effects at payoutNoteHashIndex, and only there", async () => {
    const terms = { recipient: String(params["recipient"]), token: String(params["token"]), amount: String(params["amount"]) };
    const observation = oxide.createNote.result.body.result.observation;
    expect(observation.partialNoteRandomness).toBe(
      (await oxideNoteRandomness(Fr.fromString(oxide.payoutProof.inputs.randomnessSeed), oxide.payoutProof.inputs.randomnessIndex)).toString(),
    );
    expect(observation.payoutNoteHashIndex).toBe(oxide.payoutProof.inputs.payoutNoteHashIndex);
    expect(observation.effects.noteHashes[observation.payoutNoteHashIndex!]).toBe(oxide.payoutProof.uniqueNoteHash);
    expect(await oxideObservationProves(observation, terms)).toBe(true);
    const siloed = await oxideSiloedNoteHash({ ...terms, amount: BigInt(terms.amount), randomness: observation.partialNoteRandomness! });
    expect(siloed.toString()).toBe(oxide.payoutProof.siloedNoteHash);
    expect(await locatePayoutNoteHash({ ...observation.effects, state: "available" }, siloed)).toEqual({
      kind: "found",
      index: oxide.payoutProof.inputs.payoutNoteHashIndex,
    });
    expect(await oxideObservationProves(observation, { ...terms, recipient: "0x" + "1d".repeat(32) })).toBe(false);
    expect(await oxideObservationProves(observation, { ...terms, amount: (BigInt(terms.amount) + 1n).toString() })).toBe(false);
    for (const refusal of oxide.payoutProof.refusals) {
      expect(await oxideObservationProves(refusal.observation, terms), refusal.name).toBe(false);
    }
    expect(oxide.payoutProof.preparedObservation).toMatchObject({
      state: "prepared",
      payoutNoteCommitment: {
        scheme: "oxide-payout-note-v1",
        partialNoteRandomness: oxide.payoutProof.inputs.partialNoteRandomness,
        siloedNoteHash: oxide.payoutProof.siloedNoteHash,
      },
    });
    expect(oxide.payoutProof.revertedObservation).toMatchObject({ state: "reverted", payoutNoteHashIndex: null });
    expect(await oxideObservationProves(oxide.payoutProof.revertedObservation, terms)).toBe(false);
    expect(
      await locatePayoutNoteHash({ ...oxide.payoutProof.revertedObservation.effects, state: "available" }, siloed),
    ).toEqual({ kind: "unresolved", reason: "payout_note_hash_absent" });
    expect(oxide.payoutProof.bridgeHolds.observation).toEqual({ state: "unknown", reason: "payout_note_hash_unresolved" });
  });

  it("carries no payoutNoteHashIndex on the spending_limit observation", () => {
    expect("payoutNoteHashIndex" in vector.createNote.result.body.result.observation).toBe(false);
  });
});
