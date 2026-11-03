import type { MinedStatus, Observation, OxidePayoutNoteCommitment, SettlementTerms } from "../settlement.js";
import type { OxideObservation } from "./operation.js";
import { locatePayoutNoteHash, oxideSiloedNoteHash } from "./payout-proof.js";
import type { OxidePayoutIdentity } from "./sender.js";

/**
 * The Oxide sender's answer as the `pxe-bridge.settlement.v2` observation
 * (pxe-bridge#84, decided 2026-11-03).
 *
 * - `prepared` keeps the v2 hold vocabulary: the sender's own holds
 *   (`cap_window_full`, `preflight_refused`) are `interrupted` on the wire,
 *   which means the same thing to a consumer: journaled, never marked,
 *   provably not broadcast, and resent only as these exact bytes.
 * - Every `prepared` answer carries `payoutNoteCommitment`: the payout note's
 *   randomness and enclave-signed siloed hash, recomputed from the signed
 *   terms. A consumer must durably bind it with the prepared transaction
 *   before authorizing broadcast or moving source funds.
 * - A successful mined observation carries the same randomness as
 *   `partialNoteRandomness` and `payoutNoteHashIndex`: the payout's position
 *   in the mined transaction's `effects.noteHashes`. When the position is not
 *   exactly one (effects unavailable or malformed, the hash absent or present
 *   twice), the answer is `unknown` / `payout_note_hash_unresolved`.
 * - A reverted transaction is negative delivery evidence only when effects
 *   are available and contain no unique note hash opened by the prepared
 *   commitment. Present, duplicate, malformed, or unavailable evidence holds.
 */
export const PAYOUT_NOTE_HASH_UNRESOLVED = "payout_note_hash_unresolved";

const MINED_STATUSES: readonly string[] = ["proposed", "checkpointed", "proven", "finalized"];

export async function oxideSettlementObservation(
  observation: OxideObservation,
  payout: OxidePayoutIdentity | undefined,
  terms: SettlementTerms,
): Promise<Observation> {
  switch (observation.state) {
    case "prepared": {
      const commitment = await payoutNoteCommitment(payout, observation.txHash, terms);
      if (!commitment) return { state: "unknown", reason: "missing_transaction_identity" };
      return {
        state: "prepared",
        txHash: observation.txHash,
        expirationTimestamp: observation.expirationTimestamp,
        hold:
          observation.hold === "may_broadcast_denied" || observation.hold === "may_broadcast_unknown"
            ? observation.hold
            : "interrupted",
        payoutNoteCommitment: commitment,
      };
    }
    case "not_submitted":
      return {
        state: "not_submitted",
        reason: observation.reason,
        retryableAfterRevalidation: observation.retryable,
      };
    case "request_in_flight":
    case "submitted_unknown":
    case "pending":
    case "unknown":
      return observation;
    case "included":
    case "finalized":
    case "reverted":
      break;
  }
  if (!MINED_STATUSES.includes(observation.receiptStatus)) {
    console.error(`[oxide] Mined observation with receipt status ${observation.receiptStatus}`);
    return { state: "unknown", reason: "receipt_status_unknown" };
  }
  const commitment = await payoutNoteCommitment(payout, observation.txHash, terms);
  if (!commitment) {
    return { state: "unknown", reason: "missing_transaction_identity" };
  }
  const mined = {
    state: observation.state,
    txHash: observation.txHash,
    expirationTimestamp: observation.expirationTimestamp,
    executionResult: observation.executionResult,
    blockHash: observation.blockHash,
    blockNumber: observation.blockNumber,
    receiptStatus: observation.receiptStatus as MinedStatus,
    observedAt: observation.observedAt,
    effects: observation.effects,
    partialNoteRandomness: commitment.partialNoteRandomness,
  };
  const siloed = await oxideSiloedNoteHash({
    recipient: terms.recipient,
    token: terms.token,
    amount: BigInt(terms.amount),
    randomness: commitment.partialNoteRandomness,
  });
  const location = await locatePayoutNoteHash(observation.effects, siloed);
  if (observation.state === "reverted") {
    if (location.kind === "unresolved" && location.reason === "payout_note_hash_absent") {
      return { ...mined, payoutNoteHashIndex: null };
    }
    const reason = location.kind === "found" ? "payout_note_hash_present" : location.reason;
    console.error(`[oxide] Reverted payout evidence unresolved in ${observation.txHash}: ${reason}`);
    return { state: "unknown", reason: PAYOUT_NOTE_HASH_UNRESOLVED };
  }
  if (location.kind !== "found") {
    console.error(`[oxide] Payout note hash unresolved in ${observation.txHash}: ${location.reason}`);
    return { state: "unknown", reason: PAYOUT_NOTE_HASH_UNRESOLVED };
  }
  return { ...mined, payoutNoteHashIndex: location.index };
}

async function payoutNoteCommitment(
  payout: OxidePayoutIdentity | undefined,
  txHash: string,
  terms: SettlementTerms,
): Promise<OxidePayoutNoteCommitment | undefined> {
  if (!payout || payout.txHash !== txHash) return undefined;
  const siloed = await oxideSiloedNoteHash({
    recipient: terms.recipient,
    token: terms.token,
    amount: BigInt(terms.amount),
    randomness: payout.noteRandomness,
  });
  const siloedNoteHash = siloed.toString().toLowerCase();
  if (siloedNoteHash !== payout.siloedNoteHash.toLowerCase()) {
    console.error("[oxide] The signed payout note is not the note the terms and randomness open");
    return undefined;
  }
  return {
    scheme: "oxide-payout-note-v1",
    partialNoteRandomness: payout.noteRandomness.toLowerCase(),
    siloedNoteHash,
  };
}
