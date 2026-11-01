import { describe, it, expect } from "vitest";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { SerialQueue } from "@aztec-labs/foundation/queue";
import {
  ORACLE_REGISTRY,
  PrivateExecutionOracle,
  UtilityExecutionOracle,
  buildACIRCallback,
} from "@aztec-labs/pxe/simulator";
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address";
import {
  bindPxeOperations,
  captureRandomness,
  effectsProvePayout,
  finalizeCommitment,
  installRandomnessCapture,
  partialNoteCommitment,
  payoutEvidence,
  randomnessHex,
  selectPartialNoteRandomness,
  takeDrawnRandomness,
  type PublicCall,
} from "../src/partial-note.js";
import { PartialNoteUnresolved } from "../src/types.js";

/**
 * Riddler's `test/support/vectors/aztec_payment_proof.json`, generated from
 * the @aztec-labs 6.0.0 runtime. The bridge's derivation must reproduce it
 * value for value: it is the relation Riddler's `recipient_paid?/2` checks.
 */
const RIDDLER = {
  inputs: {
    token: "0x13b600d8f842babc98a7130dcb79a2d1f4f0ba22569b2fb99f3ecc3b5c39282b",
    recipient: "0x1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c",
    payoutAccount: "0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
    randomness: "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e",
    firstNullifier: "0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
    amount: 1000000n,
    noteHashIndex: 5,
  },
  partialCommitment: "0x29866fe70a7476cce0a0354b2f6d8cb27feff779d3bb9306e0b48fa1e15de584",
  noteHash: "0x044d3b26e38d083ab5b9638fdc4ac25a3dbadf0b62163c55313aa4ac48214351",
  siloedNoteHash: "0x08e3c90f7ea16e1aace9be4a5c743cdaaa100ae934b15653f814b12da93e3df6",
  uniqueNoteHash: "0x1d3bfe41e34123e6d0a6306f4199618ffc6c378bb9eec5d864b164d2112f9c5f",
  siloedValidityNullifier: "0x29e3d7de13b3fe318ce96fff5f4c533af70cfebfb25b61aa7615332d320806c8",
  completionLogTag: "0x2d400ce7e384f5e4d64387d317d8102e062adde6e0c16af5ba7fac679cd51622",
};

const riddlerProof = {
  token: AztecAddress.fromStringUnsafe(RIDDLER.inputs.token),
  recipient: AztecAddress.fromStringUnsafe(RIDDLER.inputs.recipient),
  payoutAccount: AztecAddress.fromStringUnsafe(RIDDLER.inputs.payoutAccount),
  amount: RIDDLER.inputs.amount,
  randomness: Fr.fromString(RIDDLER.inputs.randomness),
};

describe("the payout relation Riddler checks (6.0.0)", () => {
  it("reproduces Riddler's vendored aztec_payment_proof vector", async () => {
    const evidence = await payoutEvidence(riddlerProof);
    expect(evidence.partialCommitment.toString()).toBe(RIDDLER.partialCommitment);
    expect(evidence.noteHash.toString()).toBe(RIDDLER.noteHash);
    expect(evidence.siloedNoteHash.toString()).toBe(RIDDLER.siloedNoteHash);
    expect(
      (await evidence.uniqueNoteHash(Fr.fromString(RIDDLER.inputs.firstNullifier), RIDDLER.inputs.noteHashIndex)).toString(),
    ).toBe(RIDDLER.uniqueNoteHash);
    expect(evidence.siloedValidityNullifier.toString()).toBe(RIDDLER.siloedValidityNullifier);
    expect(evidence.completionLogTag.toString()).toBe(RIDDLER.completionLogTag);
  });

  it("accepts effects holding the payout, and refuses another recipient, amount or account", async () => {
    const effects = {
      noteHashes: ["0x" + "31".repeat(32), RIDDLER.uniqueNoteHash],
      nullifiers: [RIDDLER.inputs.firstNullifier, RIDDLER.siloedValidityNullifier],
    };
    expect(await effectsProvePayout(effects, riddlerProof)).toBe(true);
    const other = AztecAddress.fromStringUnsafe("0x" + "1d".repeat(32));
    expect(await effectsProvePayout(effects, { ...riddlerProof, recipient: other })).toBe(false);
    expect(await effectsProvePayout(effects, { ...riddlerProof, amount: riddlerProof.amount + 1n })).toBe(false);
    expect(await effectsProvePayout(effects, { ...riddlerProof, payoutAccount: other })).toBe(false);
    expect(await effectsProvePayout({ ...effects, nullifiers: [RIDDLER.inputs.firstNullifier] }, riddlerProof)).toBe(
      false,
    );
  });
});

describe("selecting the randomness by the proven commitment", () => {
  const recipient = Fr.fromString(RIDDLER.inputs.recipient);
  const r = Fr.fromString(RIDDLER.inputs.randomness);
  const commitment = Fr.fromString(RIDDLER.partialCommitment);

  it("selects the one drawn value that opens the commitment for the recipient", async () => {
    const drawn = [new Fr(11n), r, new Fr(12n)];
    expect((await selectPartialNoteRandomness(drawn, recipient, commitment)).equals(r)).toBe(true);
    expect(await partialNoteCommitment(recipient, r)).toEqual(commitment);
  });

  it("refuses when no value opens it, including the right value for another recipient", async () => {
    await expect(selectPartialNoteRandomness([new Fr(11n), new Fr(12n)], recipient, commitment)).rejects.toEqual(
      new PartialNoteUnresolved("no_match"),
    );
    await expect(selectPartialNoteRandomness([], recipient, commitment)).rejects.toThrow(PartialNoteUnresolved);
    await expect(selectPartialNoteRandomness([r], new Fr(7n), commitment)).rejects.toMatchObject({
      detail: "no_match",
    });
  });

  it("refuses when more than one draw opens it", async () => {
    await expect(selectPartialNoteRandomness([r, new Fr(11n), r], recipient, commitment)).rejects.toMatchObject({
      detail: "ambiguous",
    });
  });

  it("never names a drawn value in its error", async () => {
    const failure = await selectPartialNoteRandomness([new Fr(11n)], recipient, commitment).catch((e: unknown) => e);
    expect(String((failure as Error).message)).not.toContain(new Fr(11n).toString().slice(2));
    expect(randomnessHex(r)).toBe(RIDDLER.inputs.randomness);
  });
});

describe("reading the commitment from the proven transaction", () => {
  const token = AztecAddress.fromStringUnsafe(RIDDLER.inputs.token);
  const from = AztecAddress.fromStringUnsafe(RIDDLER.inputs.payoutAccount);
  const selector = new Fr(0x730b06a5n);
  const commitment = Fr.fromString(RIDDLER.partialCommitment);
  const finalize = (overrides: Partial<PublicCall> = {}): PublicCall => ({
    contractAddress: token,
    functionSelector: { toField: () => selector },
    args: [from.toField(), new Fr(RIDDLER.inputs.amount), commitment],
    ...overrides,
  });
  const payout = { token, from, amount: RIDDLER.inputs.amount };

  it("takes C from the one finalize call on the token", () => {
    const other = finalize({ functionSelector: { toField: () => new Fr(1n) }, args: [new Fr(9n)] });
    expect(finalizeCommitment([other, finalize()], selector, payout).equals(commitment)).toBe(true);
  });

  it.each([
    ["no finalize call", []],
    ["two finalize calls", [finalize(), finalize()]],
    ["a finalize call on another contract", [finalize({ contractAddress: from })]],
    ["another from", [finalize({ args: [token.toField(), new Fr(RIDDLER.inputs.amount), commitment] })]],
    ["another amount", [finalize({ args: [from.toField(), new Fr(1n), commitment] })]],
    ["a short argument list", [finalize({ args: [from.toField(), new Fr(RIDDLER.inputs.amount)] })]],
  ] as const)("refuses %s", (_name, calls) => {
    expect(() => finalizeCommitment(calls, selector, payout)).toThrow(new PartialNoteUnresolved("no_commitment"));
  });
});

/**
 * HOOK PIN (@aztec-labs 6.0.0). `transfer_to_private` draws its randomness
 * through the `aztec_misc_getRandomField` oracle, which the PXE dispatches to
 * `UtilityExecutionOracle.prototype.getRandomField` (inherited by
 * `PrivateExecutionOracle`). If a future Aztec routes the oracle anywhere
 * else, these fail instead of the bridge silently capturing nothing (it would
 * then refuse every payout as `partial_note_randomness_unresolved`). The e2e
 * payout (tests/e2e/spending-limit.test.ts) pins the same against a real
 * proof.
 */
describe("capturing the oracle's randomness (hook pin, 6.0.0)", () => {
  installRandomnessCapture();

  /** A private-execution handler, as the PXE builds its ACIR callback over one. */
  function privateHandler(): PrivateExecutionOracle {
    return Object.assign(Object.create(PrivateExecutionOracle.prototype) as PrivateExecutionOracle, {
      isMisc: true,
      isUtility: true,
      isPrivate: true,
    });
  }

  it("is installed on the class every private execution inherits it from", () => {
    expect(Object.hasOwn(PrivateExecutionOracle.prototype, "getRandomField")).toBe(false);
    expect(PrivateExecutionOracle.prototype.getRandomField).toBe(UtilityExecutionOracle.prototype.getRandomField);
    expect("aztec_misc_getRandomField" in ORACLE_REGISTRY).toBe(true);
    // Idempotent: a second install does not wrap the wrapper.
    const installed = UtilityExecutionOracle.prototype.getRandomField;
    installRandomnessCapture();
    expect(UtilityExecutionOracle.prototype.getRandomField).toBe(installed);
  });

  it("records exactly what the oracle served the circuit, inside a scope only", async () => {
    const callback = buildACIRCallback(privateHandler()) as unknown as Record<
      string,
      (...inputs: unknown[]) => Promise<unknown>
    >;
    const outside = await callback["aztec_misc_getRandomField"]!();
    expect(outside).toBeDefined();

    const served: unknown[] = [];
    const drawn = await captureRandomness(async () => {
      served.push(await callback["aztec_misc_getRandomField"]!());
      served.push(await callback["aztec_misc_getRandomField"]!());
      return takeDrawnRandomness();
    });
    expect(drawn).toHaveLength(2);
    expect(drawn!.map((v) => v.toString())).toEqual(
      served.map((s) => Fr.fromString(String(Array.isArray(s) ? s[0] : s)).toString()),
    );
    expect(takeDrawnRandomness()).toBeUndefined();
  });

  it("keeps concurrent scopes apart", async () => {
    const handler = privateHandler();
    const scope = (n: number) =>
      captureRandomness(async () => {
        const mine: string[] = [];
        for (let i = 0; i < n; i += 1) {
          mine.push(handler.getRandomField().toString());
          await new Promise((r) => setImmediate(r));
        }
        return { mine, drawn: takeDrawnRandomness()!.map((v) => v.toString()) };
      });
    const [a, b] = await Promise.all([scope(3), scope(4)]);
    expect(a.drawn).toEqual(a.mine);
    expect(b.drawn).toEqual(b.mine);
    // Taken once: the encryption secrets drawn beside the randomness are not kept.
    await captureRandomness(async () => {
      handler.getRandomField();
      expect(takeDrawnRandomness()).toHaveLength(1);
      expect(takeDrawnRandomness()).toEqual([]);
    });
  });

  // The PXE runs every operation from one consumer loop (OperationQueue over
  // foundation's SerialQueue), which loses the caller's async context. Bound,
  // the operation runs in the context of the send that queued it.
  it("reaches into operations the PXE queues once the queue is bound", async () => {
    const serial = new SerialQueue();
    serial.start();
    try {
      const handler = privateHandler();
      const draw = () => Promise.resolve(handler.getRandomField());
      const unbound = { operationQueue: { run: (fn: () => Promise<unknown>) => serial.put(fn) } };
      const lost = await captureRandomness(async () => {
        await unbound.operationQueue.run(draw);
        return takeDrawnRandomness();
      });
      expect(lost).toEqual([]);

      bindPxeOperations(unbound);
      bindPxeOperations(unbound);
      const kept = await captureRandomness(async () => {
        const value = (await unbound.operationQueue.run(draw)) as Fr;
        return { value, drawn: takeDrawnRandomness() };
      });
      expect(kept.drawn).toHaveLength(1);
      expect(kept.drawn![0]!.equals(kept.value)).toBe(true);
    } finally {
      await serial.end();
    }
  });

  it("refuses a PXE with no operation queue to bind", () => {
    expect(() => bindPxeOperations({})).toThrow(/no operation queue/);
    expect(() => bindPxeOperations(null)).toThrow(/no operation queue/);
  });
});
