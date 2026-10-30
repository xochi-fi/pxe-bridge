import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BroadcastGate,
  IAztecClient,
  NodeNetwork,
  PreparedTransaction,
  TransferOutcome,
  TransferParams,
} from "../src/types.js";
import type { AccountMode, CorridorConfig, NodeObservation } from "../src/settlement.js";
import { SETTLEMENT_VERSION } from "../src/settlement.js";
import { SettlementJournal } from "../src/journal.js";
import type { MayBroadcastClient, MayBroadcastDecision } from "../src/may-broadcast.js";
import type { SettlementContext } from "../src/rpc.js";
import type { OperationalReadiness, ReadinessObserver } from "../src/readiness.js";

// Field values must sit below the BN254 modulus (0x3064...), so they lead with 0x0.
export const ACCOUNT = "0x0" + "1".repeat(63);
export const RECIPIENT = "0x0" + "2".repeat(63);
export const TOKEN = "0x0" + "3".repeat(63);
export const DESCRIPTOR_DIGEST = "0x" + "4".repeat(64);

export const NETWORK: NodeNetwork & { genesisOrNetworkDigest: string } = {
  aztecChainId: "31337",
  protocolVersion: "4242",
  rollupAddress: "0x" + "5".repeat(40),
  l1ChainId: "31337",
  genesisOrNetworkDigest: "0x" + "6".repeat(64),
};

export const CORRIDOR: CorridorConfig = {
  corridorId: "0x" + "7".repeat(64),
  corridorRevision: 1,
  manifestDigest: "0x" + "8".repeat(64),
  genesisOrNetworkDigest: NETWORK.genesisOrNetworkDigest,
};

/**
 * Fixed once per run: a bound recomputed per call changes the fingerprint
 * whenever a second ticks between a request and its retry.
 */
export const VALID_UNTIL = Math.floor(Date.now() / 1000) + 3600;

/** A valid `pxe-bridge.settlement.v1` createNote payload. */
export function v1Params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: SETTLEMENT_VERSION,
    operationId: "op-1",
    network: { ...NETWORK },
    corridor: {
      corridorId: CORRIDOR.corridorId,
      corridorRevision: CORRIDOR.corridorRevision,
      manifestDigest: CORRIDOR.manifestDigest,
    },
    accountMode: "spending_limit",
    recipient: RECIPIENT,
    recipientDescriptorDigest: DESCRIPTOR_DIGEST,
    token: TOKEN,
    amount: "1000",
    validUntil: VALID_UNTIL,
    ...overrides,
  };
}

export function tempJournalPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pxe-journal-")), "journal.sqlite");
}

/** Opens a journal and binds it to a freshly deployed account. */
export function openBoundJournal(path = tempJournalPath()): SettlementJournal {
  const journal = SettlementJournal.open(path);
  journal.bindAccount(ACCOUNT, false);
  return journal;
}

export interface FakeMayBroadcast {
  client: MayBroadcastClient;
  calls: string[];
  decision: MayBroadcastDecision | "hang" | "throw";
}

export function fakeMayBroadcast(decision: FakeMayBroadcast["decision"] = "allow"): FakeMayBroadcast {
  const fake: FakeMayBroadcast = {
    calls: [],
    decision,
    client: async (query) => {
      fake.calls.push(query.operationId);
      if (fake.decision === "hang") return new Promise(() => undefined);
      if (fake.decision === "throw") throw new Error("may-broadcast exploded");
      return { decision: fake.decision, detail: "fake" };
    },
  };
  return fake;
}

/**
 * Riddler's may-broadcast as D-A specifies it: the first `allow` for an
 * operation binds `{fingerprint, txHash}`; the same pair again is `allow`,
 * anything else for that operation `deny`.
 */
export function bindingMayBroadcast(): { client: MayBroadcastClient; answers: string[] } {
  const bound = new Map<string, { fingerprint: string; txHash: string }>();
  const answers: string[] = [];
  const client: MayBroadcastClient = async ({ operationId, fingerprint, txHash }) => {
    const held = bound.get(operationId);
    const decision =
      held === undefined || (held.fingerprint === fingerprint && held.txHash === txHash) ? "allow" : "deny";
    if (held === undefined) bound.set(operationId, { fingerprint, txHash });
    answers.push(decision);
    return { decision, detail: "binding fake" };
  };
  return { client, answers };
}

export function readyObserver(
  overrides: Partial<OperationalReadiness> = {},
): ReadinessObserver {
  const readiness: OperationalReadiness = {
    ready: true,
    reasons: [],
    observedAt: Math.floor(Date.now() / 1_000),
    nodeVersion: "6.0.0",
    l1ChainId: NETWORK.l1ChainId,
    rollupVersion: NETWORK.protocolVersion,
    accountMode: "spending_limit",
    account: { address: ACCOUNT, classId: "0x" + "a".repeat(64) },
    token: TOKEN,
    maxAmount: "1000",
    dailyLimit: "10000",
    network: {
      aztecChainId: NETWORK.aztecChainId,
      protocolVersion: NETWORK.protocolVersion,
      rollupContract: NETWORK.rollupAddress,
      genesisOrNetworkDigest: NETWORK.genesisOrNetworkDigest,
    },
    node: {
      acceptingTransactions: true,
      worldStateSynced: true,
      finalizedHistoryAvailable: true,
    },
    finalized: {
      blockNumber: "7",
      blockHash: "0x" + "b".repeat(64),
      timestamp: String(Math.floor(Date.now() / 1_000)),
      ageSeconds: 0,
      maxAgeSeconds: 7_200,
    },
    policy: {
      initialized: true,
      paused: false,
      allowlistRoot: "0x" + "c".repeat(64),
      configuredAllowlistRoot: "0x" + "c".repeat(64),
    },
    inventory: { observed: "10000", required: "10000" },
    rollingWindow: {
      committed: "0",
      reserved: "0",
      headroom: "10000",
      inFlightTransfers: 0,
    },
    feeRunway: {
      observed: "100000",
      required: "10000",
      perTransferFeeLimit: "1000",
    },
    journal: { writable: true, writerFenceHeld: true },
    ...overrides,
  };
  return { observe: async () => readiness };
}

export function settlementContext(
  journal: SettlementJournal,
  mayBroadcast: MayBroadcastClient | undefined = fakeMayBroadcast().client,
  overrides: Partial<SettlementContext> = {},
): SettlementContext {
  return {
    journal,
    mayBroadcast,
    corridor: CORRIDOR,
    inFlight: new Set<string>(),
    timeoutMs: 2_000,
    readiness: readyObserver(),
    ...overrides,
  };
}

/**
 * What the fake does with one createNote/broadcastPrepared call.
 *
 * - `land`: gate, then the "node" includes the transaction.
 * - `fail_before_gate`: proving fails; the gate never runs.
 * - `lose_response`: gate, inclusion, then the call throws (the response is
 *   lost after the broadcast).
 * - `die_after_mark`: gate passes, then the call throws WITHOUT reaching the
 *   node: the process died between the may-broadcast mark and the send.
 * - `hang_after_broadcast`: gate, inclusion, then never returns.
 */
export type FakeBehaviour =
  | "land"
  | "fail_before_gate"
  | "lose_response"
  | "die_after_mark"
  | "hang_after_broadcast";

/**
 * An IAztecClient whose "chain" is a map from tx hash to receipt. The same
 * bytes always carry the same hash, so the chain holds at most one credit per
 * transaction no matter how often it is broadcast: `credits()` counts them.
 */
export class FakeAztecClient implements IAztecClient {
  behaviour: FakeBehaviour = "land";
  mode: AccountMode = "spending_limit";
  pinned: string | undefined = TOKEN;
  network: NodeNetwork = { ...NETWORK };
  expiration = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  /** Every transaction handed to the node, duplicates included. */
  sends: string[] = [];
  /** Hashes the node includes, and at which finality. */
  chain = new Map<string, NodeObservation>();
  finality: "proposed" | "finalized" = "proposed";
  revert = false;
  proofs = 0;
  observeError: Error | undefined;
  /** Runs after the transaction is proven or reconstructed, before the gate. */
  beforeGate: (() => void) | undefined;
  /** Runs after `beforeBroadcast` resolves, before the synchronous `beforeSend`. */
  afterGate: (() => void) | undefined;

  async connect(): Promise<void> {}

  async createNote(params: TransferParams, gate: BroadcastGate): Promise<TransferOutcome> {
    if (this.behaviour === "fail_before_gate") throw new Error("simulation failed");
    this.proofs += 1;
    const tx = this.prepare(params, this.proofs);
    return this.send(tx, gate);
  }

  async broadcastPrepared(txBytes: Buffer, gate: BroadcastGate): Promise<TransferOutcome> {
    const decoded = JSON.parse(txBytes.toString("utf8")) as { txHash: string; expiration: string };
    return this.send(
      { txHash: decoded.txHash, txBytes, expirationTimestamp: BigInt(decoded.expiration) },
      gate,
    );
  }

  async observeTx(txHash: string): Promise<NodeObservation> {
    if (this.observeError) throw this.observeError;
    return this.chain.get(txHash) ?? { kind: "dropped" };
  }

  async networkIdentity(): Promise<NodeNetwork> {
    return this.network;
  }

  accountMode(): AccountMode {
    return this.mode;
  }

  accountPreexisted(): boolean {
    return false;
  }

  getAddress(): string | null {
    return ACCOUNT;
  }

  async getVersion(): Promise<string> {
    return "6.0.0";
  }

  pinnedToken(): string | undefined {
    return this.pinned;
  }

  async getFeeJuiceBalance(): Promise<bigint> {
    return 0n;
  }

  /** Distinct transactions the chain credited. */
  credits(): number {
    return this.chain.size;
  }

  /** Moves every included transaction to `finalized`. */
  finalizeAll(): void {
    for (const [hash, obs] of this.chain) {
      if (obs.kind === "mined") this.chain.set(hash, { ...obs, receiptStatus: "finalized" });
    }
  }

  private prepare(params: TransferParams, proof: number): PreparedTransaction {
    // A fresh proof is a fresh transaction: a different hash every time.
    const txHash =
      "0x" +
      createHash("sha256")
        .update(`${params.recipient}|${params.token}|${params.amount}|${proof}|${Math.random()}`)
        .digest("hex");
    const expiration = this.expiration.toString();
    return {
      txHash,
      txBytes: Buffer.from(JSON.stringify({ txHash, expiration })),
      expirationTimestamp: this.expiration,
    };
  }

  private async send(tx: PreparedTransaction, gate: BroadcastGate): Promise<TransferOutcome> {
    this.beforeGate?.();
    await gate.beforeBroadcast(tx);
    this.afterGate?.();
    if (this.behaviour === "die_after_mark") throw new Error("process died after the mark");
    // As AztecClient: the final check and the send in one synchronous run.
    gate.beforeSend(tx);
    this.sends.push(tx.txHash);
    const observation: NodeObservation = {
      kind: "mined",
      executionResult: this.revert ? "reverted" : "success",
      blockHash: "0x" + "b".repeat(64),
      blockNumber: "7",
      receiptStatus: this.finality,
      effects: { state: "available", noteHashes: ["0xn1", "0xn2"], nullifiers: ["0xu1", "0xu2", "0xu3"] },
    };
    this.chain.set(tx.txHash, observation);
    if (this.behaviour === "lose_response") throw new Error("connection reset after send");
    if (this.behaviour === "hang_after_broadcast") return new Promise(() => undefined);
    return { txHash: tx.txHash, observation };
  }
}

export function rpcBody(method: string, params: unknown[] = [], id: number | string = 1) {
  return { jsonrpc: "2.0", id, method, params };
}
