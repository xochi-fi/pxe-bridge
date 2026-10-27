import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The settlement operation contract (xochi-fi/pxe-bridge#45, consumer
 * axol-io/Riddler#1351). Wire shapes are documented in
 * docs/settlement-operations.md; this module is their single definition.
 *
 * Every `aztec_createNote` names an operation. The operation id equals the
 * request's `Idempotency-Key`, and the bridge computes a fingerprint over the
 * terms that decide where value goes. Same id + same fingerprint is the same
 * operation, whatever the JSON-RPC envelope id; same id + different
 * fingerprint is a conflict and does no work.
 */
export const SETTLEMENT_VERSION = "pxe-bridge.settlement.v1";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX20 = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9]\d*)$/;
const POSITIVE = /^[1-9]\d*$/;

/** 2^128 - 1: the contract amounts are u128, and the spec caps them there. */
export const MAX_AMOUNT = (1n << 128n) - 1n;

/** BN254 scalar field modulus; an Aztec field value must be below it. */
const BN254_FR_MODULUS =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

const field = (what: string) =>
  z
    .string()
    .regex(HEX32, `${what} must be 32-byte hex`)
    .refine((s) => BigInt(s) !== 0n, `${what} must be nonzero`)
    .refine((s) => BigInt(s) < BN254_FR_MODULUS, `${what} must be below the BN254 field modulus`);

const bytes32 = (what: string) => z.string().regex(HEX32, `${what} must be 32-byte hex`);

const uint256 = (what: string) =>
  z
    .string()
    .regex(UINT, `${what} must be a canonical decimal string`)
    .refine((s) => s.length <= 78 && BigInt(s) < 1n << 256n, `${what} exceeds uint256`);

/** §7 NetworkIdentity, member names and encodings as the EIP-712 struct. */
export const NetworkIdentitySchema = z
  .object({
    aztecChainId: uint256("aztecChainId"),
    protocolVersion: uint256("protocolVersion"),
    rollupAddress: z.string().regex(HEX20, "rollupAddress must be a 20-byte hex address"),
    l1ChainId: uint256("l1ChainId"),
    genesisOrNetworkDigest: bytes32("genesisOrNetworkDigest"),
  })
  .strict();

export type NetworkIdentity = z.infer<typeof NetworkIdentitySchema>;

export const CorridorSchema = z
  .object({
    corridorId: bytes32("corridorId"),
    corridorRevision: z.number().int().min(1).max(0xffffffff),
    manifestDigest: bytes32("manifestDigest"),
  })
  .strict();

export type Corridor = z.infer<typeof CorridorSchema>;

/**
 * The corridor this bridge serves (`PXE_BRIDGE_SETTLEMENT_CORRIDOR`). Every
 * value is an operator decision still open for manifest revision 1 (xochi §7
 * "Still open"), so it is configuration, and a request naming any other
 * corridor or network digest is refused before anything is prepared.
 */
export const CorridorConfigSchema = CorridorSchema.extend({
  genesisOrNetworkDigest: bytes32("genesisOrNetworkDigest"),
}).strict();

export type CorridorConfig = z.infer<typeof CorridorConfigSchema>;

/**
 * Which account class signs. `spending_limit` is the design-A tracer account;
 * `standard` is the plain Schnorr account (B-panel's account class). In the
 * fingerprint so a journal written for one cannot be replayed through the
 * other (#45 re-scope).
 */
export const AccountModeSchema = z.enum(["spending_limit", "standard"]);
export type AccountMode = z.infer<typeof AccountModeSchema>;

export const SettlementTermsSchema = z
  .object({
    network: NetworkIdentitySchema,
    corridor: CorridorSchema,
    accountMode: AccountModeSchema,
    recipient: field("recipient"),
    recipientDescriptorDigest: bytes32("recipientDescriptorDigest"),
    token: field("token"),
    amount: z
      .string()
      .regex(POSITIVE, "amount must be a positive canonical decimal string")
      .refine((s) => s.length <= 39 && BigInt(s) <= MAX_AMOUNT, "amount exceeds 2^128 - 1"),
    /** Unix seconds. The bridge neither prepares nor broadcasts at or after it. */
    validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type SettlementTerms = z.infer<typeof SettlementTermsSchema>;

/** Same charset and length the server enforces on the `Idempotency-Key` header. */
const OperationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/, "operationId must be printable ASCII")
  .refine((s) => s.trim() === s, "operationId must not carry surrounding whitespace");

export const CreateNoteV1Schema = SettlementTermsSchema.extend({
  version: z.literal(SETTLEMENT_VERSION),
  operationId: OperationIdSchema,
}).strict();

export type CreateNoteV1 = z.infer<typeof CreateNoteV1Schema>;

export const GetSettlementSchema = z
  .object({
    version: z.literal(SETTLEMENT_VERSION),
    operationId: OperationIdSchema,
  })
  .strict();

/**
 * The pre-#45 params: `{recipient, token, amount, chainId, tradeId?...}`.
 * Recognized only so the refusal can say why; never executed.
 */
export function isLegacyCreateNoteParams(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !("version" in value) &&
    ("chainId" in value || "recipient" in value)
  );
}

/** Lowercase hex, so case never changes a fingerprint or a comparison. */
export function canonicalTerms(terms: SettlementTerms): SettlementTerms {
  return {
    network: {
      aztecChainId: terms.network.aztecChainId,
      protocolVersion: terms.network.protocolVersion,
      rollupAddress: terms.network.rollupAddress.toLowerCase(),
      l1ChainId: terms.network.l1ChainId,
      genesisOrNetworkDigest: terms.network.genesisOrNetworkDigest.toLowerCase(),
    },
    corridor: {
      corridorId: terms.corridor.corridorId.toLowerCase(),
      corridorRevision: terms.corridor.corridorRevision,
      manifestDigest: terms.corridor.manifestDigest.toLowerCase(),
    },
    accountMode: terms.accountMode,
    recipient: terms.recipient.toLowerCase(),
    recipientDescriptorDigest: terms.recipientDescriptorDigest.toLowerCase(),
    token: terms.token.toLowerCase(),
    amount: terms.amount,
    validUntil: terms.validUntil,
  };
}

const FINGERPRINT_DOMAIN = "pxe-bridge/settlement-fingerprint/v1";

/**
 * Bridge-owned fingerprint (decided 2026-10-25: not an @xochi/spec encoding).
 *
 * SHA-256 over the domain, then one `name=value` line per term in this fixed
 * order, values canonical (lowercase hex, decimal strings). No field can
 * contain `\n` or `=` after schema validation, so the encoding is injective.
 * Callers compare fingerprints for equality and terms field by field; nobody
 * recomputes this outside the bridge.
 */
export function fingerprintTerms(terms: SettlementTerms): string {
  const t = canonicalTerms(terms);
  const lines = [
    FINGERPRINT_DOMAIN,
    `network.aztecChainId=${t.network.aztecChainId}`,
    `network.protocolVersion=${t.network.protocolVersion}`,
    `network.rollupAddress=${t.network.rollupAddress}`,
    `network.l1ChainId=${t.network.l1ChainId}`,
    `network.genesisOrNetworkDigest=${t.network.genesisOrNetworkDigest}`,
    `corridor.corridorId=${t.corridor.corridorId}`,
    `corridor.corridorRevision=${t.corridor.corridorRevision}`,
    `corridor.manifestDigest=${t.corridor.manifestDigest}`,
    `accountMode=${t.accountMode}`,
    `recipient=${t.recipient}`,
    `recipientDescriptorDigest=${t.recipientDescriptorDigest}`,
    `token=${t.token}`,
    `amount=${t.amount}`,
    `validUntil=${t.validUntil}`,
  ];
  return "0x" + createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export function termsFrom(params: CreateNoteV1): SettlementTerms {
  const { version: _v, operationId: _o, ...terms } = params;
  return canonicalTerms(terms);
}

/** Restricted, uninterpreted evidence: no element is called "the" note. */
export interface Effects {
  state: "available" | "unavailable";
  noteHashes: string[];
  nullifiers: string[];
}

/** Aztec receipt finality vocabulary for a mined transaction. */
export type MinedStatus = "proposed" | "checkpointed" | "proven" | "finalized";

/**
 * The discriminated observation. Absence of an operation is `unknown`, never
 * "no payout"; only `not_submitted` and `prepared` say nothing was broadcast.
 */
export type Observation =
  | {
      state: "prepared";
      txHash: string;
      expirationTimestamp: string;
      hold: "may_broadcast_unknown" | "may_broadcast_denied" | "interrupted";
    }
  | { state: "not_submitted"; reason: string; retryableAfterRevalidation: boolean }
  | { state: "request_in_flight" }
  | { state: "submitted_unknown"; txHash: string; expirationTimestamp: string; reason: string }
  | { state: "pending"; txHash: string; expirationTimestamp: string }
  | {
      state: "included" | "finalized" | "reverted";
      txHash: string;
      expirationTimestamp: string;
      executionResult: "success" | "reverted";
      blockHash: string;
      blockNumber: string;
      receiptStatus: MinedStatus;
      observedAt: number;
      effects: Effects;
    }
  | { state: "unknown"; reason: string };

/** What the node said about a transaction hash, before journal context. */
export type NodeObservation =
  | { kind: "pending" }
  | { kind: "dropped" }
  | {
      kind: "mined";
      executionResult: "success" | "reverted";
      blockHash: string;
      blockNumber: string;
      receiptStatus: MinedStatus;
      effects: Effects;
    };
