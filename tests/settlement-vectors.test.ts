import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  NETWORK_IDENTITY_TYPE_STRING,
  SPEC_FIXTURE_A,
  VECTOR_PATH,
  networkIdentityDigest,
  renderSettlementVectors,
} from "../scripts/settlement-vectors.js";
import { CreateNoteV1Schema, fingerprintTerms, termsFrom } from "../src/settlement.js";

interface Vector {
  networkIdentity: { typeString: string; typehash: string; networkIdentityDigest: string };
  createNote: {
    http: { headers: Record<string, string> };
    body: { params: [Record<string, unknown>] };
    canonicalTerms: unknown;
    fingerprint: string;
    sameFingerprint: { name: string; params?: Record<string, unknown> }[];
    refusals: { name: string; params: Record<string, unknown> }[];
  };
  mayBroadcast: { request: { body: { fingerprint: string; operationId: string } } };
}

const committed = readFileSync(VECTOR_PATH, "utf8");
const vector = JSON.parse(committed) as Vector;

describe("docs/vectors/settlement-v1.json (D-C canonical request vector)", () => {
  it("is exactly what the generator builds: regenerate, never hand-edit", () => {
    expect(committed).toBe(renderSettlementVectors());
  });

  it("is a request the bridge accepts, with the fingerprint it computes", () => {
    const params = vector.createNote.body.params[0];
    const parsed = CreateNoteV1Schema.parse(params);
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
      expect(fingerprintTerms(termsFrom(CreateNoteV1Schema.parse(same.params))), same.name).toBe(
        vector.createNote.fingerprint,
      );
    }
    for (const refusal of vector.createNote.refusals) {
      expect(CreateNoteV1Schema.safeParse(refusal.params).success, refusal.name).toBe(false);
    }
  });
});
