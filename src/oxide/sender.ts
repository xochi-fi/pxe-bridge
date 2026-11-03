import { JournalUnreadableError, JournalWriteError, type JournalHealth } from "../journal.js";
import type { MayBroadcastClient } from "../may-broadcast.js";
import { known, unknown, type ReadinessFact, type ReadinessReason } from "../readiness.js";
import {
  fingerprintTerms,
  OperationIdSchema,
  SettlementTermsSchema,
  type NodeObservation,
  type SettlementTerms,
} from "../settlement.js";
import { CapExceeded, OxideCaps, type OxideCapsConfig } from "./caps.js";
import { EnclaveTrustRefused, enclaveRefusalPermanent } from "./enclave.js";
import type { OxideAttempt, OxideJournal, OxideStoredOperation } from "./journal.js";
import {
  assertOxideTerms,
  oxideFeeLimit,
  type OxideHold,
  type OxideObservation,
  type OxideSendEvidence,
} from "./operation.js";
import { OxidePinMismatch } from "./pins.js";
import type { OxideAdmissionVerdict } from "./readiness.js";
import { MAX_TX_LIFETIME } from "@aztec-labs/constants";
import { assertJournaledIdentity, JournaledBytesMismatch, type TxIdentity } from "../tx-identity.js";

/**
 * The Oxide sender (xochi-fi/pxe-bridge#84): pays OXDAI to an Aztec recipient
 * through Oxide's enclave-signed `transfer` + `publish_da`, on the bridge's
 * standard Schnorr account, with the createNote journal's rules
 * (src/oxide/journal.ts) so a restart at any step never pays twice.
 *
 *   admission -> simulate -> check the TokenOperation -> fee runway floor
 *   -> enclave sign -> size gas -> fee runway -> prove
 *   -> journal the proven tx -> may-broadcast -> mark (+ cap re-check) -> send
 *
 * `aztec_createNote` with `sendMode: "oxide"` reaches `OxideSender.send`
 * (src/rpc.ts). The operation is the v2 operation: its journal row holds the
 * v2 terms and fingerprint, may-broadcast is asked for that fingerprint, and
 * the transfer's order fingerprint is it. The answer carries what the v2
 * observation needs: the tx hash, the protocol expiry (journaled as its own
 * bound, required >= `validUntil`) and the payout note's randomness.
 */

/** What the backend is asked to pay. */
export interface OxidePayout {
  recipient: string;
  amount: bigint;
  orderFingerprint: string;
}

/** The TokenOperation the enclave will be asked to sign, reduced to what the sender checks. */
export interface TokenOperationSummary {
  /** Every nullifier the simulated tx emits (siloed): spent notes, spent deposits, the tx nullifier. */
  nullifiers: string[];
  /** Block the simulation (and so the PXE's note selection) is anchored at. */
  anchorBlockNumber: number;
  createdNotes: { owner: string; amount: bigint }[];
  spentNoteOwners: string[];
  depositRecipients: string[];
  withdrawals: number;
}

export interface OxideSimulation {
  summary: TokenOperationSummary;
  /**
   * The fee limit (`gasLimits x maxFeesPerGas`, sized as `size` sizes it) of
   * the simulated `transfer` alone, at the fees predicted now. The proven
   * batch adds `publish_da`, so this is a floor under what the send will
   * declare: an account below it can never pay, and the enclave is not asked.
   */
  feeLimitFloor: bigint;
  /** Backend-private state carried to `sign`. */
  handle: unknown;
}

export interface OxideSigned {
  handle: unknown;
}

/** The signed batch with its explicit gas settings, before proving. */
export interface OxideSized {
  /** `gasLimits x maxFeesPerGas`: the most the node may charge the account for this send. */
  feeLimit: bigint;
  handle: unknown;
}

export interface OxideProvenTx {
  txHash: string;
  txBytes: Buffer;
  /** Protocol expiry (unix seconds): the node refuses inclusion after it. */
  expirationTimestamp: bigint;
  evidence: OxideSendEvidence;
}

/**
 * The PXE / enclave / node boundary, one step per method so each can fail on
 * its own. Nothing here may broadcast except `send`, and `send` must reach the
 * node without awaiting first (the bound check before it is synchronous).
 */
export interface OxideBackend {
  /** The sending account (lowercase 0x hex). */
  readonly account: string;
  simulate(payout: OxidePayout): Promise<OxideSimulation>;
  sign(simulation: OxideSimulation): Promise<OxideSigned>;
  /** Simulates the signed batch and sizes its gas: what `prove` will declare. */
  size(signed: OxideSigned): Promise<OxideSized>;
  prove(sized: OxideSized): Promise<OxideProvenTx>;
  /**
   * The hash and protocol expiry a node gives `txBytes`, recomputed from the
   * transaction's data (never the stored hash prefix alone). Throws
   * `JournaledBytesMismatch` when the bytes do not decode or do not hash to their own data.
   */
  identify(txBytes: Buffer): Promise<TxIdentity>;
  send(txBytes: Buffer): Promise<void>;
  observe(txHash: string): Promise<NodeObservation>;
  /** The account's public fee juice balance at the node's latest state: what pays every send (`PREEXISTING_FEE_JUICE`). */
  feeJuiceBalance(): Promise<bigint>;
  /**
   * The most one send can be charged at the fees predicted now: the node's
   * per-tx gas limit (`txsLimits.gas`) at the fees a send declares. Standard
   * mode's `perTransferFeeLimit`, for the readiness surface.
   */
  maxSendFeeLimit(): Promise<bigint>;
}

/** Re-verified before every fresh attempt: the Oxide manifest/profile pins, the L1 deployment. */
export interface OxidePreflight {
  assertPinned(): Promise<void>;
}

function boundedErrorClass(cause: unknown): string {
  if (cause instanceof OxidePinMismatch) return "oxide_pin_mismatch";
  if (cause instanceof EnclaveTrustRefused) return `enclave_refused:${cause.reason}`;
  return cause instanceof Error && cause.name.length <= 64 ? cause.name : "unknown_error";
}

function preflightRefusal(cause: unknown): { reason: string; retryable: boolean } {
  if (cause instanceof OxidePinMismatch) return { reason: "oxide_pin_mismatch", retryable: false };
  if (cause instanceof EnclaveTrustRefused) {
    return {
      reason: `enclave_refused:${cause.reason}`,
      retryable: !enclaveRefusalPermanent(cause.reason),
    };
  }
  return { reason: "oxide_pin_unverified", retryable: true };
}

/**
 * New admission for a fresh attempt (`OxideReadiness`, src/oxide/readiness.ts):
 * the recipient is in the private allowlist and the sender is ready.
 * Consulted after the journal claim and only before a fresh attempt; a
 * journaled attempt keeps recovering without it, as in spending_limit mode.
 * `not_ready` is retryable; `refused` says itself.
 */
export interface OxideAdmission {
  admit(terms: { recipient: string; amount: string }): Promise<OxideAdmissionVerdict>;
}

/** Per-call context of `OxideSender.send`. */
export interface OxideSendContext {
  /** The caller's response deadline: aborted, nothing this call started marks. */
  signal?: AbortSignal | undefined;
  /** The caller's terms check (corridor, network), asked before admission on a fresh attempt only. */
  termsCheck?: (() => Promise<OxideAdmissionVerdict>) | undefined;
}
/** What a send answers: the observation, plus the payout's identity once an attempt exists. */
export interface OxideSendAnswer {
  kind: "observed";
  operationId: string;
  fingerprint: string;
  observation: OxideObservation;
  /** Present once a proven transaction is journaled for the operation. */
  payout?: OxidePayoutIdentity;
  /** Set when this call's admission said `not_ready`: the readiness reasons, first one journaled. */
  notReady?: ReadinessReason[];
}

export interface OxidePayoutIdentity {
  txHash: string;
  expirationTimestamp: string;
  /** Randomness of the recipient's note: with (recipient, amount) it opens the signed note hash. Never log it. */
  noteRandomness: string;
  /** Position of the recipient's note among the TokenOperation's created notes. Internal: never the wire's index. */
  noteIndex: number;
  /** The siloed note hash the enclave signed for it. */
  siloedNoteHash: string;
}

export type OxideSendOutcome =
  | OxideSendAnswer
  | { kind: "conflict"; operationId: string; fingerprint: string; storedFingerprint: string }
  | { kind: "journal_unavailable"; operationId: string; detail: string };

/** `aztec_getSettlement` for an operation the Oxide journal holds. */
export interface OxideSettlementRead {
  operation: OxideStoredOperation;
  attempts: OxideAttempt[];
  observation: OxideObservation;
  payout?: OxidePayoutIdentity;
}

/** The TokenOperation is not the transfer the sender asked for. Never sent to the enclave. */
export class UnexpectedTokenOperation extends Error {
  constructor(detail: string) {
    super(`Oxide TokenOperation refused: ${detail}`);
    this.name = "UnexpectedTokenOperation";
  }
}

/**
 * The one created note that pays `payout`, checked before the enclave is asked:
 * no withdrawal, every spent note and deposit is the sender's, exactly one note
 * is the recipient's and carries exactly the amount, every other note (change)
 * is the sender's. Returns its index.
 */
export function payoutNoteIndex(summary: TokenOperationSummary, sender: string, payout: OxidePayout): number {
  const self = sender.toLowerCase();
  const recipient = payout.recipient.toLowerCase();
  if (recipient === self) throw new UnexpectedTokenOperation("recipient is the sending account");
  if (summary.withdrawals !== 0) throw new UnexpectedTokenOperation(`${summary.withdrawals} withdrawal(s)`);
  if (summary.spentNoteOwners.some((o) => o.toLowerCase() !== self)) {
    throw new UnexpectedTokenOperation("spends a note the sender does not own");
  }
  if (summary.depositRecipients.some((o) => o.toLowerCase() !== self)) {
    throw new UnexpectedTokenOperation("spends a deposit the sender does not own");
  }
  const toRecipient = summary.createdNotes.flatMap((n, i) => (n.owner.toLowerCase() === recipient ? [i] : []));
  if (toRecipient.length !== 1) throw new UnexpectedTokenOperation(`${toRecipient.length} notes to the recipient`);
  const index = toRecipient[0]!;
  if (summary.createdNotes[index]!.amount !== payout.amount) {
    throw new UnexpectedTokenOperation("the recipient note does not carry the payout amount");
  }
  if (summary.createdNotes.some((n, i) => i !== index && n.owner.toLowerCase() !== self)) {
    throw new UnexpectedTokenOperation("a created note belongs to a third party");
  }
  return index;
}

/** The simulation spends inputs a live attempt already spends. Nothing was signed; retry once that attempt resolves. */
class InputsPending extends Error {
  constructor() {
    super("the simulation spends notes a live attempt already spends");
    this.name = "InputsPending";
  }
}

/**
 * The account cannot pay this send's fee on top of what other attempts may
 * still be charged (`fee_runway_low`), or its balance could not be read
 * (`fee_runway_unknown`). Nothing was proven; both clear on their own once
 * fee juice arrives or an attempt resolves, so both are retryable.
 */
class FeeRunwayRefused extends Error {
  constructor(readonly reason: "fee_runway_low" | "fee_runway_unknown", detail: string) {
    super(`Oxide fee runway: ${detail}`);
    this.name = "FeeRunwayRefused";
  }
}

/** The Oxide sender's fee position, for the readiness surface (standard mode's `feeRunway` fact). */
export interface OxideFeeRunway {
  /** Public fee juice balance of the sending account, latest state. */
  observed: bigint;
  /** Fee limits of attempts that may still land and be charged (`OxideJournal.committedFees`). */
  committed: bigint;
  committedSends: number;
  /** The most one more send can be charged at the fees predicted now (`OxideBackend.maxSendFeeLimit`). */
  perSendFeeLimit: bigint;
}

/** Readiness reasons for an Oxide fee runway fact: unread, or short of one more send on top of the committed ones. */
export function oxideFeeRunwayReasons(fact: ReadinessFact<OxideFeeRunway>): ReadinessReason[] {
  if (fact.state === "unknown") return [fact.reason];
  const { observed, committed, perSendFeeLimit } = fact.value;
  return observed < committed + perSendFeeLimit ? ["fee_runway_insufficient"] : [];
}

export interface OxideSenderOptions {
  journal: OxideJournal;
  backend: OxideBackend;
  caps: OxideCapsConfig;
  preflight: OxidePreflight;
  /** New admission (allowlist membership, readiness): asked once per fresh attempt, after the claim. */
  admission: OxideAdmission;
  /** The broadcast gate (Riddler's may-broadcast): only an exact `allow` marks. */
  mayBroadcast: MayBroadcastClient;
  now?: () => number;
}

/** At most this many marked operations are re-read before a fresh attempt. */
const RECONCILE_LIMIT = 8;

class Answer {
  constructor(readonly answer: OxideSendAnswer) {}
}

export class OxideSender {
  private readonly journal: OxideJournal;
  private readonly backend: OxideBackend;
  private readonly caps: OxideCaps;
  private readonly preflight: OxidePreflight;
  private readonly admission: OxideAdmission;
  private readonly mayBroadcast: MayBroadcastClient;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  /** Fresh attempts run simulate -> recordPrepared one at a time (see `fresh`). */
  private laneTail: Promise<void> = Promise.resolve();

  constructor(options: OxideSenderOptions) {
    this.journal = options.journal;
    this.backend = options.backend;
    this.preflight = options.preflight;
    this.admission = options.admission;
    this.mayBroadcast = options.mayBroadcast;
    this.now = options.now ?? Date.now;
    this.caps = new OxideCaps(options.caps, (since) => this.journal.spentSince(since), this.now);
  }

  /**
   * Pays the v2 `terms` (sendMode oxide) once for `operationId`, or reports
   * what that operation already is. `signal` is the caller's response
   * deadline: once it aborts nothing this call started may be marked
   * may-broadcast (a journaled attempt is held `interrupted` for the retry).
   * `termsCheck` is the caller's check of the terms against what this bridge
   * serves (corridor, network), asked with admission before a fresh attempt
   * only. Throws only on terms that are not an Oxide send or are malformed.
   */
  async send(input: { operationId: string; terms: SettlementTerms } & OxideSendContext): Promise<OxideSendOutcome> {
    const id = OperationIdSchema.parse(input.operationId);
    const terms = SettlementTermsSchema.parse(input.terms);
    assertOxideTerms(terms);
    if (this.inFlight.has(id)) {
      const fingerprint = fingerprintTerms(terms);
      let stored: OxideStoredOperation | undefined;
      try {
        stored = this.journal.get(id);
      } catch (cause) {
        if (!(cause instanceof JournalUnreadableError)) throw cause;
        return { kind: "journal_unavailable", operationId: id, detail: cause.message };
      }
      if (stored && stored.fingerprint !== fingerprint) {
        return { kind: "conflict", operationId: id, fingerprint, storedFingerprint: stored.fingerprint };
      }
      return { kind: "observed", operationId: id, fingerprint, observation: { state: "request_in_flight" } };
    }
    this.inFlight.add(id);
    try {
      return await this.drive(id, terms, input);
    } catch (cause) {
      if (cause instanceof Answer) return cause.answer;
      if (cause instanceof JournalWriteError || cause instanceof JournalUnreadableError) {
        return { kind: "journal_unavailable", operationId: id, detail: "journal_unavailable" };
      }
      throw cause;
    } finally {
      this.caps.release(id);
      this.inFlight.delete(id);
    }
  }

  /** The Oxide journal's health, for the wire's `journal_unavailable` answer. */
  journalHealth(): JournalHealth {
    return this.journal.health();
  }

  /**
   * Read-only recovery for `aztec_getSettlement`: undefined when the Oxide
   * journal does not hold the operation. A marked operation reads the node; a
   * call driving the operation right now answers `request_in_flight` until
   * the node knows its transaction.
   */
  async read(operationId: string): Promise<OxideSettlementRead | undefined> {
    const op = this.journal.get(operationId);
    if (!op) return undefined;
    const driving = this.inFlight.has(operationId);
    let observation: OxideObservation;
    switch (op.state) {
      case "claimed":
        observation = driving
          ? { state: "request_in_flight" }
          : { state: "not_submitted", reason: "interrupted_before_prepare", retryable: true };
        break;
      case "not_submitted":
        observation = this.notSubmittedObservation(op);
        break;
      case "finalized":
      case "reverted":
        observation = op.observation ?? { state: "unknown", reason: "terminal_observation_missing" };
        break;
      case "prepared": {
        const attempt = this.currentAttempt(op);
        observation = driving
          ? { state: "request_in_flight" }
          : attempt
            ? this.preparedObservation(attempt, op.hold ?? "interrupted")
            : { state: "unknown", reason: "missing_transaction_identity" };
        break;
      }
      case "may_broadcast":
        observation = await this.observe(op);
        if (driving && observation.state === "submitted_unknown") observation = { state: "request_in_flight" };
        break;
    }
    // The observation may have just recorded a terminal outcome: answer from the durable row.
    const current = this.journal.get(operationId) ?? op;
    if ((current.state === "finalized" || current.state === "reverted") && current.observation) {
      observation = current.observation;
    }
    const answered = this.answer(current, observation);
    return {
      operation: current,
      attempts: this.journal.attempts(operationId),
      observation,
      ...(answered.payout ? { payout: answered.payout } : {}),
    };
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private async drive(id: string, terms: SettlementTerms, context: OxideSendContext): Promise<OxideSendOutcome> {
    const claim = this.journal.claim(id, terms);
    if (claim.kind === "conflict") {
      return {
        kind: "conflict",
        operationId: id,
        fingerprint: fingerprintTerms(terms),
        storedFingerprint: claim.operation.fingerprint,
      };
    }
    const op = claim.operation;
    if (claim.kind === "existing") {
      const resumed = await this.resume(op, context.signal);
      if (resumed) return resumed;
    }
    return this.fresh(this.journal.get(id)!, context);
  }

  /** An operation the journal already holds. Undefined when it provably never broadcast and was re-armed. */
  private async resume(op: OxideStoredOperation, signal: AbortSignal | undefined): Promise<OxideSendAnswer | undefined> {
    switch (op.state) {
      case "finalized":
      case "reverted":
        return this.answer(op, op.observation ?? { state: "unknown", reason: "terminal_observation_missing" });
      case "may_broadcast":
        return this.answer(op, await this.observe(op));
      case "not_submitted":
        if (!op.retryable) return this.answer(op, this.notSubmittedObservation(op));
        this.journal.reclaim(op.operationId);
        return undefined;
      case "claimed":
        // Interrupted before anything was proven and journaled: nothing can have broadcast.
        return undefined;
      case "prepared": {
        const attempt = this.currentAttempt(op);
        if (!attempt) return this.answer(op, { state: "unknown", reason: "missing_transaction_identity" });
        if (this.nowSeconds() >= op.terms.validUntil) {
          return this.refuse(op, "validity_bound_passed", false);
        }
        if (BigInt(this.nowSeconds()) >= BigInt(attempt.expirationTimestamp)) {
          // Never marked and the protocol now refuses it: a fresh attempt replaces it.
          this.journal.reclaim(op.operationId);
          return undefined;
        }
        // The deployment must still be the pinned one before held bytes go
        // out: a portal frozen, or a registry or manifest that moved, since the
        // attempt was proven. Refused, the attempt stays prepared and a later
        // call retries these exact bytes.
        try {
          await this.preflight.assertPinned();
        } catch (cause) {
          const refusal = preflightRefusal(cause);
          console.error(`[oxide] Preflight refused a held attempt: ${boundedErrorClass(cause)}`);
          if (!refusal.retryable) return this.refuse(op, refusal.reason, false);
          this.journal.recordHold(op.operationId, "preflight_refused");
          return this.answer(this.journal.get(op.operationId)!, this.preparedObservation(attempt, "preflight_refused"));
        }
        return this.broadcast(op, attempt, signal);
      }
    }
  }

  private async fresh(op: OxideStoredOperation, context: OxideSendContext): Promise<OxideSendAnswer> {
    const { signal } = context;
    const { terms, operationId: id } = op;
    if (this.nowSeconds() >= terms.validUntil) return this.refuse(op, "validity_bound_passed", false);
    // The caller was already answered: start nothing it can no longer hear about.
    if (signal?.aborted) return this.refuse(op, "response_deadline", true);
    const payout: OxidePayout = {
      recipient: terms.recipient,
      amount: BigInt(terms.amount),
      // The order fingerprint is the v2 request fingerprint (pxe-bridge#84).
      orderFingerprint: op.fingerprint,
    };

    const checked = context.termsCheck ? await context.termsCheck() : ({ kind: "admitted" } as const);
    if (checked.kind === "not_ready") {
      return { ...this.refuse(op, checked.reasons[0] ?? "readiness_observation_failed", true), notReady: checked.reasons };
    }
    if (checked.kind === "refused") return this.refuse(op, checked.reason, checked.retryable);
    const verdict = await this.admission.admit({ recipient: terms.recipient, amount: terms.amount });
    if (verdict.kind === "not_ready") {
      const answer = this.refuse(op, verdict.reasons[0] ?? "readiness_observation_failed", true);
      return { ...answer, notReady: verdict.reasons };
    }
    if (verdict.kind === "refused") return this.refuse(op, verdict.reason, verdict.retryable);

    try {
      this.caps.admit(id, payout.amount);
    } catch (cause) {
      if (!(cause instanceof CapExceeded)) throw cause;
      return this.refuse(op, `cap:${cause.reason}`, cause.reason === "daily_cap_exhausted");
    }

    try {
      await this.preflight.assertPinned();
    } catch (cause) {
      const refusal = preflightRefusal(cause);
      console.error(`[oxide] Preflight refused: ${boundedErrorClass(cause)}`);
      return this.refuse(op, refusal.reason, refusal.retryable);
    }

    // One account, one set of notes. The PXE selects notes from what it has
    // synced and knows nothing of an attempt that is journaled or sent but not
    // yet mined in a block it has seen, so two operations proven side by side
    // spend the same notes and the node takes at most one: the other is marked,
    // counted against the window and stranded at submitted_unknown. So fresh
    // attempts run one at a time from simulation to the journal, and a
    // simulation that emits a nullifier some live attempt already carries is
    // refused before the enclave is asked (`inputs_pending`, retryable).
    const release = await this.acquireLane();
    let recorded: OxideAttempt;
    try {
      await this.reconcileMarked();
      const proven = await this.prepare(op, payout);
      // Riddler#1428 option 2 admits `validUntil <= expiry < validUntil + MAX_TX_LIFETIME`.
      // Below it the consumer could read "expired" while its own deadline is
      // still open; at or above it Riddler refuses admission, and the prepared
      // attempt's nullifiers would hold the account until validUntil.
      if (proven.expirationTimestamp < BigInt(terms.validUntil)) {
        return this.refuse(op, "expiration_before_valid_until", false);
      }
      if (proven.expirationTimestamp >= BigInt(terms.validUntil) + BigInt(MAX_TX_LIFETIME)) {
        return this.refuse(op, "expiration_outside_window", false);
      }
      const attempt = this.journal.recordPrepared(id, proven);
      recorded = this.journal.attempts(id).find((a) => a.attempt === attempt)!;
    } finally {
      release();
    }
    return this.broadcast(this.journal.get(id)!, recorded, signal);
  }

  private async acquireLane(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const previous = this.laneTail;
    this.laneTail = previous.then(() => held);
    await previous;
    return release;
  }

  /** Re-reads marked operations not yet seen mined, so a landed one stops counting as live. */
  private async reconcileMarked(): Promise<void> {
    for (const id of this.journal.unminedMarked(this.nowSeconds()).slice(0, RECONCILE_LIMIT)) {
      const op = this.journal.get(id);
      if (op) await this.observe(op);
    }
  }

  /**
   * simulate -> check -> runway floor -> sign -> size -> runway -> prove. Any
   * failure here provably sent nothing. The fee runway is checked twice: the
   * exact fee limit exists only once the signed batch is simulated, so before
   * the enclave is asked the account must cover the floor the unsigned
   * `transfer` gives, and before proving the limit the proof will declare.
   */
  private async prepare(op: OxideStoredOperation, payout: OxidePayout): Promise<OxideProvenTx> {
    let step = "simulate";
    try {
      const simulation = await this.backend.simulate(payout);
      step = "check";
      payoutNoteIndex(simulation.summary, this.backend.account, payout);
      const live = this.journal.liveNullifiers(
        this.nowSeconds(),
        simulation.summary.anchorBlockNumber,
        op.operationId,
      );
      if (simulation.summary.nullifiers.some((n) => live.has(n.toLowerCase()))) throw new InputsPending();
      step = "fee_runway";
      await this.assertFeeRunway(op, simulation.feeLimitFloor);
      step = "sign";
      const signed = await this.backend.sign(simulation);
      step = "size";
      const sized = await this.backend.size(signed);
      step = "fee_runway";
      await this.assertFeeRunway(op, sized.feeLimit);
      step = "prove";
      const proven = await this.backend.prove(sized);
      if (oxideFeeLimit(proven.evidence) !== sized.feeLimit) {
        throw new Error("the proven gas settings are not the ones the fee runway was checked against");
      }
      const recipientNote = proven.evidence.createdNotes[proven.evidence.recipientNoteIndex];
      if (
        recipientNote?.owner.toLowerCase() !== payout.recipient.toLowerCase() ||
        BigInt(recipientNote.amount) !== payout.amount
      ) {
        throw new UnexpectedTokenOperation("proven evidence does not name the payout note");
      }
      return proven;
    } catch (cause) {
      if (cause instanceof JournalWriteError || cause instanceof JournalUnreadableError) throw cause;
      console.error(`[oxide] ${step} failed: ${boundedErrorClass(cause)}`);
      if (cause instanceof InputsPending) throw new Answer(this.refuse(op, "inputs_pending", true));
      if (cause instanceof FeeRunwayRefused) throw new Answer(this.refuse(op, cause.reason, true));
      if (cause instanceof UnexpectedTokenOperation) throw new Answer(this.refuse(op, "token_operation_unexpected", false));
      if (cause instanceof EnclaveTrustRefused) {
        throw new Answer(this.refuse(op, `enclave_refused:${cause.reason}`, !enclaveRefusalPermanent(cause.reason)));
      }
      throw new Answer(this.refuse(op, `${step}_failed`, true));
    }
  }

  /**
   * Refuses unless the account's fee juice covers `feeLimit` on top of the fee
   * limits of every other attempt that may still land: the node reads the
   * balance without them until they are mined, so it would admit this send
   * and leave one of them unable to pay.
   */
  private async assertFeeRunway(op: OxideStoredOperation, feeLimit: bigint): Promise<void> {
    let observed: bigint;
    try {
      observed = await this.backend.feeJuiceBalance();
    } catch (cause) {
      throw new FeeRunwayRefused("fee_runway_unknown", `balance unread: ${(cause as Error).message ?? String(cause)}`);
    }
    const committed = this.journal.committedFees(this.nowSeconds(), op.operationId);
    if (observed < committed.total + feeLimit) {
      throw new FeeRunwayRefused(
        "fee_runway_low",
        `balance ${observed} below ${feeLimit} for this send plus ${committed.total} committed to ${committed.sends} other attempt(s)`,
      );
    }
  }

  /**
   * The fee runway read for the readiness surface: the balance, what other
   * attempts may still be charged, and the most one more send can cost.
   * Unknown when the node or the journal cannot be read.
   */
  async feeRunway(): Promise<ReadinessFact<OxideFeeRunway>> {
    try {
      const [observed, perSendFeeLimit] = await Promise.all([
        this.backend.feeJuiceBalance(),
        this.backend.maxSendFeeLimit(),
      ]);
      if (perSendFeeLimit <= 0n) throw new Error("non-positive per-send fee limit");
      const committed = this.journal.committedFees(this.nowSeconds(), "");
      return known({ observed, committed: committed.total, committedSends: committed.sends, perSendFeeLimit });
    } catch (cause) {
      console.error(`[oxide] Fee runway read failed: ${boundedErrorClass(cause)}`);
      return unknown("fee_runway_unknown");
    }
  }

  /**
   * The gate, for a fresh attempt or the exact bytes of an unmarked one. Only
   * an `allow` marks; the mark is the last durable step, then a synchronous
   * bound check, then the send with nothing awaited in between. Once `signal`
   * has aborted (the caller was answered) nothing marks: the attempt is held
   * `interrupted` and a later call resends these exact bytes.
   */
  private async broadcast(
    op: OxideStoredOperation,
    attempt: OxideAttempt,
    signal: AbortSignal | undefined,
  ): Promise<OxideSendAnswer> {
    const id = op.operationId;
    const bytes = this.journal.attemptBytes(id, attempt.attempt);
    // The bytes must still be the transaction the journal (and so the gate)
    // names: hash recomputed from the data, and the expiry inside them equal
    // to the journaled one the bound checks below read.
    try {
      assertJournaledIdentity(await this.backend.identify(bytes), attempt);
    } catch (cause) {
      if (!(cause instanceof JournaledBytesMismatch)) throw cause;
      console.error(`[oxide] Journaled transaction identity mismatch: ${boundedErrorClass(cause)}`);
      return this.answer(op, { state: "unknown", reason: "journaled_bytes_mismatch" });
    }
    if (signal?.aborted) return this.hold(id, attempt, "interrupted");
    const answer = await this.mayBroadcast({ operationId: id, fingerprint: op.fingerprint, txHash: attempt.txHash });

    // Synchronous from here to the mark.
    if (signal?.aborted) return this.hold(id, attempt, "interrupted");
    if (answer.decision !== "allow") {
      return this.hold(id, attempt, answer.decision === "deny" ? "may_broadcast_denied" : "may_broadcast_unknown");
    }
    // The portal and deployment can move while the transaction is being
    // proved or while the gate is deciding. Re-read after allow; once it
    // returns, the bounds, mark and send below are one synchronous run.
    try {
      await this.preflight.assertPinned();
    } catch (cause) {
      const refusal = preflightRefusal(cause);
      console.error(`[oxide] Preflight refused after allow: ${boundedErrorClass(cause)}`);
      if (!refusal.retryable) return this.refuse(op, refusal.reason, false);
      return this.hold(id, attempt, "preflight_refused");
    }
    if (this.nowSeconds() >= op.terms.validUntil) return this.refuse(op, "validity_bound_passed", false);
    if (BigInt(this.nowSeconds()) >= BigInt(attempt.expirationTimestamp)) {
      // The gate bound this hash; a fresh proof would carry another. Requote under a new operation id.
      return this.refuse(op, "expired_after_allow", false);
    }
    try {
      this.journal.markMayBroadcast(id, attempt.attempt, op.terms.amount, this.caps.config);
    } catch (cause) {
      if (!(cause instanceof CapExceeded)) throw cause;
      // The durable window is full. The attempt stays prepared and unmarked, so
      // a later call resends these exact bytes once spends age out.
      return this.hold(id, attempt, "cap_window_full");
    }
    this.caps.release(id);
    const marked = this.journal.get(id)!;
    const base = { txHash: attempt.txHash, expirationTimestamp: attempt.expirationTimestamp };
    // Final, synchronous bound check; the send is called in the same run.
    if (this.nowSeconds() >= op.terms.validUntil) {
      return this.answer(marked, { state: "submitted_unknown", ...base, reason: "validity_bound_passed" });
    }
    if (BigInt(this.nowSeconds()) >= BigInt(attempt.expirationTimestamp)) {
      return this.answer(marked, { state: "submitted_unknown", ...base, reason: "expiration_passed" });
    }
    let sending: Promise<void>;
    try {
      sending = this.backend.send(bytes);
    } catch (cause) {
      sending = Promise.reject(cause);
    }
    try {
      await sending;
    } catch (cause) {
      console.error(`[oxide] Send after mark failed: ${boundedErrorClass(cause)}`);
      return this.answer(marked, { state: "submitted_unknown", ...base, reason: "post_mark_failure" });
    }
    return this.answer(this.journal.get(id)!, await this.observe(marked));
  }

  /** A marked operation's observation, from the node only; records a changed mined outcome. */
  private async observe(op: OxideStoredOperation): Promise<OxideObservation> {
    const attempt = this.currentAttempt(op);
    if (!attempt) return { state: "unknown", reason: "missing_transaction_identity" };
    const base = { txHash: attempt.txHash, expirationTimestamp: attempt.expirationTimestamp };
    let node: NodeObservation;
    try {
      node = await this.backend.observe(attempt.txHash);
    } catch {
      return { state: "submitted_unknown", ...base, reason: "node_read_failed" };
    }
    switch (node.kind) {
      case "pending":
        return { state: "pending", ...base };
      case "dropped":
        // Absence from one node is not proof it never landed: unknown, never not_submitted.
        return { state: "submitted_unknown", ...base, reason: "node_reports_dropped_or_unknown" };
      case "mined": {
        const observation: OxideObservation = {
          state:
            node.executionResult === "reverted" ? "reverted" : node.receiptStatus === "finalized" ? "finalized" : "included",
          ...base,
          executionResult: node.executionResult,
          blockHash: node.blockHash,
          blockNumber: node.blockNumber,
          receiptStatus: node.receiptStatus,
          observedAt: this.nowSeconds(),
          effects: node.effects,
        };
        const previous = op.observation;
        const changed =
          previous === null ||
          !("observedAt" in previous) ||
          JSON.stringify({ ...previous, observedAt: 0 }) !== JSON.stringify({ ...observation, observedAt: 0 });
        if (!changed) return previous;
        // Without its effects the payout cannot be located (payoutNoteHashIndex),
        // and a recorded finalized outcome is never re-read: leave it to the
        // next read, which asks the node again.
        if (node.effects.state !== "available") return observation;
        try {
          this.journal.recordObservation(op.operationId, observation);
        } catch (cause) {
          // Best-effort: the mark is durable either way, and a read never fails on this write.
          console.error(`[oxide] Observation not recorded: ${boundedErrorClass(cause)}`);
        }
        return observation;
      }
    }
  }

  private currentAttempt(op: OxideStoredOperation): OxideAttempt | undefined {
    if (op.currentAttempt === null) return undefined;
    return this.journal.attempts(op.operationId).find((a) => a.attempt === op.currentAttempt);
  }

  private preparedObservation(attempt: OxideAttempt, hold: OxideHold): OxideObservation {
    return { state: "prepared", txHash: attempt.txHash, expirationTimestamp: attempt.expirationTimestamp, hold };
  }

  /** Records why the journaled, unmarked attempt is not sent now, and answers it as prepared. */
  private hold(id: string, attempt: OxideAttempt, hold: OxideHold): OxideSendAnswer {
    if (hold === "interrupted") console.warn(`[oxide] ${id} held: the caller was answered before the mark`);
    this.journal.recordHold(id, hold);
    return this.answer(this.journal.get(id)!, this.preparedObservation(attempt, hold));
  }

  private notSubmittedObservation(op: OxideStoredOperation): OxideObservation {
    return { state: "not_submitted", reason: op.reason ?? "not_submitted", retryable: op.retryable };
  }

  /** Records a definitive not_submitted (only from claimed/prepared) and answers it. */
  private refuse(op: OxideStoredOperation, reason: string, retryable: boolean): OxideSendAnswer {
    this.journal.recordNotSubmitted(op.operationId, reason, retryable);
    return this.answer(this.journal.get(op.operationId)!, { state: "not_submitted", reason, retryable });
  }

  private answer(op: OxideStoredOperation, observation: OxideObservation): OxideSendAnswer {
    const result: OxideSendAnswer = {
      kind: "observed",
      operationId: op.operationId,
      fingerprint: op.fingerprint,
      observation,
    };
    const attempt = this.currentAttempt(op);
    if (attempt) {
      const evidence = this.journal.attemptEvidence(op.operationId, attempt.attempt);
      const note = evidence.createdNotes[evidence.recipientNoteIndex]!;
      result.payout = {
        txHash: attempt.txHash,
        expirationTimestamp: attempt.expirationTimestamp,
        noteRandomness: note.randomness,
        noteIndex: evidence.recipientNoteIndex,
        siloedNoteHash: evidence.teeNotes[evidence.recipientNoteIndex]!,
      };
    }
    return result;
  }
}
