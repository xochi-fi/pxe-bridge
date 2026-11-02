import { JournalUnreadableError, JournalWriteError } from "../journal.js";
import type { MayBroadcastClient } from "../may-broadcast.js";
import type { NodeObservation } from "../settlement.js";
import { CapExceeded, OxideCaps, type OxideCapsConfig } from "./caps.js";
import { EnclaveTrustRefused } from "./enclave.js";
import type { OxideAttempt, OxideJournal, OxideStoredOperation } from "./journal.js";
import {
  fingerprintOxideTerms,
  OxideSendRequestSchema,
  oxideTerms,
  type OxideHold,
  type OxideObservation,
  type OxideSendEvidence,
  type OxideTerms,
} from "./operation.js";
import { OxidePinMismatch, OXIDE_V6_MAINNET } from "./pins.js";
import { MAX_TX_LIFETIME } from "@aztec-labs/constants";

/**
 * The Oxide sender (xochi-fi/pxe-bridge#84, phase 1): pays OXDAI to an Aztec
 * recipient through Oxide's enclave-signed `transfer` + `publish_da`, on the
 * bridge's standard Schnorr account, with the createNote journal's rules
 * (src/oxide/journal.ts) so a restart at any step never pays twice.
 *
 *   admission -> simulate -> check the TokenOperation -> enclave sign -> prove
 *   -> journal the proven tx -> may-broadcast -> mark (+ cap re-check) -> send
 *
 * `OxideSender.send` is the internal API the settlement layer will call. It
 * serves under `pxe-bridge.settlement.v2` with an Oxide rail tag (decided on
 * #84 / Riddler#1428); this PR does not wire it. Its answer carries what that
 * wiring needs: the tx hash, the protocol expiry (journaled as its own bound,
 * required >= `validUntil`) and the payout note's randomness and index.
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
  /** Backend-private state carried to `sign`. */
  handle: unknown;
}

export interface OxideSigned {
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
  prove(signed: OxideSigned): Promise<OxideProvenTx>;
  /**
   * The hash and protocol expiry a node gives `txBytes`, recomputed from the
   * transaction's data (never the stored hash prefix alone). Throws
   * `JournaledBytesInvalid` when the bytes do not hash to their own data.
   */
  identify(txBytes: Buffer): Promise<OxideTxIdentity>;
  send(txBytes: Buffer): Promise<void>;
  observe(txHash: string): Promise<NodeObservation>;
}

/** Re-verified before every fresh attempt: the Oxide manifest/profile pins, the L1 deployment. */
export interface OxidePreflight {
  assertPinned(): Promise<void>;
}

/** What a send answers: the observation, plus the payout's identity once an attempt exists. */
export interface OxideSendAnswer {
  kind: "observed";
  operationId: string;
  fingerprint: string;
  observation: OxideObservation;
  /** Present once a proven transaction is journaled for the operation. */
  payout?: OxidePayoutIdentity;
}

export interface OxidePayoutIdentity {
  txHash: string;
  expirationTimestamp: string;
  /** Randomness of the recipient's note: with (recipient, amount) it opens the signed note hash. Never log it. */
  noteRandomness: string;
  /** Position of the recipient's note among the TokenOperation's created notes. */
  noteIndex: number;
  /** The siloed note hash the enclave signed for it. */
  siloedNoteHash: string;
}

export interface OxideTxIdentity {
  /** 0x, lowercase. */
  txHash: string;
  expirationTimestamp: bigint;
}

/** Journaled bytes that are not a transaction the node would accept as the journaled one. */
export class JournaledBytesInvalid extends Error {
  constructor(detail: string) {
    super(`Journaled Oxide tx bytes refused: ${detail}`);
    this.name = "JournaledBytesInvalid";
  }
}

export type OxideSendOutcome =
  | OxideSendAnswer
  | { kind: "conflict"; operationId: string; fingerprint: string; storedFingerprint: string }
  | { kind: "journal_unavailable"; operationId: string; detail: string };

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

export interface OxideSenderOptions {
  journal: OxideJournal;
  backend: OxideBackend;
  caps: OxideCapsConfig;
  preflight: OxidePreflight;
  /** The broadcast gate: only an exact `allow` marks. Riddler's may-broadcast once wired. */
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
  private readonly mayBroadcast: MayBroadcastClient;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  /** Fresh attempts run simulate -> recordPrepared one at a time (see `fresh`). */
  private laneTail: Promise<void> = Promise.resolve();

  constructor(options: OxideSenderOptions) {
    this.journal = options.journal;
    this.backend = options.backend;
    this.preflight = options.preflight;
    this.mayBroadcast = options.mayBroadcast;
    this.now = options.now ?? Date.now;
    this.caps = new OxideCaps(options.caps, (since) => this.journal.spentSince(since), this.now);
  }

  /**
   * Pays `{recipient, amount, orderFingerprint}` once for `operationId`, or
   * reports what that operation already is. Throws only on a malformed request.
   */
  async send(input: {
    recipient: string;
    amount: string;
    orderFingerprint: string;
    operationId: string;
    validUntil: number;
  }): Promise<OxideSendOutcome> {
    const request = OxideSendRequestSchema.parse(input);
    const terms = oxideTerms(request, OXIDE_V6_MAINNET.bridge.l2Token);
    const id = request.operationId;
    if (this.inFlight.has(id)) {
      return {
        kind: "observed",
        operationId: id,
        fingerprint: fingerprintOxideTerms(terms),
        observation: { state: "request_in_flight" },
      };
    }
    this.inFlight.add(id);
    try {
      return await this.drive(id, terms);
    } catch (cause) {
      if (cause instanceof Answer) return cause.answer;
      if (cause instanceof JournalWriteError || cause instanceof JournalUnreadableError) {
        return { kind: "journal_unavailable", operationId: id, detail: cause.message };
      }
      throw cause;
    } finally {
      this.caps.release(id);
      this.inFlight.delete(id);
    }
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private async drive(id: string, terms: OxideTerms): Promise<OxideSendOutcome> {
    const claim = this.journal.claim(id, terms);
    if (claim.kind === "conflict") {
      return {
        kind: "conflict",
        operationId: id,
        fingerprint: fingerprintOxideTerms(terms),
        storedFingerprint: claim.operation.fingerprint,
      };
    }
    const op = claim.operation;
    if (claim.kind === "existing") {
      const resumed = await this.resume(op);
      if (resumed) return resumed;
    }
    return this.fresh(this.journal.get(id)!);
  }

  /** An operation the journal already holds. Undefined when it provably never broadcast and was re-armed. */
  private async resume(op: OxideStoredOperation): Promise<OxideSendAnswer | undefined> {
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
          console.error(`[oxide] Preflight refused a held attempt: ${(cause as Error).message}`);
          this.journal.recordHold(op.operationId, "preflight_refused");
          return this.answer(this.journal.get(op.operationId)!, this.preparedObservation(attempt, "preflight_refused"));
        }
        return this.broadcast(op, attempt);
      }
    }
  }

  private async fresh(op: OxideStoredOperation): Promise<OxideSendAnswer> {
    const { terms, operationId: id } = op;
    if (this.nowSeconds() >= terms.validUntil) return this.refuse(op, "validity_bound_passed", false);
    const payout: OxidePayout = {
      recipient: terms.recipient,
      amount: BigInt(terms.amount),
      orderFingerprint: terms.orderFingerprint,
    };

    try {
      this.caps.admit(id, payout.amount);
    } catch (cause) {
      if (!(cause instanceof CapExceeded)) throw cause;
      return this.refuse(op, `cap:${cause.reason}`, cause.reason === "daily_cap_exhausted");
    }

    try {
      await this.preflight.assertPinned();
    } catch (cause) {
      const reason =
        cause instanceof OxidePinMismatch
          ? "oxide_pin_mismatch"
          : cause instanceof EnclaveTrustRefused
            ? `enclave_refused:${cause.reason}`
            : "oxide_pin_unverified";
      console.error(`[oxide] Preflight refused: ${(cause as Error).message}`);
      return this.refuse(op, reason, true);
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
    return this.broadcast(this.journal.get(id)!, recorded);
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

  /** simulate -> check -> sign -> prove. Any failure here provably sent nothing. */
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
      step = "sign";
      const signed = await this.backend.sign(simulation);
      step = "prove";
      const proven = await this.backend.prove(signed);
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
      console.error(`[oxide] ${step} failed: ${(cause as Error).message ?? String(cause)}`);
      if (cause instanceof InputsPending) throw new Answer(this.refuse(op, "inputs_pending", true));
      if (cause instanceof UnexpectedTokenOperation) throw new Answer(this.refuse(op, "token_operation_unexpected", false));
      if (cause instanceof EnclaveTrustRefused) throw new Answer(this.refuse(op, `enclave_refused:${cause.reason}`, true));
      throw new Answer(this.refuse(op, `${step}_failed`, true));
    }
  }

  /**
   * The gate, for a fresh attempt or the exact bytes of an unmarked one. Only
   * an `allow` marks; the mark is the last durable step, then a synchronous
   * bound check, then the send with nothing awaited in between.
   */
  private async broadcast(op: OxideStoredOperation, attempt: OxideAttempt): Promise<OxideSendAnswer> {
    const id = op.operationId;
    const bytes = this.journal.attemptBytes(id, attempt.attempt);
    // The bytes must still be the transaction the journal (and so the gate)
    // names: hash recomputed from the data, and the expiry inside them equal
    // to the journaled one the bound checks below read.
    let identity: OxideTxIdentity | null = null;
    try {
      identity = await this.backend.identify(bytes);
    } catch (cause) {
      if (!(cause instanceof JournaledBytesInvalid)) throw cause;
      console.error(`[oxide] Journaled bytes of ${id} attempt ${attempt.attempt}: ${cause.message}`);
    }
    if (
      identity === null ||
      identity.txHash !== attempt.txHash.toLowerCase() ||
      identity.expirationTimestamp.toString() !== attempt.expirationTimestamp
    ) {
      console.error(`[oxide] Journaled bytes of ${id} attempt ${attempt.attempt} are not the journaled transaction`);
      return this.answer(op, { state: "unknown", reason: "journaled_bytes_mismatch" });
    }
    const answer = await this.mayBroadcast({ operationId: id, fingerprint: op.fingerprint, txHash: attempt.txHash });
    if (answer.decision !== "allow") {
      const hold: OxideHold = answer.decision === "deny" ? "may_broadcast_denied" : "may_broadcast_unknown";
      this.journal.recordHold(id, hold);
      return this.answer(this.journal.get(id)!, this.preparedObservation(attempt, hold));
    }
    // Synchronous from here to the mark.
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
      this.journal.recordHold(id, "cap_window_full");
      return this.answer(this.journal.get(id)!, this.preparedObservation(attempt, "cap_window_full"));
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
      console.error(`[oxide] Send after mark failed: ${(cause as Error).message ?? String(cause)}`);
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
        try {
          this.journal.recordObservation(op.operationId, observation);
        } catch (cause) {
          // Best-effort: the mark is durable either way, and a read never fails on this write.
          console.error(`[oxide] Observation not recorded: ${(cause as Error).message}`);
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
