import type { MinedStatus, Observation, SettlementTerms } from "../settlement.js";
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
 * - A mined observation carries the payout note's randomness as
 *   `partialNoteRandomness` and `payoutNoteHashIndex`: the payout's position
 *   in the mined transaction's `effects.noteHashes`, found by recomputing the
 *   note from the signed terms and that randomness (src/oxide/payout-proof.ts).
 *   `reverted` carries `payoutNoteHashIndex: null`. When the position is not
 *   exactly one (effects unavailable or malformed, the hash absent or present
 *   twice), or the recomputed note is not the one the enclave signed, the
 *   answer is `unknown` / `payout_note_hash_unresolved`: never a mined
 *   observation a consumer could not prove, and never a refund signal.
 */
export const PAYOUT_NOTE_HASH_UNRESOLVED = "payout_note_hash_unresolved";

const MINED_STATUSES: readonly string[] = ["proposed", "checkpointed", "proven", "finalized"];

export async function oxideSettlementObservation(
  observation: OxideObservation,
  payout: OxidePayoutIdentity | undefined,
  terms: SettlementTerms,
): Promise<Observation> {
  switch (observation.state) {
    case "prepared":
      return {
        state: "prepared",
        txHash: observation.txHash,
        expirationTimestamp: observation.expirationTimestamp,
        hold:
          observation.hold === "may_broadcast_denied" || observation.hold === "may_broadcast_unknown"
            ? observation.hold
            : "interrupted",
      };
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
  if (!payout || payout.txHash !== observation.txHash) {
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
    partialNoteRandomness: payout.noteRandomness,
  };
  if (observation.state === "reverted") return { ...mined, payoutNoteHashIndex: null };

  const siloed = await oxideSiloedNoteHash({
    recipient: terms.recipient,
    token: terms.token,
    amount: BigInt(terms.amount),
    randomness: payout.noteRandomness,
  });
  if (siloed.toString().toLowerCase() !== payout.siloedNoteHash.toLowerCase()) {
    console.error("[oxide] The signed payout note is not the note the terms and randomness open");
    return { state: "unknown", reason: PAYOUT_NOTE_HASH_UNRESOLVED };
  }
  const location = await locatePayoutNoteHash(observation.effects, siloed);
  if (location.kind !== "found") {
    console.error(`[oxide] Payout note hash unresolved in ${observation.txHash}: ${location.reason}`);
    return { state: "unknown", reason: PAYOUT_NOTE_HASH_UNRESOLVED };
  }
  return { ...mined, payoutNoteHashIndex: location.index };
}
