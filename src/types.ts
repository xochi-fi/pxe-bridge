import { z } from "zod";
import type { AccountMode, NodeObservation } from "./settlement.js";

// JSON-RPC envelope
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.array(z.unknown()).default([]),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | {
      jsonrpc: "2.0";
      id: number | string | null;
      // `data` carries the txHash when a transfer may have landed but its
      // result could not be read back, so the caller can reconcile instead of
      // retrying into a second transfer.
      error: { code: number; message: string; data?: unknown };
    };

/**
 * What the client moves: one `transfer_to_private` of `amount` of `token` to
 * `recipient`. Validated upstream by `CreateNoteSchema` (settlement.ts); the
 * client never sees the operation terms it does not need.
 */
export interface TransferParams {
  recipient: string;
  token: string;
  amount: string;
}

/** The exact transaction the bridge journals before anything may send it. */
export interface PreparedTransaction {
  txHash: string;
  txBytes: Buffer;
  /** Protocol expiry (unix seconds): the node refuses inclusion after it. */
  expirationTimestamp: bigint;
  /**
   * The `transfer_to_private` partial-note randomness (`0x` + 64 lowercase
   * hex) that opens this transaction's partial-note commitment for the
   * recipient. Journaled with the bytes; never logged.
   */
  partialNoteRandomness: string;
}

/** Journaled bytes plus what a resend re-verifies them against. */
export interface JournaledTransfer extends TransferParams {
  txBytes: Buffer;
  partialNoteRandomness: string;
}

/**
 * The proven payout's partial-note randomness could not be resolved, so the
 * transaction was not broadcast (xochi-fi/pxe-bridge#78). `detail` says which
 * check failed; it never carries a value.
 *
 * - `no_commitment`: no unique `_finalize_transfer_to_private_unsafe` call
 *   with the payout's `from` and `amount`.
 * - `no_match`: no captured value opens the commitment for the recipient.
 * - `ambiguous`: more than one does.
 * - `mismatch`: journaled randomness does not open the journaled bytes'
 *   commitment.
 */
export class PartialNoteUnresolved extends Error {
  constructor(readonly detail: "no_commitment" | "no_match" | "ambiguous" | "mismatch") {
    super(`partial-note randomness unresolved (${detail}); nothing was broadcast`);
    this.name = "PartialNoteUnresolved";
  }
}

/**
 * Two steps around handing the exact proven transaction to the node.
 *
 * `beforeBroadcast` runs first and may wait: this is where rpc.ts journals
 * the transaction, asks Riddler, and marks may-broadcast. Throwing stops the
 * broadcast.
 *
 * `beforeSend` is the final step and is SYNCHRONOUS: the client calls it and
 * then invokes `sendTx` in the same synchronous run, with no `await` between
 * them, so a bound it checks (rpc.ts: `validUntil` and the protocol
 * expiration) still holds when the node is called. Throwing stops the send.
 */
export interface BroadcastGate {
  beforeBroadcast(tx: PreparedTransaction): Promise<void>;
  beforeSend(tx: PreparedTransaction): void;
}

/** A broadcast that reached a proposed block, with what the node reports. */
export interface TransferOutcome {
  txHash: string;
  observation: NodeObservation;
}

/** Network identity the node reports; `genesisOrNetworkDigest` is config. */
export interface NodeNetwork {
  aztecChainId: string;
  protocolVersion: string;
  rollupAddress: string;
  l1ChainId: string;
}

// Fee Juice claim from L1->L2 bridge (one-time account deployment)
export const FeeJuiceClaimSchema = z.object({
  claimAmount: z.string().regex(/^\d+$/, "Must be a non-negative integer"),
  claimSecret: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Must be 32-byte hex Fr element"),
  messageLeafIndex: z.string().regex(/^\d+$/, "Must be a non-negative integer"),
});

export type FeeJuiceClaim = z.infer<typeof FeeJuiceClaimSchema>;

/**
 * A claim plus the hash of the L1 to L2 message behind it: what resuming a
 * top-up needs once the L1 deposit is done. The hash is what the wait polls
 * for, and the claim alone does not carry it.
 */
export const BridgedFeeJuiceClaimSchema = FeeJuiceClaimSchema.extend({
  messageHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Must be 32-byte hex"),
});

export type BridgedFeeJuiceClaim = z.infer<typeof BridgedFeeJuiceClaimSchema>;

/**
 * One allowlisted recipient and the tree position it occupies.
 *
 * The index is not decorative. The account stores only a root, so the bridge
 * has to reproduce the exact tree the admin built, and a leaf at the wrong
 * position produces a different root. It is also published in the admin's
 * `update_recipient` call, which is why positions are assigned randomly rather
 * than filled left to right: a first touch of position k would otherwise be
 * visibly an addition.
 *
 * The upper bound is 2^ALLOWLIST_TREE_HEIGHT, which the contract also asserts.
 */
export const AllowlistRecipientSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Must be a 32-byte hex AztecAddress"),
  index: z.number().int().min(0).max(1023),
});

export const AllowlistRecipientsSchema = z.array(AllowlistRecipientSchema);

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

/**
 * The spending-limit account's deployment record: the constructor inputs it was
 * deployed with, and the address they produced.
 *
 * Constructor args feed address derivation, so deriving them from live
 * configuration meant every legitimate change moved the account. Rotating a
 * recipient with `update_recipient`, or applying new limits and updating the
 * env to match, gave the next restart a different address with nothing at it,
 * and the bridge deployed a fresh empty account there and logged "Ready" over
 * the funded one. Once this is set the address derives from it alone, and the
 * live values go back to their own jobs: recipients and seed build the witness
 * tree, the limit env vars drive the application-level limits.
 *
 * Amounts are decimal strings because JSON has no bigint. `allowlistRoot` is
 * the root at construction, not the current one: every `update_recipient`
 * moves the stored root, and none of them moves the address.
 */
export const AccountDeploymentSchema = z
  .object({
    address: z.string().regex(HEX32, "Must be a 32-byte hex AztecAddress"),
    maxAmountPerTx: z.string().regex(POSITIVE_INTEGER, "Must be a positive integer"),
    dailyLimit: z.string().regex(POSITIVE_INTEGER, "Must be a positive integer"),
    admin: z.string().regex(HEX32, "Must be a 32-byte hex AztecAddress"),
    token: z.string().regex(HEX32, "Must be a 32-byte hex AztecAddress"),
    allowlistRoot: z.string().regex(HEX32, "Must be a 32-byte hex field element"),
  })
  // Strict, so a misspelt key fails here instead of being dropped and turning
  // up later as an address mismatch with no clue which field was wrong.
  .strict();

export type AccountDeployment = z.infer<typeof AccountDeploymentSchema>;

// Abstraction over AztecClient for testability
export interface IAztecClient {
  connect(): Promise<void>;
  /**
   * Proves a transfer and broadcasts it through `gate`. Everything thrown
   * before `gate.beforeBroadcast` resolves happened before the network saw
   * anything; the caller tracks which side of the gate a failure is on. The
   * gate sees the proven transaction with its partial-note randomness; a
   * proof whose randomness cannot be resolved throws `PartialNoteUnresolved`
   * before the gate.
   */
  createNote(params: TransferParams, gate: BroadcastGate): Promise<TransferOutcome>;
  /**
   * Broadcasts journaled bytes exactly as prepared, through `gate`. Never
   * rebuilds or re-proves: the same bytes carry the same transaction hash and
   * nullifiers, so they can be included at most once. Refuses, before the
   * gate, bytes whose partial-note commitment the journaled randomness does
   * not open for the journaled recipient (`PartialNoteUnresolved`).
   */
  broadcastPrepared(prepared: JournaledTransfer, gate: BroadcastGate): Promise<TransferOutcome>;
  /**
   * Read-only: what the node currently says about `txHash`. `signal` aborts
   * the node read itself, not only the wait for it.
   */
  observeTx(txHash: string, signal?: AbortSignal): Promise<NodeObservation>;
  /** Live read of the node's network identity. */
  networkIdentity(): Promise<NodeNetwork>;
  /** Which account class signs: decided by configuration at construction. */
  accountMode(): AccountMode;
  /** Whether the account was already initialized on chain before connect(). */
  accountPreexisted(): boolean;
  getAddress(): string | null;
  getVersion(): Promise<string>;
  /**
   * The only token the account can move, or undefined when it is not pinned.
   * Checked in rpc.ts before any budget is reserved: the contract enforces
   * the token only in public, and the send proves without simulating public,
   * so a mismatched token is otherwise proven, sent, reverted, and paid for.
   */
  pinnedToken(): string | undefined;
  /** Fee juice held by the solver account, which pays every transfer. */
  getFeeJuiceBalance(): Promise<bigint>;
}

/**
 * Answer for a transfer that may be on chain but whose outcome is not known.
 * Carried by every `submitted_unknown` and `unknown` observation, so a caller
 * matching on the string sees the same one from a live send and a recovery.
 */
export const SUBMITTED_UNKNOWN_MESSAGE =
  "Transaction submitted, result unknown -- do not retry without reconciling";

// JSON-RPC error codes
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // JSON-RPC reserves -32000..-32099 for application errors. Both of these
  // used to be INTERNAL_ERROR, which put five distinct conditions behind one
  // code and left the two that matter indistinguishable: a caller reading the
  // code alone could not tell "nothing happened yet, wait" from "this may
  // have moved funds, reconcile". Only string-matching the message separated
  // them, which is not an interface.
  REQUEST_IN_FLIGHT: -32001,
  SUBMITTED_UNKNOWN: -32002,
  // Settlement operation contract (docs/settlement-operations.md).
  /** Same operation id, different fingerprint: no work was done. */
  OPERATION_CONFLICT: -32003,
  /**
   * Journal writes are disabled, or it cannot be read. This request sent
   * nothing; it says nothing about earlier requests for the operation.
   */
  JOURNAL_UNAVAILABLE: -32004,
  /** Provably not broadcast (refused, or held before may-broadcast). */
  NOT_SUBMITTED: -32005,
  /** The authoritative readiness predicate refused new admission. */
  NOT_READY: -32006,
} as const;
