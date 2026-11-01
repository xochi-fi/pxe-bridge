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
import { CreateNoteSchema, SETTLEMENT_VERSION, fingerprintTerms, termsFrom } from "../src/settlement.js";

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
            partialNoteRandomness: string;
            effects: { noteHashes: string[]; nullifiers: string[] };
          };
        };
      };
    };
  };
  mayBroadcast: { request: { body: { fingerprint: string; operationId: string } } };
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

  // The vector's finalized observation must be one Riddler's recipient check
  // accepts for the vector's own terms, and must fail it for any other
  // recipient: the proof this contract version exists to carry.
  it("carries randomness that proves the payout to the signed recipient, and only to it", async () => {
    const params = vector.createNote.body.params[0];
    const { observation } = vector.createNote.result.body.result;
    expect(vector.createNote.result.body.result.fingerprint).toBe(vector.createNote.fingerprint);
    expect(observation.partialNoteRandomness).toMatch(/^0x[0-9a-f]{64}$/);
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
