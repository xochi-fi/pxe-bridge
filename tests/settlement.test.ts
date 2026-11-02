import { describe, it, expect } from "vitest";
import {
  CreateNoteSchema,
  MAX_AMOUNT,
  fingerprintTerms,
  isLegacyCreateNoteParams,
  termsFrom,
} from "../src/settlement.js";
import { settlementParams } from "./settlement-fixtures.js";

const fp = (overrides: Record<string, unknown> = {}) =>
  fingerprintTerms(termsFrom(CreateNoteSchema.parse(settlementParams({ validUntil: 2_000_000_000, ...overrides }))));

describe("fingerprintTerms", () => {
  it("is stable for the same terms and blind to the operation id and hex case", () => {
    expect(fp()).toBe(fp());
    expect(fp({ operationId: "other" })).toBe(fp());
    const upper = settlementParams()["recipient"] as string;
    expect(fp({ recipient: "0x" + upper.slice(2).toUpperCase() })).toBe(fp());
  });

  it.each([
    ["amount", { amount: "1001" }],
    ["recipient", { recipient: "0x0" + "9".repeat(63) }],
    ["token", { token: "0x0" + "8".repeat(63) }],
    ["descriptor digest", { recipientDescriptorDigest: "0x" + "9".repeat(64) }],
    ["account mode", { accountMode: "standard" }],
    ["validity bound", { validUntil: 2_000_000_001 }],
    [
      "corridor revision",
      { corridor: { ...(settlementParams()["corridor"] as object), corridorRevision: 2 } },
    ],
    [
      "manifest digest",
      { corridor: { ...(settlementParams()["corridor"] as object), manifestDigest: "0x" + "1".repeat(64) } },
    ],
    [
      "network",
      { network: { ...(settlementParams()["network"] as object), protocolVersion: "1" } },
    ],
  ])("changes with the %s", (_name, override) => {
    expect(fp(override)).not.toBe(fp());
  });

  it("is a 32-byte hex digest", () => {
    expect(fp()).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("CreateNoteSchema", () => {
  it("accepts 2^128 - 1 and refuses 2^128", () => {
    expect(CreateNoteSchema.safeParse(settlementParams({ amount: MAX_AMOUNT.toString() })).success).toBe(true);
    expect(CreateNoteSchema.safeParse(settlementParams({ amount: (MAX_AMOUNT + 1n).toString() })).success).toBe(
      false,
    );
  });

  it("refuses an Aztec value at or above the field modulus", () => {
    const modulus = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
    expect(CreateNoteSchema.safeParse(settlementParams({ recipient: modulus })).success).toBe(false);
  });

  it("accepts a small Aztec value such as a protocol contract", () => {
    expect(CreateNoteSchema.safeParse(settlementParams({ token: "0x" + "0".repeat(63) + "5" })).success).toBe(true);
  });

  it("refuses a missing validity bound", () => {
    const { validUntil: _v, ...rest } = settlementParams();
    expect(CreateNoteSchema.safeParse(rest).success).toBe(false);
  });

  // D-C: the NetworkIdentity value rules of @xochi/spec shielded.json.
  it.each([
    ["a zero Aztec chain id", { aztecChainId: "0" }],
    ["a zero protocol version", { protocolVersion: "0" }],
    [
      "a protocol version at the field modulus",
      { protocolVersion: "21888242871839275222246405745257275088548364400416034343698204186575808495617" },
    ],
    ["a zero L1 chain id", { l1ChainId: "0" }],
    ["a zero rollup address", { rollupAddress: "0x" + "0".repeat(40) }],
    ["a zero network digest", { genesisOrNetworkDigest: "0x" + "0".repeat(64) }],
  ])("refuses %s", (_name, override) => {
    const network = { ...(settlementParams()["network"] as object), ...override };
    expect(CreateNoteSchema.safeParse(settlementParams({ network })).success).toBe(false);
  });

  it("admits a zero descriptor digest: @xochi/spec types it as any bytes32", () => {
    const zero = "0x" + "0".repeat(64);
    expect(CreateNoteSchema.safeParse(settlementParams({ recipientDescriptorDigest: zero })).success).toBe(true);
  });

  it.each([
    ["recipient", "0xzz"],
    ["amount", "1.5"],
    ["network", { ...(settlementParams()["network"] as object), aztecChainId: "12a" }],
    ["network", { ...(settlementParams()["network"] as object), rollupAddress: "0xnothex" }],
  ])("fails, never throws, on malformed %s", (field, value) => {
    expect(() => CreateNoteSchema.safeParse(settlementParams({ [field]: value }))).not.toThrow();
    expect(CreateNoteSchema.safeParse(settlementParams({ [field]: value })).success).toBe(false);
  });
});

describe("isLegacyCreateNoteParams", () => {
  it("recognizes the pre-#45 shape and not the v1 one", () => {
    expect(isLegacyCreateNoteParams({ recipient: "0x", token: "0x", amount: "1", chainId: 1 })).toBe(true);
    expect(isLegacyCreateNoteParams(settlementParams())).toBe(false);
    expect(isLegacyCreateNoteParams(undefined)).toBe(false);
  });
});
