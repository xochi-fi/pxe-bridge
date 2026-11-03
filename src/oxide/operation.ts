import type { NodeObservation, SettlementTerms } from "../settlement.js";
import { OXIDE_V6_MAINNET } from "./pins.js";

/**
 * The Oxide send operation (xochi-fi/pxe-bridge#84). It is served under
 * `pxe-bridge.settlement.v2` with `sendMode: "oxide"` (decided 2026-11-03):
 * the journal keeps the operation's v2 terms and its v2 request fingerprint
 * (`fingerprintTerms`), so an operation id names the same terms here as on
 * the wire, and the same id with any other v2 terms is a conflict. The order
 * fingerprint the transfer carries in its private `meta` is that request
 * fingerprint. Everything below is what the sender journals and answers its
 * caller with.
 */

/** Terms this sender can never pay: not an Oxide send. */
export class OxideTermsRefused extends Error {
  constructor(readonly reason: "send_mode_not_oxide" | "account_mode_not_standard" | "token_not_oxdai") {
    super(`Oxide send refused: ${reason}`);
    this.name = "OxideTermsRefused";
  }
}

/** The v2 terms the Oxide sender pays: `sendMode` oxide, the standard account, the pinned OXDAI token. */
export function assertOxideTerms(terms: SettlementTerms): void {
  if (terms.sendMode !== "oxide") throw new OxideTermsRefused("send_mode_not_oxide");
  if (terms.accountMode !== "standard") throw new OxideTermsRefused("account_mode_not_standard");
  if (terms.token.toLowerCase() !== OXIDE_V6_MAINNET.bridge.l2Token) throw new OxideTermsRefused("token_not_oxdai");
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

/**
 * `gasLimits x maxFeesPerGas` summed over both dimensions: the most the node
 * may charge the fee payer (stdlib `GasSettings.getFeeLimit`). The node admits
 * a tx only if its fee payer holds at least this.
 */
export function oxideFeeLimit(gas: {
  gasLimits: { daGas: number; l2Gas: number };
  maxFeesPerGas: { feePerDaGas: bigint | string; feePerL2Gas: bigint | string };
}): bigint {
  return (
    BigInt(gas.gasLimits.daGas) * BigInt(gas.maxFeesPerGas.feePerDaGas) +
    BigInt(gas.gasLimits.l2Gas) * BigInt(gas.maxFeesPerGas.feePerL2Gas)
  );
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
