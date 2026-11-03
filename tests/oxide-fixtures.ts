import { createHash, randomBytes } from "node:crypto";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import type { MayBroadcastClient, MayBroadcastQuery } from "../src/may-broadcast.js";
import { CreateNoteSchema, SETTLEMENT_VERSION, termsFrom, type NodeObservation, type SettlementTerms } from "../src/settlement.js";
import { DAI, type OxideCapsConfig } from "../src/oxide/caps.js";
import type { OxideSendEvidence } from "../src/oxide/operation.js";
import { oxideSiloedNoteHash, oxideUniqueNoteHash } from "../src/oxide/payout-proof.js";
import { OXIDE_V6_MAINNET } from "../src/oxide/pins.js";
import type { OxideAdmissionVerdict } from "../src/oxide/readiness.js";
import type { OxideAdmission } from "../src/oxide/sender.js";
import { CORRIDOR, DESCRIPTOR_DIGEST } from "./settlement-fixtures.js";
import {
  type OxideBackend,
  type OxidePayout,
  type OxideProvenTx,
  type OxideSigned,
  type OxideSimulation,
  type OxideSized,
} from "../src/oxide/sender.js";
import { JournaledBytesMismatch, type TxIdentity } from "../src/tx-identity.js";

/** The fee limit every fake proof declares: `evidenceFor`'s gas (606,480 L2 gas x 2 gwei, no DA fee). */
export const FEE_LIMIT = 606_480n * 2_000_000_000n;
/** The fee limit of the simulated transfer alone (505,400 L2 gas): the floor checked before the enclave. */
export const FEE_FLOOR = 505_400n * 2_000_000_000n;
/** The node's per-tx gas limit at the same fee: the most one send can be charged. */
export const MAX_SEND_FEE_LIMIT = 6_540_000n * 2_000_000_000n;

export { tempJournalPath } from "./settlement-fixtures.js";

export const SENDER = "0x" + "11".repeat(32);
export const RECIPIENT = "0x" + "22".repeat(32);
/** The pinned Oxide network, as a request names it (the node's identity in the rpc tests). */
export const OXIDE_NETWORK = {
  aztecChainId: OXIDE_V6_MAINNET.l1ChainId.toString(),
  protocolVersion: OXIDE_V6_MAINNET.rollupVersion.toString(),
  rollupAddress: OXIDE_V6_MAINNET.rollupAddress,
  l1ChainId: OXIDE_V6_MAINNET.l1ChainId.toString(),
};
export const T0 = 1_800_000_000_000;

export const CAPS: OxideCapsConfig = {
  maxPerTx: 1_000n * DAI,
  dailyLimit: 10_000n * DAI,
  maxNoteAmount: OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount,
};

/** A `pxe-bridge.settlement.v2` createNote payload for the Oxide sender. */
export function oxideParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: SETTLEMENT_VERSION,
    operationId: "op-1",
    network: { ...OXIDE_NETWORK, genesisOrNetworkDigest: CORRIDOR.genesisOrNetworkDigest },
    corridor: {
      corridorId: CORRIDOR.corridorId,
      corridorRevision: CORRIDOR.corridorRevision,
      manifestDigest: CORRIDOR.manifestDigest,
    },
    accountMode: "standard",
    sendMode: "oxide",
    recipient: RECIPIENT,
    recipientDescriptorDigest: DESCRIPTOR_DIGEST,
    token: OXIDE_V6_MAINNET.bridge.l2Token,
    amount: (100n * DAI).toString(),
    validUntil: Math.floor(T0 / 1000) + 600,
    ...overrides,
  };
}

/** What `OxideSender.send` is asked: an operation id and its canonical v2 terms. */
export function request(
  overrides: Partial<{ operationId: string; amount: string; validUntil: number; recipient: string }> = {},
): { operationId: string; terms: SettlementTerms } {
  const params = CreateNoteSchema.parse(oxideParams(overrides));
  return { operationId: params.operationId, terms: termsFrom(params) };
}

/** An admission that answers `verdict` (default: admitted) and records what it was asked. */
export function fakeAdmission(verdict: OxideAdmissionVerdict = { kind: "admitted" }) {
  const asked: { recipient: string; amount: string }[] = [];
  const state = { verdict };
  const admission: OxideAdmission = {
    admit: (terms) => {
      asked.push(terms);
      return Promise.resolve(state.verdict);
    },
  };
  return { admission, asked, state };
}

export function evidenceFor(
  payout: { recipient: string; amount: bigint },
  txNullifiers: string[] = [randomField()],
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

/** A random field element (31 bytes: always below the BN254 modulus), as every nullifier and note hash is. */
export const randomField = () => "0x" + randomBytes(31).toString("hex").padStart(64, "0");

/**
 * A fake tx: its bytes name its nullifiers (so the node can refuse a second
 * spend of one), its protocol expiry, and the note hashes a node would
 * publish for it (`noteHashes`; `duplicatedNoteHashes` repeats the payout's).
 */
export function txBytesFor(
  nullifiers: string[],
  expiration?: bigint,
  noteHashes: { published: string[]; duplicated: string[] } = { published: [], duplicated: [] },
): Buffer {
  return Buffer.from(
    JSON.stringify({
      salt: randomBytes(16).toString("hex"),
      nullifiers,
      expiration: expiration?.toString(),
      noteHashes: noteHashes.published,
      duplicatedNoteHashes: noteHashes.duplicated,
    }),
  );
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
  readonly mined = new Map<
    string,
    { block: number; nullifiers: string[]; noteHashes: string[]; duplicatedNoteHashes: string[] }
  >();
  minedStatus: "finalized" | "proposed" = "finalized";
  executionResult: "success" | "reverted" = "success";
  /**
   * What the mined effects show of the payout's note hash: published once at
   * its position, absent, published at two positions, or effects unavailable.
   */
  payoutNoteHash: "published" | "absent" | "duplicated" | "unavailable" = "published";
  block = 0;
  pxeLag = 0;
  /** The sending account's public fee juice balance. Ample unless a test sets it. */
  feeJuice = 10n ** 24n;
  /** True: the balance read fails (node unreachable). */
  feeJuiceUnreadable = false;

  readFeeJuice(): bigint {
    if (this.feeJuiceUnreadable) throw new Error("fee juice read failed");
    return this.feeJuice;
  }

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
    const { nullifiers, noteHashes, duplicatedNoteHashes } = JSON.parse(txBytes.toString()) as {
      nullifiers: string[];
      noteHashes?: string[];
      duplicatedNoteHashes?: string[];
    };
    const onChain = new Set([...this.mined.values()].flatMap((tx) => tx.nullifiers));
    if (nullifiers.some((n) => onChain.has(n))) {
      this.rejected.push(hash);
      throw new Error("Existing nullifier");
    }
    this.block += 1;
    this.mined.set(hash, {
      block: this.block,
      nullifiers,
      noteHashes: noteHashes ?? [],
      duplicatedNoteHashes: duplicatedNoteHashes ?? [],
    });
    this.sent.push(hash);
    this.sentBytes.push(txBytes);
  }

  observe(txHash: string): NodeObservation {
    const tx = this.mined.get(txHash);
    if (!tx) return { kind: "dropped" };
    const published = tx.noteHashes;
    const noteHashes =
      this.payoutNoteHash === "duplicated"
        ? tx.duplicatedNoteHashes
        : this.payoutNoteHash === "absent"
          ? published.filter((_, i) => i !== PAYOUT_NOTE_HASH_INDEX)
          : published;
    return {
      kind: "mined",
      executionResult: this.executionResult,
      blockHash: "0x" + tx.block.toString(16).padStart(64, "0"),
      blockNumber: String(tx.block),
      receiptStatus: this.minedStatus,
      effects: {
        state: this.payoutNoteHash === "unavailable" ? "unavailable" : "available",
        noteHashes: this.payoutNoteHash === "unavailable" ? [] : noteHashes,
        nullifiers: tx.nullifiers,
      },
    };
  }
}

/** Where a fake tx publishes the payout's unique note hash: a fee note before it, change after it. */
export const PAYOUT_NOTE_HASH_INDEX = 1;

/**
 * The note hashes a node publishes for a send paying `siloed` in a tx whose
 * first nullifier is `firstNullifier`, computed with the 6.0.0 hashes: filler
 * around the payout's unique note hash at `PAYOUT_NOTE_HASH_INDEX`, and the
 * same with it repeated at the next position (two identical notes).
 */
export async function publishedNoteHashes(
  siloed: Fr,
  firstNullifier: string,
): Promise<{ published: string[]; duplicated: string[] }> {
  const first = Fr.fromString(firstNullifier);
  const at = async (i: number) => (await oxideUniqueNoteHash(siloed, first, i)).toString();
  const fee = randomField();
  const change = randomField();
  return {
    published: [fee, await at(PAYOUT_NOTE_HASH_INDEX), change],
    duplicated: [fee, await at(PAYOUT_NOTE_HASH_INDEX), await at(PAYOUT_NOTE_HASH_INDEX + 1)],
  };
}

export type Step = "simulate" | "sign" | "size" | "prove" | "send";

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
  /** Replaces what `identify` answers for journaled bytes (bytes whose stored hash survives but whose data changed). */
  identityOverride: ((txBytes: Buffer) => TxIdentity) | undefined;
  /** True: a `crashAt: "send"` dies after the mark but before the node saw the bytes. */
  crashBeforeNode = false;

  constructor(readonly node: FakeNode) {}

  private step<T>(name: Step, value: () => T | Promise<T>): Promise<T> {
    this.calls.push(name);
    if (this.crashAt === name) return new Promise<T>(() => {});
    if (this.throwAt === name) return Promise.reject(new Error(`${name} failed`));
    return Promise.resolve(value());
  }

  /** Every payout the sender asked to simulate (the order fingerprint it carries included). */
  readonly simulated: OxidePayout[] = [];

  simulate(payout: OxidePayout): Promise<OxideSimulation> {
    this.simulated.push(payout);
    return this.step("simulate", () => {
      const note = this.forceNote ?? this.node.pxeNote();
      const nullifiers = [randomField(), noteNullifier(note)];
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
        feeLimitFloor: FEE_FLOOR,
        handle: { payout, nullifiers },
      };
    });
  }

  sign(simulation: OxideSimulation): Promise<OxideSigned> {
    return this.step("sign", () => ({ handle: simulation.handle }));
  }

  size(signed: OxideSigned): Promise<OxideSized> {
    return this.step("size", () => ({ feeLimit: FEE_LIMIT, handle: signed.handle }));
  }

  prove(sized: OxideSized): Promise<OxideProvenTx> {
    return this.step("prove", async () => {
      const { payout, nullifiers } = sized.handle as { payout: OxidePayout; nullifiers: string[] };
      // The recipient note the enclave signs: the real Oxide siloed hash of
      // (recipient, OXDAI, amount, randomness), published by the node as its
      // unique note hash under the tx's first nullifier.
      const evidence = evidenceFor(payout, nullifiers);
      const note = evidence.createdNotes[evidence.recipientNoteIndex]!;
      const siloed = await oxideSiloedNoteHash({
        recipient: note.owner,
        token: OXIDE_V6_MAINNET.bridge.l2Token,
        amount: BigInt(note.amount),
        randomness: note.randomness,
      });
      evidence.teeNotes[evidence.recipientNoteIndex] = siloed.toString();
      const txBytes = txBytesFor(nullifiers, this.expiration, await publishedNoteHashes(siloed, nullifiers[0]!));
      return { txHash: hashOfBytes(txBytes), txBytes, expirationTimestamp: this.expiration, evidence };
    });
  }

  identify(txBytes: Buffer): Promise<TxIdentity> {
    if (this.identityOverride) return Promise.resolve(this.identityOverride(txBytes));
    const { expiration } = JSON.parse(txBytes.toString()) as { expiration?: string };
    if (expiration === undefined) return Promise.reject(new JournaledBytesMismatch("undecodable"));
    return Promise.resolve({ txHash: hashOfBytes(txBytes), expirationTimestamp: BigInt(expiration) });
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

  feeJuiceBalance(): Promise<bigint> {
    try {
      return Promise.resolve(this.node.readFeeJuice());
    } catch (cause) {
      return Promise.reject(cause);
    }
  }

  maxSendFeeLimit(): Promise<bigint> {
    return Promise.resolve(MAX_SEND_FEE_LIMIT);
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
