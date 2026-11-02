import { createHash, randomBytes } from "node:crypto";
import type { MayBroadcastClient, MayBroadcastQuery } from "../src/may-broadcast.js";
import type { NodeObservation } from "../src/settlement.js";
import { DAI, type OxideCapsConfig } from "../src/oxide/caps.js";
import type { OxideSendEvidence } from "../src/oxide/operation.js";
import { OXIDE_V6_MAINNET } from "../src/oxide/pins.js";
import type {
  OxideBackend,
  OxidePayout,
  OxideProvenTx,
  OxideSigned,
  OxideSimulation,
} from "../src/oxide/sender.js";

export { tempJournalPath } from "./settlement-fixtures.js";

export const SENDER = "0x" + "11".repeat(32);
export const RECIPIENT = "0x" + "22".repeat(32);
export const ORDER = "0x" + "ab".repeat(32);
export const T0 = 1_800_000_000_000;

export const CAPS: OxideCapsConfig = {
  maxPerTx: 1_000n * DAI,
  dailyLimit: 10_000n * DAI,
  maxNoteAmount: OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount,
};

export function request(overrides: Partial<{ operationId: string; amount: string; validUntil: number; recipient: string }> = {}) {
  return {
    operationId: overrides.operationId ?? "op-1",
    recipient: overrides.recipient ?? RECIPIENT,
    amount: overrides.amount ?? (100n * DAI).toString(),
    orderFingerprint: ORDER,
    validUntil: overrides.validUntil ?? Math.floor(T0 / 1000) + 600,
  };
}

export function evidenceFor(
  payout: { recipient: string; amount: bigint },
  txNullifiers: string[] = ["0x" + randomBytes(32).toString("hex")],
): OxideSendEvidence {
  const field = () => "0x" + randomBytes(31).toString("hex").padStart(64, "0");
  return {
    anchorBlockHash: field(),
    enclave: { address: "0x04ffc6ad66934937737dd5fea303bd0903b7625e", registrationLeafIndex: "6", publicKeyX: field(), publicKeyY: field() },
    createdNotes: [
      { owner: SENDER, amount: "0", randomness: field() },
      { owner: payout.recipient, amount: payout.amount.toString(), randomness: field() },
    ],
    recipientNoteIndex: 1,
    teeNotes: [field(), field()],
    requiredNullifiers: [field()],
    txNullifiers,
    signatures: [0, 1].map(() => ({ sLo: field(), sHi: field(), rLo: field(), rHi: field() })),
    gasLimits: { daGas: 1000, l2Gas: 606_480 },
    maxFeesPerGas: { feePerDaGas: "0", feePerL2Gas: "2000000000" },
  };
}

/** The nullifier of the sending account's `k`-th note. */
export const noteNullifier = (k: number) => "0x" + (k + 1).toString(16).padStart(64, "0");

/** A fake tx: its bytes name its nullifiers, so the node can refuse a second spend of one. */
export function txBytesFor(nullifiers: string[]): Buffer {
  return Buffer.from(JSON.stringify({ salt: randomBytes(16).toString("hex"), nullifiers }));
}

export const hashOfBytes = (bytes: Buffer) => "0x" + createHash("sha256").update(bytes).digest("hex");

/**
 * The node and the PXE's view of it, shared across every backend (i.e. across
 * restarts). The node mines each accepted tx in its own block and refuses a tx
 * that repeats a nullifier already on chain, as Aztec's does. The PXE sees
 * blocks up to `block - pxeLag` and selects the account's lowest note it has
 * not seen spent: it knows nothing of a tx that is journaled or sent but not in
 * a block it has synced.
 */
export class FakeNode {
  readonly sent: string[] = [];
  readonly sentBytes: Buffer[] = [];
  readonly rejected: string[] = [];
  readonly mined = new Map<string, { block: number; nullifiers: string[] }>();
  minedStatus: "finalized" | "proposed" = "finalized";
  block = 0;
  pxeLag = 0;

  pxeBlock(): number {
    return this.block - this.pxeLag;
  }

  /** The lowest note the PXE believes unspent. */
  pxeNote(): number {
    const seen = new Set<string>();
    for (const tx of this.mined.values()) if (tx.block <= this.pxeBlock()) tx.nullifiers.forEach((n) => seen.add(n));
    let k = 0;
    while (seen.has(noteNullifier(k))) k += 1;
    return k;
  }

  sendTx(txBytes: Buffer): void {
    const hash = hashOfBytes(txBytes);
    const { nullifiers } = JSON.parse(txBytes.toString()) as { nullifiers: string[] };
    const onChain = new Set([...this.mined.values()].flatMap((tx) => tx.nullifiers));
    if (nullifiers.some((n) => onChain.has(n))) {
      this.rejected.push(hash);
      throw new Error("Existing nullifier");
    }
    this.block += 1;
    this.mined.set(hash, { block: this.block, nullifiers });
    this.sent.push(hash);
    this.sentBytes.push(txBytes);
  }

  observe(txHash: string): NodeObservation {
    const tx = this.mined.get(txHash);
    if (!tx) return { kind: "dropped" };
    return {
      kind: "mined",
      executionResult: "success",
      blockHash: "0x" + tx.block.toString(16).padStart(64, "0"),
      blockNumber: String(tx.block),
      receiptStatus: this.minedStatus,
      effects: { state: "available", noteHashes: [], nullifiers: tx.nullifiers },
    };
  }
}

export type Step = "simulate" | "sign" | "prove" | "send";

/**
 * The PXE / enclave / node boundary, faked. `crashAt` makes that step never
 * settle (the process died there); `throwAt` makes it fail. Each prove yields a
 * fresh hash, as a real proof with a fresh seed capsule does, and spends the
 * note the simulation selected.
 */
export class FakeBackend implements OxideBackend {
  readonly account = SENDER;
  readonly calls: Step[] = [];
  crashAt: Step | undefined;
  throwAt: Step | undefined;
  expiration = BigInt(Math.floor(T0 / 1000) + 86_400);
  recipientAmountOverride: bigint | undefined;
  /** Spend this note instead of the one the PXE would select (an account holding several). */
  forceNote: number | undefined;
  /** True: a `crashAt: "send"` dies after the mark but before the node saw the bytes. */
  crashBeforeNode = false;

  constructor(readonly node: FakeNode) {}

  private step<T>(name: Step, value: () => T): Promise<T> {
    this.calls.push(name);
    if (this.crashAt === name) return new Promise<T>(() => {});
    if (this.throwAt === name) return Promise.reject(new Error(`${name} failed`));
    return Promise.resolve(value());
  }

  simulate(payout: OxidePayout): Promise<OxideSimulation> {
    return this.step("simulate", () => {
      const note = this.forceNote ?? this.node.pxeNote();
      const nullifiers = ["0x" + randomBytes(32).toString("hex"), noteNullifier(note)];
      return {
        summary: {
          nullifiers,
          anchorBlockNumber: this.node.pxeBlock(),
          createdNotes: [
            { owner: SENDER, amount: 0n },
            { owner: payout.recipient, amount: this.recipientAmountOverride ?? payout.amount },
          ],
          spentNoteOwners: [SENDER],
          depositRecipients: [],
          withdrawals: 0,
        },
        handle: { payout, nullifiers },
      };
    });
  }

  sign(simulation: OxideSimulation): Promise<OxideSigned> {
    return this.step("sign", () => ({ handle: simulation.handle }));
  }

  prove(signed: OxideSigned): Promise<OxideProvenTx> {
    return this.step("prove", () => {
      const { payout, nullifiers } = signed.handle as { payout: OxidePayout; nullifiers: string[] };
      const txBytes = txBytesFor(nullifiers);
      return {
        txHash: hashOfBytes(txBytes),
        txBytes,
        expirationTimestamp: this.expiration,
        evidence: evidenceFor(payout, nullifiers),
      };
    });
  }

  send(txBytes: Buffer): Promise<void> {
    this.calls.push("send");
    if (this.throwAt === "send") return Promise.reject(new Error("send failed"));
    if (this.crashAt === "send" && this.crashBeforeNode) return new Promise(() => {});
    try {
      this.node.sendTx(txBytes);
    } catch (cause) {
      return Promise.reject(cause);
    }
    if (this.crashAt === "send") return new Promise(() => {});
    return Promise.resolve();
  }

  observe(txHash: string): Promise<NodeObservation> {
    return Promise.resolve(this.node.observe(txHash));
  }
}

/** A gate that allows everything, or hangs / denies on demand, and records what it was asked. */
export function fakeGate(decision: "allow" | "deny" | "unknown" | "hang" = "allow") {
  const queries: MayBroadcastQuery[] = [];
  const state = { decision };
  const client: MayBroadcastClient = (query) => {
    queries.push(query);
    if (state.decision === "hang") return new Promise(() => {});
    return Promise.resolve({ decision: state.decision, detail: "test" });
  };
  return { client, queries, state };
}

export const noPreflight = { assertPinned: () => Promise.resolve() };

/** A settable clock shared by the journal and the sender. */
export function clock(start = T0) {
  const c = { t: start, now: () => c.t };
  return c;
}
