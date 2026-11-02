import { createHash } from "node:crypto";
import { z } from "zod";
import type { NodeObservation } from "../settlement.js";

/**
 * The Oxide send operation (xochi-fi/pxe-bridge#84, phase 1). Internal: no
 * wire contract is published for it yet, because the settlement version it
 * will be served under (v2 or a v3 carrying the Oxide evidence) is undecided.
 * Everything below is what the sender journals and answers its caller with.
 */
export const OXIDE_SEND_VERSION = "pxe-bridge.oxide-send.v1";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const BN254_FR_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const MAX_U128 = (1n << 128n) - 1n;

/** What a caller asks the sender to pay. `operationId` is the idempotency key. */
export const OxideSendRequestSchema = z
  .object({
    operationId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x21-\x7e]+$/, "operationId must be printable ASCII without spaces"),
    /** Aztec address of the recipient account (stock SchnorrAccount on the corridor). */
    recipient: z
      .string()
      .regex(HEX32, "recipient must be 32-byte hex")
      .refine((s) => !HEX32.test(s) || (BigInt(s) !== 0n && BigInt(s) < BN254_FR_MODULUS), "recipient must be a nonzero field"),
    /** OXDAI base units (18 dp), canonical decimal string. */
    amount: z
      .string()
      .regex(/^[1-9][0-9]*$/, "amount must be a canonical positive decimal string")
      .refine((s) => !/^[1-9][0-9]*$/.test(s) || BigInt(s) <= MAX_U128, "amount exceeds u128"),
    /** Riddler's order fingerprint, carried in the transfer's private `meta`. */
    orderFingerprint: z.string().regex(HEX32, "orderFingerprint must be 32-byte hex"),
    /** Unix seconds. Nothing is sent at or after it. */
    validUntil: z.number().int().positive(),
  })
  .strict();

export type OxideSendRequest = z.infer<typeof OxideSendRequestSchema>;

/** The journaled terms: the request's value terms, canonicalized, plus the pinned token. */
export interface OxideTerms {
  version: typeof OXIDE_SEND_VERSION;
  recipient: string;
  token: string;
  amount: string;
  orderFingerprint: string;
  validUntil: number;
}

export function oxideTerms(request: OxideSendRequest, token: string): OxideTerms {
  return {
    version: OXIDE_SEND_VERSION,
    recipient: request.recipient.toLowerCase(),
    token: token.toLowerCase(),
    amount: request.amount,
    orderFingerprint: request.orderFingerprint.toLowerCase(),
    validUntil: request.validUntil,
  };
}

const FINGERPRINT_DOMAIN = "pxe-bridge/oxide-send-fingerprint/v1";

/** Bridge-owned: same operation id with another fingerprint is a conflict. */
export function fingerprintOxideTerms(terms: OxideTerms): string {
  const lines = [
    FINGERPRINT_DOMAIN,
    `version=${terms.version}`,
    `recipient=${terms.recipient.toLowerCase()}`,
    `token=${terms.token.toLowerCase()}`,
    `amount=${terms.amount}`,
    `orderFingerprint=${terms.orderFingerprint.toLowerCase()}`,
    `validUntil=${terms.validUntil}`,
  ];
  return `0x${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

/**
 * What the proven transaction pays and who signed it, journaled with its bytes
 * BEFORE anything may broadcast them. It is the Oxide analogue of the v2
 * partial-note randomness: the recipient note's randomness and the enclave's
 * signature over its siloed hash are what a consumer needs to prove the payout,
 * and nothing else keeps them. Never logged.
 */
export interface OxideSendEvidence {
  anchorBlockHash: string;
  enclave: { address: string; registrationLeafIndex: string; publicKeyX: string; publicKeyY: string };
  /** In TokenOperation order; `recipientNoteIndex` names the payout. */
  createdNotes: { owner: string; amount: string; randomness: string }[];
  recipientNoteIndex: number;
  /** Siloed note hashes the enclave signed, parallel to `createdNotes`. */
  teeNotes: string[];
  requiredNullifiers: string[];
  /**
   * Every nullifier the proven tx emits (siloed, lowercase). While the attempt
   * may still land, a new attempt whose simulation emits any of them is refused
   * before the enclave is asked (sender.ts `inputs_pending`): the node would take
   * at most one of the two.
   */
  txNullifiers: string[];
  signatures: { sLo: string; sHi: string; rLo: string; rHi: string }[];
  gasLimits: { daGas: number; l2Gas: number };
  maxFeesPerGas: { feePerDaGas: string; feePerL2Gas: string };
}

/** Rejects stored evidence this code did not write. */
export function isOxideSendEvidence(value: unknown): value is OxideSendEvidence {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["anchorBlockHash"] === "string" &&
    typeof e["enclave"] === "object" &&
    e["enclave"] !== null &&
    Array.isArray(e["createdNotes"]) &&
    typeof e["recipientNoteIndex"] === "number" &&
    Array.isArray(e["teeNotes"]) &&
    Array.isArray(e["requiredNullifiers"]) &&
    Array.isArray(e["txNullifiers"]) &&
    (e["txNullifiers"] as unknown[]).every((n) => typeof n === "string") &&
    Array.isArray(e["signatures"]) &&
    (e["teeNotes"] as unknown[]).length === (e["createdNotes"] as unknown[]).length &&
    (e["signatures"] as unknown[]).length === (e["createdNotes"] as unknown[]).length &&
    Number.isInteger(e["recipientNoteIndex"]) &&
    (e["recipientNoteIndex"] as number) >= 0 &&
    (e["recipientNoteIndex"] as number) < (e["createdNotes"] as unknown[]).length
  );
}

/** Why a prepared (journaled, unmarked) attempt is held; a later call resends its exact bytes. */
export type OxideHold =
  | "may_broadcast_unknown"
  | "may_broadcast_denied"
  | "interrupted"
  | "cap_window_full"
  | "preflight_refused";

/** The sender's answer. Same vocabulary as the settlement contract's observations. */
export type OxideObservation =
  | { state: "prepared"; txHash: string; expirationTimestamp: string; hold: OxideHold }
  | { state: "not_submitted"; reason: string; retryable: boolean }
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
      receiptStatus: string;
      observedAt: number;
      effects: Extract<NodeObservation, { kind: "mined" }>["effects"];
    }
  | { state: "unknown"; reason: string };

export type OxideSendResult =
  | { kind: "conflict"; operationId: string; fingerprint: string; storedFingerprint: string }
  | { kind: "observed"; operationId: string; fingerprint: string; observation: OxideObservation };
