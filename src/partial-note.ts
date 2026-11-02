import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { DomainSeparator, MAX_NOTE_HASHES_PER_TX } from "@aztec-labs/constants";
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { PrivateExecutionOracle, UtilityExecutionOracle } from "@aztec-labs/pxe/simulator";
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address";
import {
  computeNoteHashNonce,
  computeUniqueNoteHash,
  siloNoteHash,
  siloNullifier,
} from "@aztec-labs/stdlib/hash";
import { PartialNoteUnresolved } from "./types.js";

/**
 * The partial-note randomness of a `transfer_to_private` payout
 * (xochi-fi/pxe-bridge#78).
 *
 * `Token.transfer_to_private(to, amount)` hides `to` in the partial-note
 * commitment `C = P2([to, randomness], DOM_SEP__PARTIAL_NOTE_COMMITMENT)` and
 * enqueues `_finalize_transfer_to_private_unsafe(from, amount, C)`. The
 * randomness is drawn by the sending PXE's `aztec_misc_getRandomField` oracle
 * and stored nowhere: the token returns nothing, the partial note never
 * reaches the sender's note store, and the only other copy is encrypted to
 * `to`. With it, anyone holding the signed `(to, amount)` can recompute the
 * unique note hash and the validity nullifier and require them among a mined
 * transaction's effects, which is how Riddler proves the payout reached the
 * signed recipient rather than another allowlisted one.
 *
 * Capture: every value the oracle returns while a payout is proven is
 * recorded into an AsyncLocalStorage scope opened around that one send
 * (`captureRandomness`). The scope reaches the oracle only because the
 * wallet's PXE operation queue is bound to its caller's async context
 * (`bindPxeOperations`): the PXE runs every operation from one consumer loop,
 * which would otherwise execute it in the loop's context, not the caller's.
 * The simulation and the proof draw different values, and the note message's
 * encryption draws its own, so the one value that opens the proven `C` for the
 * signed recipient is selected afterwards (`selectPartialNoteRandomness`).
 */

/**
 * aztec-nr `DOM_SEP__PARTIAL_NOTE_COMMITMENT` (6.0.0). Not exported by
 * `@aztec-labs/constants`, which carries only the protocol separators; pinned
 * against the 6.0.0 runtime by tests/partial-note.test.ts and the e2e payout.
 */
export const PARTIAL_NOTE_COMMITMENT_SEPARATOR = 568912195;

/** aztec-nr `DOM_SEP__NOTE_COMPLETION_LOG_TAG` (6.0.0): the completion log's tag. */
export const NOTE_COMPLETION_LOG_TAG_SEPARATOR = 3372669888;

/** `Token.balances` storage slot, the partial note's slot (Token 6.0.0). */
export const TOKEN_BALANCES_SLOT = 3n;

interface RandomnessScope {
  drawn: Fr[];
}

const scope = new AsyncLocalStorage<RandomnessScope>();
const CAPTURING = Symbol("pxe-bridge.partial-note-capture");
const BOUND = Symbol("pxe-bridge.pxe-operations-bound");

/**
 * Wraps `UtilityExecutionOracle.prototype.getRandomField`, once per process.
 * `PrivateExecutionOracle` must inherit it: an override there would draw
 * outside the wrapper, so it is refused rather than silently missed.
 */
export function installRandomnessCapture(): void {
  const proto = UtilityExecutionOracle.prototype as UtilityExecutionOracle & {
    getRandomField: (() => Fr) & { [CAPTURING]?: true };
  };
  const current = proto.getRandomField;
  if (current[CAPTURING] !== true) {
    const original = current;
    const wrapped = Object.assign(
      function getRandomField(this: UtilityExecutionOracle): Fr {
        const value = original.call(this);
        scope.getStore()?.drawn.push(value);
        return value;
      },
      { [CAPTURING]: true as const },
    );
    proto.getRandomField = wrapped;
  }
  if (PrivateExecutionOracle.prototype.getRandomField !== proto.getRandomField) {
    throw new Error("PrivateExecutionOracle no longer inherits getRandomField; partial-note capture would miss it");
  }
}

/**
 * Runs each operation the wallet's PXE queues in the async context of the
 * caller that queued it, so a capture scope opened around a send reaches the
 * oracle inside the queued simulation and proof. Instance-level: only this
 * wallet's PXE is affected. Refuses a PXE without the 6.0.0 queue rather than
 * starting a bridge that could never resolve a payout.
 */
export function bindPxeOperations(pxe: unknown): void {
  const queue = (pxe as { operationQueue?: { run?: unknown; [BOUND]?: true } } | null)?.operationQueue;
  if (!queue || typeof queue.run !== "function") {
    throw new Error("the wallet's PXE has no operation queue to bind; partial-note capture is unavailable");
  }
  if (queue[BOUND] === true) return;
  const run = (queue.run as (fn: () => Promise<unknown>) => Promise<unknown>).bind(queue);
  queue.run = (fn: () => Promise<unknown>) => run(AsyncResource.bind(fn));
  queue[BOUND] = true;
}

/** Runs `fn` with a fresh capture scope. */
export function captureRandomness<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ drawn: [] }, fn);
}

/**
 * Values drawn so far in the current scope, emptying it, or undefined outside
 * any scope. Taken once per proven transaction: the other values include the
 * note message's ephemeral encryption secrets, which are held no longer than
 * the selection needs them.
 */
export function takeDrawnRandomness(): Fr[] | undefined {
  const store = scope.getStore();
  if (!store) return undefined;
  return store.drawn.splice(0);
}

/** `C = P2([recipient, randomness], DOM_SEP__PARTIAL_NOTE_COMMITMENT)`. */
export function partialNoteCommitment(recipient: Fr, randomness: Fr): Promise<Fr> {
  return poseidon2HashWithSeparator([recipient, randomness], PARTIAL_NOTE_COMMITMENT_SEPARATOR);
}

/**
 * The one drawn value that opens `commitment` for `recipient`. Zero matches,
 * or more than one, throws: neither can be journaled as the payout's opening.
 */
export async function selectPartialNoteRandomness(
  drawn: readonly Fr[],
  recipient: Fr,
  commitment: Fr,
): Promise<Fr> {
  const matches: Fr[] = [];
  for (const candidate of drawn) {
    if ((await partialNoteCommitment(recipient, candidate)).equals(commitment)) matches.push(candidate);
  }
  if (matches.length === 0) throw new PartialNoteUnresolved("no_match");
  if (matches.length > 1) throw new PartialNoteUnresolved("ambiguous");
  return matches[0]!;
}

/** The payout terms a proven transaction is checked against. */
export interface PayoutTerms {
  token: AztecAddress;
  from: AztecAddress;
  recipient: AztecAddress;
  amount: bigint;
}

/** A public call request as the proven transaction exposes it. */
export interface PublicCall {
  contractAddress: AztecAddress;
  functionSelector: { toField(): Fr };
  args: readonly Fr[];
}

/**
 * `C`, the third argument of the transaction's one
 * `_finalize_transfer_to_private_unsafe(from, amount, C)` call on the token.
 * That call must be unique and carry the payout's own `from` and `amount`.
 */
export function finalizeCommitment(
  calls: readonly PublicCall[],
  finalizeSelector: Fr,
  payout: Pick<PayoutTerms, "token" | "from" | "amount">,
): Fr {
  const finalizes = calls.filter(
    (c) => c.contractAddress.equals(payout.token) && c.functionSelector.toField().equals(finalizeSelector),
  );
  if (finalizes.length !== 1) throw new PartialNoteUnresolved("no_commitment");
  const [from, amount, commitment] = finalizes[0]!.args;
  if (
    finalizes[0]!.args.length !== 3 ||
    from === undefined ||
    amount === undefined ||
    commitment === undefined ||
    !from.equals(payout.from.toField()) ||
    amount.toBigInt() !== payout.amount
  ) {
    throw new PartialNoteUnresolved("no_commitment");
  }
  return commitment;
}

/** Lowercase `0x` + 64 hex: the journal's and the wire's encoding. */
export function randomnessHex(value: Fr): string {
  return value.toString().toLowerCase();
}

/**
 * What a mined payout must show, derived from the signed terms and the
 * randomness alone (the relation Riddler's `Shielded.PaymentProof` checks):
 * the unique note hash for each possible position, the siloed validity
 * nullifier, and the completion log's tag. `payoutAccount` is the account that
 * called `transfer_to_private`: the partial note's completer.
 */
export interface PayoutEvidence {
  partialCommitment: Fr;
  noteHash: Fr;
  siloedNoteHash: Fr;
  siloedValidityNullifier: Fr;
  completionLogTag: Fr;
  uniqueNoteHash(firstNullifier: Fr, index: number): Promise<Fr>;
}

export async function payoutEvidence(input: {
  token: AztecAddress;
  recipient: AztecAddress;
  payoutAccount: AztecAddress;
  amount: bigint;
  randomness: Fr;
}): Promise<PayoutEvidence> {
  const partialCommitment = await partialNoteCommitment(input.recipient.toField(), input.randomness);
  const noteHash = await poseidon2HashWithSeparator(
    [new Fr(TOKEN_BALANCES_SLOT), partialCommitment, new Fr(input.amount)],
    DomainSeparator.NOTE_HASH,
  );
  const siloedNoteHash = await siloNoteHash(input.token, noteHash);
  const siloedValidityNullifier = await siloNullifier(
    input.token,
    await poseidon2HashWithSeparator(
      [partialCommitment, input.payoutAccount.toField()],
      DomainSeparator.PARTIAL_NOTE_VALIDITY_COMMITMENT,
    ),
  );
  const completionLogTag = await poseidon2HashWithSeparator([partialCommitment], NOTE_COMPLETION_LOG_TAG_SEPARATOR);
  return {
    partialCommitment,
    noteHash,
    siloedNoteHash,
    siloedValidityNullifier,
    completionLogTag,
    uniqueNoteHash: async (firstNullifier, index) =>
      computeUniqueNoteHash(await computeNoteHashNonce(firstNullifier, index), siloedNoteHash),
  };
}

/**
 * Whether `effects` prove a payout of `amount` to `recipient` with
 * `randomness`: the unique note hash at some position below 64 is among
 * `noteHashes`, and the siloed validity nullifier is among `nullifiers`.
 */
export async function effectsProvePayout(
  effects: { noteHashes: readonly string[]; nullifiers: readonly string[] },
  input: Parameters<typeof payoutEvidence>[0],
): Promise<boolean> {
  const first = effects.nullifiers[0];
  if (first === undefined) return false;
  const evidence = await payoutEvidence(input);
  const notes = new Set(effects.noteHashes.map((h) => h.toLowerCase()));
  const nullifiers = new Set(effects.nullifiers.map((n) => n.toLowerCase()));
  if (!nullifiers.has(evidence.siloedValidityNullifier.toString().toLowerCase())) return false;
  const firstNullifier = Fr.fromString(first);
  for (let i = 0; i < MAX_NOTE_HASHES_PER_TX; i += 1) {
    if (notes.has((await evidence.uniqueNoteHash(firstNullifier, i)).toString().toLowerCase())) return true;
  }
  return false;
}
