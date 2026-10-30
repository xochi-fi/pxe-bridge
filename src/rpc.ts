import {
  JsonRpcRequestSchema,
  RPC_ERRORS,
  SUBMITTED_UNKNOWN_MESSAGE,
  type BroadcastGate,
  type IAztecClient,
  type JsonRpcResponse,
  type PreparedTransaction,
  type TransferOutcome,
} from "./types.js";
import {
  CreateNoteV1Schema,
  GetSettlementSchema,
  SETTLEMENT_VERSION,
  fingerprintTerms,
  isLegacyCreateNoteParams,
  termsFrom,
  type CorridorConfig,
  type CreateNoteV1,
  type NodeObservation,
  type Observation,
  type SettlementTerms,
} from "./settlement.js";
import {
  JournalUnreadableError,
  JournalWriteError,
  type Attempt,
  type Hold,
  type JournalHealth,
  type SettlementJournal,
  type StoredOperation,
} from "./journal.js";
import type { MayBroadcastClient } from "./may-broadcast.js";
import type { TransactionLimits } from "./limits.js";
import type { AuditLogger } from "./audit.js";
import type { OperationalReadiness, ReadinessObserver, ReadinessReason } from "./readiness.js";

export interface SettlementContext {
  journal: SettlementJournal;
  /** Unset refuses every createNote: there is nobody to ask. */
  mayBroadcast: MayBroadcastClient | undefined;
  /** Unset refuses every createNote: no corridor is approved. */
  corridor: CorridorConfig | undefined;
  /** Operations this process is driving right now. */
  inFlight: Set<string>;
  /**
   * Bounds one createNote from the moment it is handled: admission, cooldown,
   * proving and the may-broadcast query all spend it, and when it passes the
   * gate closes. Default TX deadline.
   */
  timeoutMs: number;
  /** Same instance exposed by authenticated GET /ready. */
  readiness?: ReadinessObserver | undefined;
  now?: () => number;
}

export interface RpcContext {
  limits?: TransactionLimits | undefined;
  audit?: AuditLogger | undefined;
  settlement?: SettlementContext | undefined;
  /** The same authoritative observer served by authenticated GET /ready. */
  readiness?: ReadinessObserver | undefined;
  /** From the `Idempotency-Key` request header, when the caller sent one. */
  idempotencyKey?: string | undefined;
  /**
   * Aborted when the HTTP response deadline answers the caller (504). Closes
   * the gate synchronously, before the 504 is written, so nothing this
   * request started can be marked may-broadcast after the caller gave up.
   */
  signal?: AbortSignal | undefined;
  /** Keeps the server's global backend-work lease until `call` actually settles. */
  trackBackground?: ((call: Promise<unknown>) => void) | undefined;
}

function success(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export async function handleRpcRequest(
  body: unknown,
  client: IAztecClient,
  ctx: RpcContext = {},
): Promise<JsonRpcResponse> {
  const parsed = JsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) {
    return rpcError(null, RPC_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC request");
  }

  const { id, method, params } = parsed.data;

  switch (method) {
    case "aztec_createNote":
      return handleCreateNote(id, params, client, ctx);
    case "aztec_getSettlement":
      return handleGetSettlement(id, params, client, ctx);
    case "aztec_getVersion":
      return handleGetVersion(id, client);
    default:
      return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TIMED_OUT = Symbol("timed-out");

/**
 * The one deadline of a createNote (pxe-bridge#45 review): started before
 * admission and cooldown, not after them, so a request cannot outlive the
 * HTTP response deadline and mark after its caller was answered. It passes on
 * the first of `ms` elapsing and `signal` aborting, and passing closes the
 * attempt's gate synchronously -- the gate is the only thing that marks.
 */
class RequestDeadline {
  expired = false;
  private gate: { close(): void } | undefined;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly passed: Promise<typeof TIMED_OUT>;
  private readonly onAbort: () => void;

  constructor(
    ms: number,
    private readonly signal: AbortSignal | undefined,
  ) {
    let resolve: (value: typeof TIMED_OUT) => void = () => undefined;
    this.passed = new Promise((r) => (resolve = r));
    this.onAbort = () => {
      if (this.expired) return;
      this.expired = true;
      this.gate?.close();
      resolve(TIMED_OUT);
    };
    this.timer = setTimeout(this.onAbort, ms);
    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Closes `gate` the moment the deadline passes (now, if it has). */
  guard(gate: { close(): void }): void {
    this.gate = gate;
    if (this.expired) gate.close();
  }

  /** Races `promise` against the deadline; the promise keeps running either way. */
  race<T>(promise: Promise<T>): Promise<T | typeof TIMED_OUT> {
    return Promise.race([promise, this.passed]);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}

function journalHealthWire(health: JournalHealth): Record<string, unknown> {
  return health.writable
    ? { writable: true }
    : { writable: false, reason: health.reason, detail: health.detail };
}

function journalUnavailable(
  id: number | string,
  health: JournalHealth | { writable: false; reason: string; detail: string },
  operationId?: string,
): JsonRpcResponse {
  return rpcError(id, RPC_ERRORS.JOURNAL_UNAVAILABLE, "Settlement journal unavailable", {
    ...(operationId !== undefined ? { operationId } : {}),
    journal: journalHealthWire(health as JournalHealth),
  });
}

/** Stopped before the gate's may-broadcast mark, deliberately. */
class Held extends Error {
  constructor(readonly observation: Observation) {
    super(`held: ${observation.state}`);
  }
}

/** The caller already answered; nothing may broadcast on this path now. */
class GateClosed extends Error {}

interface DriveState {
  op: StoredOperation;
  fingerprint: string;
  terms: SettlementTerms;
}

/**
 * `fresh` proves a new attempt; `resume` re-asks for a journaled, unmarked
 * attempt. A marked attempt is observation-only: absence from one node is
 * never proof that the transaction did not reach another node or a prior fork.
 */
type GateMode = { kind: "fresh" } | { kind: "resume"; attempt: Attempt };

/**
 * The per-attempt broadcast gate: journal the exact transaction, ask Riddler,
 * mark may-broadcast, in that order, each step durable before the next; then
 * a synchronous final step right before the node is called.
 *
 * `close()` is synchronous and checked synchronously right before the mark,
 * so once the caller has answered (timeout), a proof that finishes later
 * cannot broadcast: the only thing that permits a broadcast is a mark that a
 * closed gate never writes.
 *
 * The bounds (`validUntil`, the attempt's protocol expiration) are checked
 * last in `beforeSend`, which the client calls with no `await` between it and
 * `sendTx`: the mark is an fsync and the client awaits after the gate, so a
 * check made before either is stale by the time the node is called.
 */
class OperationGate implements BroadcastGate {
  closed = false;
  marked = false;
  attempt: Attempt | undefined;

  constructor(
    private readonly s: SettlementContext,
    private readonly state: DriveState,
    private readonly mode: GateMode,
    private readonly onMark: () => void,
  ) {
    if (mode.kind !== "fresh") this.attempt = mode.attempt;
  }

  close(): void {
    this.closed = true;
  }

  async beforeBroadcast(tx: PreparedTransaction): Promise<void> {
    if (this.closed) throw new GateClosed();
    const { journal } = this.s;
    const operationId = this.state.op.operationId;

    if (this.mode.kind !== "fresh") {
      if (tx.txHash.toLowerCase() !== this.mode.attempt.txHash) {
        throw new Error("journaled bytes no longer produce the journaled hash");
      }
      // An unmarked prepared attempt re-asks Riddler for the same hash before
      // its exact bytes can be sent.
    } else {
      const attempt = journal.recordPrepared(operationId, tx);
      this.attempt = {
        attempt,
        txHash: tx.txHash.toLowerCase(),
        expirationTimestamp: tx.expirationTimestamp.toString(),
        preparedAt: Date.now(),
        mayBroadcastAt: null,
      };
    }
    const attempt = this.attempt!;

    // Before asking: nothing is bound at Riddler yet, so an attempt past its
    // protocol expiration can simply be proven again.
    this.refuseUnmarkedPastBound(attempt, false);

    const answer = await this.s.mayBroadcast!({
      operationId,
      fingerprint: this.state.fingerprint,
      txHash: attempt.txHash,
    });
    // Synchronous from here to the mark: nothing can close the gate between
    // this check and the write that permits the broadcast.
    if (this.closed) throw new GateClosed();
    if (answer.decision !== "allow") {
      const hold: Hold =
        answer.decision === "deny" ? "may_broadcast_denied" : "may_broadcast_unknown";
      console.warn(`[rpc] Settlement held before may-broadcast: ${answer.decision}`);
      journal.recordHold(operationId, hold);
      throw new Held({
        state: "prepared",
        txHash: attempt.txHash,
        expirationTimestamp: attempt.expirationTimestamp,
        hold,
      });
    }
    // The may-broadcast wait can outlast either bound. Riddler has now bound
    // this txHash, so an expired attempt cannot be replaced under this
    // operation: a fresh proof has a new hash, which Riddler denies.
    this.refuseUnmarkedPastBound(attempt, true);
    journal.markMayBroadcast(operationId, attempt.attempt, this.state.terms.amount);
    this.marked = true;
    this.onMark();
  }

  /**
   * The final step, synchronous, immediately before the client calls
   * `sendTx`. Past either bound the marked attempt is not sent; it was
   * marked, so it surfaces as submitted_unknown, never not_submitted.
   */
  beforeSend(tx: PreparedTransaction): void {
    const attempt = this.attempt;
    if (!this.marked || !attempt || tx.txHash.toLowerCase() !== attempt.txHash) {
      throw new Error("send without a may-broadcast mark for this transaction");
    }
    const passed = this.passedBound(attempt);
    if (passed) throw new BoundPassed(passed);
  }

  /** Which bound has passed for `attempt`, if any, at this instant. */
  private passedBound(attempt: Attempt): Bound | undefined {
    const now = nowSeconds(this.s);
    if (now >= this.state.terms.validUntil) return "validity_bound_passed";
    if (BigInt(now) >= BigInt(attempt.expirationTimestamp)) return "expiration_passed";
    return undefined;
  }

  /**
   * An unmarked attempt past a bound provably never broadcast, so it is
   * recorded not_submitted. Past `validUntil` it is final (revalidate). Past
   * the protocol expiration it is retryable only while Riddler has not
   * allowed it; after an `allow` it is `expired_after_allow`, final for this
   * operation id: requote under a new one.
   */
  private refuseUnmarkedPastBound(attempt: Attempt, allowed: boolean): void {
    const passed = this.passedBound(attempt);
    if (!passed) return;
    const reason = passed === "expiration_passed" && allowed ? "expired_after_allow" : passed;
    const retryable = reason === "expiration_passed";
    this.s.journal.recordNotSubmitted(this.state.op.operationId, reason, retryable);
    throw new Held({ state: "not_submitted", reason, retryableAfterRevalidation: retryable });
  }
}

type Bound = "validity_bound_passed" | "expiration_passed";

/** A marked attempt reached the send past one of its bounds; nothing was sent. */
class BoundPassed extends Error {
  constructor(readonly bound: Bound) {
    super(`marked attempt not sent: ${bound}`);
  }
}

function nowSeconds(s: SettlementContext): number {
  return Math.floor((s.now ?? Date.now)() / 1000);
}

/**
 * Turns what the node said into the wire observation, in the journal's
 * context. Effects stay uninterpreted evidence: no element is "the" note.
 */
function observationFrom(attempt: Attempt, node: NodeObservation, now: number): Observation {
  const base = { txHash: attempt.txHash, expirationTimestamp: attempt.expirationTimestamp };
  switch (node.kind) {
    case "pending":
      return { state: "pending", ...base };
    case "dropped":
      // The node not knowing a hash is not evidence it never landed or never
      // will: an unfinalized branch can restore it, and another node may hold
      // it. Unknown, never "not submitted".
      return { state: "submitted_unknown", ...base, reason: "node_reports_dropped_or_unknown" };
    case "mined":
      return {
        state:
          node.executionResult === "reverted"
            ? "reverted"
            : node.receiptStatus === "finalized"
              ? "finalized"
              : "included",
        ...base,
        executionResult: node.executionResult,
        blockHash: node.blockHash,
        blockNumber: node.blockNumber,
        receiptStatus: node.receiptStatus,
        observedAt: Math.floor(now / 1000),
        effects: node.effects,
      };
  }
}

type MinedObservation = Extract<Observation, { observedAt: number }>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameCanonicalOutcome(left: MinedObservation, right: MinedObservation): boolean {
  return (
    left.state === right.state &&
    left.txHash === right.txHash &&
    left.expirationTimestamp === right.expirationTimestamp &&
    left.executionResult === right.executionResult &&
    left.blockHash === right.blockHash &&
    left.blockNumber === right.blockNumber &&
    left.receiptStatus === right.receiptStatus &&
    left.effects.state === right.effects.state &&
    sameStrings(left.effects.noteHashes, right.effects.noteHashes) &&
    sameStrings(left.effects.nullifiers, right.effects.nullifiers)
  );
}

function currentAttempt(journal: SettlementJournal, op: StoredOperation): Attempt | undefined {
  if (op.currentAttempt === null) return undefined;
  return journal.attempts(op.operationId).find((a) => a.attempt === op.currentAttempt);
}

/**
 * The operation's observation, reading the node only for a marked operation.
 * Records a finalized outcome durably when the journal is writable; a read
 * never fails because that write could not happen.
 */
async function observe(
  s: SettlementContext,
  client: IAztecClient,
  op: StoredOperation,
): Promise<Observation> {
  switch (op.state) {
    case "claimed":
      return {
        state: "not_submitted",
        reason: "interrupted_before_prepare",
        retryableAfterRevalidation: true,
      };
    case "not_submitted":
      return {
        state: "not_submitted",
        reason: op.reason ?? "not_submitted",
        retryableAfterRevalidation: op.retryable,
      };
    case "finalized":
    case "reverted":
      if (op.observation) return op.observation;
      return { state: "unknown", reason: "terminal_observation_missing" };
    case "prepared": {
      const attempt = currentAttempt(s.journal, op);
      if (!attempt) return { state: "unknown", reason: "missing_transaction_identity" };
      return {
        state: "prepared",
        txHash: attempt.txHash,
        expirationTimestamp: attempt.expirationTimestamp,
        hold: op.hold ?? "interrupted",
      };
    }
    case "may_broadcast": {
      const attempt = currentAttempt(s.journal, op);
      if (!attempt) return { state: "unknown", reason: "missing_transaction_identity" };
      let node: NodeObservation;
      try {
        node = await client.observeTx(attempt.txHash);
      } catch {
        console.error("[rpc] Settlement node observation failed");
        return {
          state: "submitted_unknown",
          txHash: attempt.txHash,
          expirationTimestamp: attempt.expirationTimestamp,
          reason: "node_read_failed",
        };
      }
      let observation = observationFrom(attempt, node, (s.now ?? Date.now)());
      let unchanged = false;
      if (
        "observedAt" in observation &&
        op.observation != null &&
        "observedAt" in op.observation &&
        sameCanonicalOutcome(op.observation, observation)
      ) {
        observation = { ...observation, observedAt: op.observation.observedAt };
        unchanged = true;
      }
      // Reads record a finalized outcome, and a mined outcome the journal does
      // not hold yet, so an unchanged outcome keeps its first observedAt across
      // polls and restarts without a write per poll.
      if (
        observation.state === "finalized" ||
        observation.state === "reverted" ||
        ("observedAt" in observation && !unchanged)
      ) {
        recordObservation(s, op.operationId, observation);
      }
      return observation;
    }
  }
}

/** Best-effort, never decides the answer: the mark is already durable. */
function recordObservation(s: SettlementContext, operationId: string, observation: Observation): void {
  if (!s.journal.health().writable) return;
  try {
    if (
      (observation.state === "finalized" || observation.state === "reverted") &&
      observation.receiptStatus === "finalized"
    ) {
      s.journal.recordTerminal(operationId, observation);
    } else if (observation.state !== "request_in_flight") {
      s.journal.recordObservation(operationId, observation);
    }
  } catch {
    console.error("[rpc] Could not durably record settlement observation");
  }
}

/** The wire answer for an observation of operation `op`. */
function answer(
  id: number | string,
  op: { operationId: string; fingerprint: string },
  observation: Observation,
): JsonRpcResponse {
  const ident = { operationId: op.operationId, fingerprint: op.fingerprint };
  switch (observation.state) {
    case "pending":
    case "included":
    case "finalized":
    case "reverted":
      return success(id, { version: SETTLEMENT_VERSION, ...ident, observation });
    case "request_in_flight":
      return rpcError(
        id,
        RPC_ERRORS.REQUEST_IN_FLIGHT,
        "A request with this Idempotency-Key is still in flight",
        { ...ident, observation },
      );
    case "submitted_unknown":
      return rpcError(id, RPC_ERRORS.SUBMITTED_UNKNOWN, SUBMITTED_UNKNOWN_MESSAGE, {
        ...ident,
        txHash: observation.txHash,
        observation,
      });
    case "prepared":
    case "not_submitted":
      return rpcError(id, RPC_ERRORS.NOT_SUBMITTED, "Operation not submitted", {
        ...ident,
        observation,
      });
    case "unknown":
      return rpcError(id, RPC_ERRORS.SUBMITTED_UNKNOWN, SUBMITTED_UNKNOWN_MESSAGE, {
        ...ident,
        observation,
      });
  }
}

async function handleCreateNote(
  id: number | string,
  params: unknown[],
  client: IAztecClient,
  ctx: RpcContext,
): Promise<JsonRpcResponse> {
  const first = params[0];
  if (isLegacyCreateNoteParams(first)) {
    return rpcError(
      id,
      RPC_ERRORS.INVALID_PARAMS,
      `Legacy aztec_createNote params are refused; send a ${SETTLEMENT_VERSION} operation`,
      { reason: "legacy_params_refused" },
    );
  }
  const parsed = CreateNoteV1Schema.safeParse(first);
  if (!parsed.success || params.length !== 1) {
    console.error("[rpc] Invalid createNote params");
    return rpcError(id, RPC_ERRORS.INVALID_PARAMS, "Invalid params for aztec_createNote");
  }
  const s = ctx.settlement;
  if (!s) {
    return journalUnavailable(id, {
      writable: false,
      reason: "journal_unconfigured",
      detail: "PXE_BRIDGE_JOURNAL is not set",
    });
  }
  const deadline = new RequestDeadline(s.timeoutMs, ctx.signal);
  try {
    return await createNoteWithin(id, parsed.data, client, ctx, s, deadline);
  } finally {
    deadline.dispose();
  }
}

async function createNoteWithin(
  id: number | string,
  params: CreateNoteV1,
  client: IAztecClient,
  ctx: RpcContext,
  s: SettlementContext,
  deadline: RequestDeadline,
): Promise<JsonRpcResponse> {
  const operationId = params.operationId;
  // The operation id IS the idempotency key, so a delivery attempt cannot be
  // replayed under a different operation, or two operations under one key.
  if (ctx.idempotencyKey !== operationId) {
    return rpcError(id, RPC_ERRORS.INVALID_PARAMS, "Idempotency-Key must equal operationId", {
      reason: "operation_id_mismatch",
    });
  }

  const terms = termsFrom(params);
  const fingerprint = fingerprintTerms(terms);

  const health = s.journal.health();
  if (!health.writable) {
    let existing: StoredOperation | undefined;
    try {
      existing = s.journal.get(operationId);
    } catch (cause) {
      return journalFault(id, s, operationId, cause);
    }
    if (!existing) return journalUnavailable(id, health, operationId);
    if (existing.fingerprint !== fingerprint) {
      return conflict(id, operationId, fingerprint, existing.fingerprint);
    }
    if (
      existing.state !== "may_broadcast" &&
      existing.state !== "finalized" &&
      existing.state !== "reverted"
    ) {
      return journalUnavailable(id, health, operationId);
    }
    if (s.inFlight.has(operationId)) {
      return answer(id, existing, { state: "request_in_flight" });
    }
    s.inFlight.add(operationId);
    const background = new BackgroundCalls(ctx.trackBackground);
    try {
      const resumed = await resumeExisting(
        id,
        client,
        ctx,
        s,
        existing,
        background,
        deadline,
      );
      return resumed ?? journalUnavailable(id, health, operationId);
    } finally {
      background.whenIdle(() => s.inFlight.delete(operationId));
    }
  }

  // Synchronous from the check to the add: two concurrent duplicates cannot
  // both get past here.
  if (s.inFlight.has(operationId)) {
    let stored: StoredOperation | undefined;
    try {
      stored = s.journal.get(operationId);
    } catch {
      stored = undefined;
    }
    if (stored && stored.fingerprint !== fingerprint) {
      return conflict(id, operationId, fingerprint, stored.fingerprint);
    }
    return answer(id, { operationId, fingerprint }, { state: "request_in_flight" });
  }
  s.inFlight.add(operationId);

  // The claim is released only once the request has answered AND every client
  // call it started has settled: a call that outlived its deadline is still
  // proving, and a retry must see "in flight" until it stops.
  const background = new BackgroundCalls(ctx.trackBackground);
  try {
    return await driveOperation(id, client, ctx, s, operationId, fingerprint, terms, background, deadline);
  } finally {
    background.whenIdle(() => s.inFlight.delete(operationId));
  }
}

/** Client calls a request started, counted until each settles. */
class BackgroundCalls {
  private pending = 0;
  private onIdle: (() => void) | undefined;

  constructor(private readonly trackForRequest?: (call: Promise<unknown>) => void) {}

  track(call: Promise<unknown>): void {
    this.trackForRequest?.(call);
    this.pending += 1;
    const settled = (): void => {
      this.pending -= 1;
      if (this.pending === 0) this.onIdle?.();
    };
    call.then(settled, settled);
  }

  whenIdle(fn: () => void): void {
    if (this.pending === 0) fn();
    else this.onIdle = fn;
  }
}

function conflict(
  id: number | string,
  operationId: string,
  fingerprint: string,
  storedFingerprint: string,
): JsonRpcResponse {
  return rpcError(
    id,
    RPC_ERRORS.OPERATION_CONFLICT,
    "Operation id already names different terms",
    { operationId, fingerprint, storedFingerprint },
  );
}

async function driveOperation(
  id: number | string,
  client: IAztecClient,
  ctx: RpcContext,
  s: SettlementContext,
  operationId: string,
  fingerprint: string,
  terms: SettlementTerms,
  background: BackgroundCalls,
  deadline: RequestDeadline,
): Promise<JsonRpcResponse> {
  let op: StoredOperation;
  try {
    const claim = s.journal.claim(operationId, fingerprint, terms);
    if (claim.kind === "conflict") {
      return conflict(id, operationId, fingerprint, claim.operation.fingerprint);
    }
    op = claim.operation;
    if (claim.kind === "existing") {
      const resumed = await resumeExisting(id, client, ctx, s, op, background, deadline);
      if (resumed) return resumed;
      op = s.journal.get(operationId)!;
    }
  } catch (cause) {
    return journalFault(id, s, operationId, cause);
  }

  const refusal = await admissionRefusal(ctx, s, terms, deadline);
  if (refusal) {
    return refusal.kind === "not_ready"
      ? notReady(id, ctx, s, op, fingerprint, refusal)
      : notSubmitted(id, ctx, s, op, fingerprint, refusal.reason, true);
  }

  return runAttempt(id, client, ctx, s, { op, fingerprint, terms }, { kind: "fresh" }, background, deadline);
}

/**
 * Handles an operation the journal already holds. Returns the answer, or
 * undefined when the operation provably never broadcast and has been
 * re-armed for a fresh attempt.
 */
async function resumeExisting(
  id: number | string,
  client: IAztecClient,
  ctx: RpcContext,
  s: SettlementContext,
  op: StoredOperation,
  background: BackgroundCalls,
  deadline: RequestDeadline,
): Promise<JsonRpcResponse | undefined> {
  const state = { op, fingerprint: op.fingerprint, terms: op.terms };
  switch (op.state) {
    case "finalized":
    case "reverted":
      return answer(id, op, op.observation ?? { state: "unknown", reason: "terminal_observation_missing" });

    case "not_submitted":
      if (!op.retryable) return answer(id, op, await observe(s, client, op));
      s.journal.reclaim(op.operationId);
      return undefined;

    case "claimed":
      // Interrupted before anything was prepared: nothing can have broadcast.
      s.journal.reclaim(op.operationId);
      return undefined;

    case "prepared": {
      const attempt = currentAttempt(s.journal, op);
      if (!attempt) return answer(id, op, { state: "unknown", reason: "missing_transaction_identity" });
      if (nowSeconds(s) >= op.terms.validUntil) {
        return notSubmitted(id, ctx, s, op, op.fingerprint, "validity_bound_passed", false);
      }
      if (BigInt(nowSeconds(s)) >= BigInt(attempt.expirationTimestamp)) {
        // Never marked, and the protocol now refuses it: safe to abandon and
        // prepare a new attempt under the same operation.
        return undefined;
      }
      // Already admitted: recovery is not gated on admission readiness, only
      // on facts that make this exact transaction unsendable or certain to fail.
      const hold = await preparedHoldReasons(ctx, s, op.terms, deadline);
      if (hold.length > 0) {
        return notReady(id, ctx, s, op, op.fingerprint, { kind: "not_ready", reasons: hold });
      }
      return runAttempt(id, client, ctx, s, state, { kind: "resume", attempt }, background, deadline);
    }

    case "may_broadcast": {
      const attempt = currentAttempt(s.journal, op);
      if (!attempt) return answer(id, op, { state: "unknown", reason: "missing_transaction_identity" });
      const observationCall = observe(s, client, op);
      background.track(observationCall);
      const observed = await deadline.race(observationCall);
      const observation: Observation =
        observed === TIMED_OUT
          ? {
              state: "submitted_unknown",
              txHash: attempt.txHash,
              expirationTimestamp: attempt.expirationTimestamp,
              reason: "response_deadline",
            }
          : observed;
      return answer(id, op, observation);
    }
  }
}

type AdmissionRefusal =
  | { kind: "terms"; reason: string }
  | {
      kind: "not_ready";
      reasons: ReadinessReason[];
      readiness?: OperationalReadiness;
    };

/** Every check a fresh or unmarked resumed attempt must pass before preparing. */
async function admissionRefusal(
  ctx: RpcContext,
  s: SettlementContext,
  terms: SettlementTerms,
  deadline: RequestDeadline,
): Promise<AdmissionRefusal | undefined> {
  const observer = ctx.readiness ?? s.readiness;
  if (!observer) {
    return { kind: "not_ready", reasons: ["readiness_observation_failed"] };
  }

  let readiness: OperationalReadiness | typeof TIMED_OUT;
  try {
    readiness = await deadline.race(observer.observe());
  } catch {
    console.error("[rpc] Authoritative readiness observation failed");
    return { kind: "not_ready", reasons: ["readiness_observation_failed"] };
  }
  if (readiness === TIMED_OUT) {
    return { kind: "terms", reason: "response_deadline" };
  }
  if (!readiness.ready) {
    return { kind: "not_ready", reasons: readiness.reasons, readiness };
  }

  const corridor = s.corridor;
  if (!s.mayBroadcast || !corridor) {
    // A ready projection and missing local prerequisites cannot coexist. Fail
    // closed rather than introducing a second definition of readiness.
    return { kind: "not_ready", reasons: ["readiness_observation_failed"] };
  }
  if (
    terms.corridor.corridorId !== corridor.corridorId.toLowerCase() ||
    terms.corridor.corridorRevision !== corridor.corridorRevision ||
    terms.corridor.manifestDigest !== corridor.manifestDigest.toLowerCase()
  ) {
    return { kind: "terms", reason: "corridor_mismatch" };
  }
  if (terms.network.genesisOrNetworkDigest !== corridor.genesisOrNetworkDigest.toLowerCase()) {
    return { kind: "terms", reason: "network_mismatch" };
  }
  if (terms.accountMode !== readiness.accountMode) {
    return { kind: "terms", reason: "account_mode_mismatch" };
  }
  if (readiness.token === null || readiness.token.toLowerCase() !== terms.token) {
    return { kind: "terms", reason: "token_mismatch" };
  }
  if (
    readiness.network.aztecChainId !== terms.network.aztecChainId ||
    readiness.network.protocolVersion !== terms.network.protocolVersion ||
    readiness.network.rollupContract !== terms.network.rollupAddress ||
    readiness.l1ChainId !== terms.network.l1ChainId
  ) {
    return { kind: "terms", reason: "network_mismatch" };
  }
  if (nowSeconds(s) >= terms.validUntil) {
    return { kind: "terms", reason: "validity_bound_passed" };
  }
  return undefined;
}

/**
 * Why an admitted, journaled, unmarked attempt is not sent now. Admission
 * readiness -- the /ready verdict, fee runway, finalized-tip freshness,
 * corridor admission -- closes NEW admission only and is not consulted: an
 * attempt already admitted keeps recovering through the may-broadcast query
 * and the exact journaled bytes. It holds only on a fact that makes this
 * transaction unsendable or certain to fail; each leaves it prepared with the
 * same bytes and hash, resumed by the next call. A fact that cannot be
 * observed is not a hold: the node and the account still decide.
 */
async function preparedHoldReasons(
  ctx: RpcContext,
  s: SettlementContext,
  terms: SettlementTerms,
  deadline: RequestDeadline,
): Promise<ReadinessReason[]> {
  const reasons: ReadinessReason[] = [];
  if (!s.journal.health().writable) reasons.push("journal_unwritable");
  if (!s.journal.writerFenceHeld()) reasons.push("writer_fence_lost");
  if (!s.mayBroadcast) reasons.push("may_broadcast_unconfigured");
  if (reasons.length > 0) return reasons;

  const observer = ctx.readiness ?? s.readiness;
  if (!observer) return reasons;
  let readiness: OperationalReadiness | typeof TIMED_OUT;
  try {
    readiness = await deadline.race(observer.observe());
  } catch {
    console.error("[rpc] Readiness observation for a prepared attempt failed");
    return reasons;
  }
  // The request deadline is spent, so the gate would close before any mark.
  if (readiness === TIMED_OUT) return ["readiness_observation_failed"];

  const network = readiness.network;
  if (
    network.aztecChainId !== null &&
    (network.aztecChainId !== terms.network.aztecChainId ||
      network.protocolVersion !== terms.network.protocolVersion ||
      network.rollupContract?.toLowerCase() !== terms.network.rollupAddress.toLowerCase() ||
      readiness.l1ChainId !== terms.network.l1ChainId)
  ) {
    reasons.push("network_identity_mismatch");
  }
  if (readiness.policy.paused === true) reasons.push("account_paused");
  // The attempt was proven against the configured tree; the account checks
  // its witness against the on-chain root at inclusion.
  if (
    readiness.policy.allowlistRoot !== null &&
    readiness.policy.configuredAllowlistRoot !== null &&
    readiness.policy.allowlistRoot.toLowerCase() !==
      readiness.policy.configuredAllowlistRoot.toLowerCase()
  ) {
    reasons.push("allowlist_root_mismatch");
  }
  if (
    readiness.inventory.observed !== null &&
    BigInt(readiness.inventory.observed) < BigInt(terms.amount)
  ) {
    reasons.push("inventory_insufficient");
  }
  return reasons;
}

async function notReady(
  id: number | string,
  ctx: RpcContext,
  s: SettlementContext,
  op: StoredOperation,
  fingerprint: string,
  refusal: Extract<AdmissionRefusal, { kind: "not_ready" }>,
): Promise<JsonRpcResponse> {
  const primaryReason = refusal.reasons[0] ?? "readiness_observation_failed";
  let observation: Observation;
  if (op.state === "prepared") {
    const attempt = currentAttempt(s.journal, op);
    if (!attempt) {
      return journalFault(
        id,
        s,
        op.operationId,
        new JournalUnreadableError(`current attempt of prepared operation ${op.operationId} missing`),
      );
    }
    observation = {
      state: "prepared",
      txHash: attempt.txHash,
      expirationTimestamp: attempt.expirationTimestamp,
      hold: op.hold ?? "interrupted",
    };
  } else {
    try {
      s.journal.recordNotSubmitted(op.operationId, primaryReason, true);
    } catch (cause) {
      return journalFault(id, s, op.operationId, cause);
    }
    observation = {
      state: "not_submitted",
      reason: primaryReason,
      retryableAfterRevalidation: true,
    };
  }
  await audit(ctx, observation);
  return rpcError(id, RPC_ERRORS.NOT_READY, "Bridge is not ready for new settlement admission", {
    reason: "bridge_not_ready",
    reasons: refusal.reasons,
    observation,
    ...(refusal.readiness
      ? {
          finalized: refusal.readiness.finalized,
          observedAt: refusal.readiness.observedAt,
        }
      : {}),
  });
}

async function notSubmitted(
  id: number | string,
  ctx: RpcContext,
  s: SettlementContext,
  op: StoredOperation,
  fingerprint: string,
  reason: string,
  retryable: boolean,
): Promise<JsonRpcResponse> {
  const definitive = reason === "validity_bound_passed" ? false : retryable;
  try {
    s.journal.recordNotSubmitted(op.operationId, reason, definitive);
  } catch (cause) {
    return journalFault(id, s, op.operationId, cause);
  }
  console.warn("[rpc] Settlement not submitted");
  const observation: Observation = {
    state: "not_submitted",
    reason,
    retryableAfterRevalidation: definitive,
  };
  await audit(ctx, observation);
  return answer(id, { operationId: op.operationId, fingerprint }, observation);
}

function journalFault(
  id: number | string,
  s: SettlementContext,
  operationId: string,
  cause: unknown,
): JsonRpcResponse {
  console.error("[rpc] Settlement journal fault");
  if (cause instanceof JournalWriteError) return journalUnavailable(id, cause.health, operationId);
  if (cause instanceof JournalUnreadableError) {
    return journalUnavailable(
      id,
      { writable: false, reason: "journal_unreadable", detail: cause.message },
      operationId,
    );
  }
  return journalUnavailable(id, s.journal.health(), operationId);
}

/**
 * One attempt through the gate, bounded by the request's `deadline`.
 *
 * The gate exists, and is guarded by the deadline, before the cooldown, so a
 * cooldown or a proof that runs past the deadline cannot mark afterwards; an
 * attempt the deadline has already ended starts no client call at all.
 *
 * Classification is by which side of the may-broadcast mark the failure is
 * on, never by error type: before it nothing can have been broadcast; after
 * it everything short of a node observation is `submitted_unknown`.
 */
async function runAttempt(
  id: number | string,
  client: IAztecClient,
  ctx: RpcContext,
  s: SettlementContext,
  state: DriveState,
  mode: GateMode,
  background: BackgroundCalls,
  deadline: RequestDeadline,
): Promise<JsonRpcResponse> {
  const { op, fingerprint, terms } = state;
  const amount = BigInt(terms.amount);
  let journaledBytes: Buffer | undefined;
  if (mode.kind !== "fresh") {
    try {
      journaledBytes = s.journal.attemptBytes(op.operationId, mode.attempt.attempt);
    } catch (cause) {
      return journalFault(id, s, op.operationId, cause);
    }
  }

  let reservationId: number | undefined;
  let cooldownMs: number | undefined;
  if (ctx.limits) {
    const reservation = ctx.limits.reserve(amount);
    if (!reservation.allowed) {
      if (mode.kind === "resume") {
        // Already admitted and journaled. Abandoning it here would re-prove
        // under a new hash, which Riddler refuses once it has bound this one;
        // the exact bytes stay held until the window has room again.
        console.warn("[rpc] Holding prepared settlement: rolling limit unavailable");
        const observation: Observation = {
          state: "prepared",
          txHash: mode.attempt.txHash,
          expirationTimestamp: mode.attempt.expirationTimestamp,
          hold: op.hold ?? "interrupted",
        };
        await audit(ctx, observation);
        return answer(id, { operationId: op.operationId, fingerprint }, observation);
      }
      return notSubmitted(id, ctx, s, op, fingerprint, `limits: ${reservation.reason}`, true);
    }
    reservationId = reservation.reservationId;
    cooldownMs = reservation.cooldownMs;
  }

  const gate = new OperationGate(s, state, mode, () => {
    if (ctx.limits && reservationId !== undefined) ctx.limits.commit(reservationId);
  });
  deadline.guard(gate);

  let outcome: TransferOutcome | typeof TIMED_OUT | undefined;
  let failure: unknown;
  if (cooldownMs) {
    console.log(`[rpc] Applying settlement cooldown (${cooldownMs}ms)`);
    await deadline.race(delay(cooldownMs));
  }
  if (deadline.expired) {
    failure = new GateClosed();
  } else {
    const call: Promise<TransferOutcome> =
      journaledBytes === undefined
        ? client.createNote({ recipient: terms.recipient, token: terms.token, amount: terms.amount }, gate)
        : client.broadcastPrepared(journaledBytes, gate);
    background.track(call);
    try {
      outcome = await deadline.race(call);
    } catch (cause) {
      failure = cause;
    }
    if (outcome === TIMED_OUT) failure = new Error(`no outcome within the ${s.timeoutMs}ms request deadline`);
  }
  // Whatever happened, nothing on this path may mark from now on.
  gate.close();
  if (!gate.marked && ctx.limits && reservationId !== undefined) {
    ctx.limits.release(reservationId);
  }

  const attempt = gate.attempt;
  if (failure === undefined && outcome !== undefined && outcome !== TIMED_OUT) {
    if (!gate.marked || !attempt) {
      // The client returned without passing the gate: impossible by
      // construction, and not a state that may be reported as anything known.
      console.error("[rpc] Broadcast reported without a may-broadcast mark");
      return answer(id, op, { state: "unknown", reason: "broadcast_without_mark" });
    }
    const observation = observationFrom(attempt, outcome.observation, (s.now ?? Date.now)());
    recordObservation(s, op.operationId, observation);
    await audit(ctx, observation);
    return answer(id, { operationId: op.operationId, fingerprint }, observation);
  }

  if (gate.marked && attempt) {
    console.error("[rpc] Marked settlement failed after may-broadcast");
    const observation: Observation = {
      state: "submitted_unknown",
      txHash: attempt.txHash,
      expirationTimestamp: attempt.expirationTimestamp,
      reason:
        failure instanceof BoundPassed
          ? failure.bound
          : deadline.expired
            ? "response_deadline"
            : "post_mark_failure",
    };
    await audit(ctx, observation);
    return answer(id, { operationId: op.operationId, fingerprint }, observation);
  }

  if (failure instanceof Held) {
    await audit(ctx, failure.observation);
    return answer(id, { operationId: op.operationId, fingerprint }, failure.observation);
  }
  if (failure instanceof JournalWriteError || failure instanceof JournalUnreadableError) {
    return journalFault(id, s, op.operationId, failure);
  }

  console.error("[rpc] Settlement failed before may-broadcast");
  if (attempt) {
    // Prepared and journaled, never marked: provably not broadcast, and the
    // exact bytes stay available to a retry.
    try {
      s.journal.recordHold(op.operationId, "interrupted");
    } catch (cause) {
      return journalFault(id, s, op.operationId, cause);
    }
    const observation: Observation = {
      state: "prepared",
      txHash: attempt.txHash,
      expirationTimestamp: attempt.expirationTimestamp,
      hold: "interrupted",
    };
    await audit(ctx, observation);
    return answer(id, { operationId: op.operationId, fingerprint }, observation);
  }
  return notSubmitted(id, ctx, s, op, fingerprint, deadline.expired ? "response_deadline" : "prepare_failed", true);
}

/**
 * Output-only audit line. Never decides control flow: every write it
 * describes has already happened in the journal.
 */
async function audit(ctx: RpcContext, observation: Observation): Promise<void> {
  if (!ctx.audit) return;
  try {
    await ctx.audit.log({
      timestamp: new Date().toISOString(),
      method: "aztec_createNote",
      observation: observation.state,
    });
  } catch {
    console.error("[rpc] AUDIT WRITE FAILED (output log only)");
  }
}

/**
 * Read-only recovery: the stored terms, every attempt and the current
 * observation. Served whether or not journal writes are enabled. An operation
 * the journal does not hold is `unknown` -- never "safe to retry".
 */
async function handleGetSettlement(
  id: number | string,
  params: unknown[],
  client: IAztecClient,
  ctx: RpcContext,
): Promise<JsonRpcResponse> {
  const parsed = GetSettlementSchema.safeParse(params[0]);
  if (!parsed.success || params.length !== 1) {
    return rpcError(id, RPC_ERRORS.INVALID_PARAMS, "Invalid params for aztec_getSettlement");
  }
  const s = ctx.settlement;
  if (!s) {
    return journalUnavailable(id, {
      writable: false,
      reason: "journal_unconfigured",
      detail: "PXE_BRIDGE_JOURNAL is not set",
    });
  }
  const { operationId } = parsed.data;
  let op: StoredOperation | undefined;
  let attempts: Attempt[] = [];
  try {
    op = s.journal.get(operationId);
    if (op) attempts = s.journal.attempts(operationId);
  } catch (cause) {
    return journalFault(id, s, operationId, cause);
  }
  const journal = journalHealthWire(s.journal.health());
  if (!op) {
    return success(id, {
      version: SETTLEMENT_VERSION,
      operationId,
      found: false,
      observation: { state: "unknown", reason: "operation_not_journaled" },
      journal,
    });
  }
  let observation: Observation;
  try {
    // A request this process is driving can mark at any moment, so before the
    // node knows the transaction the answer is "in flight", not a state.
    const driving = s.inFlight.has(operationId);
    observation =
      driving && (op.state === "claimed" || op.state === "prepared")
        ? { state: "request_in_flight" }
        : await observe(s, client, op);
    if (driving && observation.state === "submitted_unknown") {
      observation = { state: "request_in_flight" };
    }
    // The observation may have just committed a terminal outcome (or lost
    // that commit to a concurrent one): answer from the durable row.
    op = s.journal.get(operationId) ?? op;
    attempts = s.journal.attempts(operationId);
    if ((op.state === "finalized" || op.state === "reverted") && op.observation) {
      observation = op.observation;
    }
  } catch (cause) {
    return journalFault(id, s, operationId, cause);
  }
  return success(id, {
    version: SETTLEMENT_VERSION,
    operationId,
    found: true,
    fingerprint: op.fingerprint,
    terms: op.terms,
    state: op.state,
    attempts: attempts.map((a) => ({
      attempt: a.attempt,
      txHash: a.txHash,
      expirationTimestamp: a.expirationTimestamp,
      mayBroadcast: a.mayBroadcastAt !== null,
    })),
    observation,
    journal,
  });
}

async function handleGetVersion(
  id: number | string,
  client: IAztecClient,
): Promise<JsonRpcResponse> {
  try {
    const version = await client.getVersion();
    return success(id, version);
  } catch {
    console.error("[rpc] aztec_getVersion failed");
    return rpcError(id, RPC_ERRORS.INTERNAL_ERROR, "Internal error");
  }
}
