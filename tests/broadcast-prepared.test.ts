import { describe, expect, it, vi } from "vitest";
import { TokenContract } from "@aztec-labs/noir-contracts.js/Token";
import { FunctionSelector } from "@aztec-labs/aztec.js/abi";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { HashedValues, Tx } from "@aztec-labs/stdlib/tx";
import { mockTx } from "@aztec-labs/stdlib/testing";
import { AztecClient } from "../src/aztec-client.js";
import { partialNoteCommitment, randomnessHex } from "../src/partial-note.js";
import type { BroadcastGate, JournaledTransfer, PreparedTransaction } from "../src/types.js";

// Test-only key well under the BN254 Fr modulus -- never use with real funds.
const KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";
const AMOUNT = 1_000n;

/**
 * A real Tx shaped like a payout: one `_finalize_transfer_to_private_unsafe(from, amount, C)`
 * call on the token, with `C` opened by `randomness` for `recipient`. Its hash is computed
 * from its data, as a proof's is.
 */
async function payoutTx(from: AztecAddress, token: AztecAddress, recipient: AztecAddress, randomness: Fr): Promise<Tx> {
  const fn = TokenContract.artifact.nonDispatchPublicFunctions.find(
    (f) => f.name === "_finalize_transfer_to_private_unsafe",
  )!;
  const selector = (await FunctionSelector.fromNameAndParameters(fn.name, fn.parameters)).toField();
  const commitment = await partialNoteCommitment(recipient.toField(), randomness);
  const calldata = await HashedValues.fromCalldata([selector, from.toField(), new Fr(AMOUNT), commitment]);
  const base = await mockTx(7, { numberOfNonRevertiblePublicCallRequests: 0, numberOfRevertiblePublicCallRequests: 1 });
  Object.assign(base.data.forPublic!.revertibleAccumulatedData.publicCallRequests[0]!, {
    contractAddress: token,
    calldataHash: calldata.hash,
  });
  return Tx.create({
    data: base.data,
    chonkProof: base.chonkProof,
    contractClassLogFields: [],
    publicFunctionCalldata: [calldata],
  });
}

/** `tx` with another expiry, re-serialized under its ORIGINAL stored hash: only the expiry bytes differ. */
function withExpiryUnderStoredHash(tx: Tx, expiry: bigint): Buffer {
  const altered = Tx.fromBuffer(tx.toBuffer());
  Object.assign(altered.data, { expirationTimestamp: expiry });
  return altered.toBuffer();
}

async function harness() {
  const from = await AztecAddress.random();
  const token = await AztecAddress.random();
  const recipient = await AztecAddress.random();
  const randomness = Fr.random();
  const tx = await payoutTx(from, token, recipient, randomness);

  const client = new AztecClient("http://localhost:8080", KEY);
  const sendTx = vi.fn(async (_tx: Tx) => {
    // Stop here: reaching the node is what the tests observe.
    throw new Error("node reached");
  });
  Object.assign(client as unknown as { node: unknown; solverAddress: AztecAddress }, {
    node: { sendTx },
    solverAddress: from,
  });

  const asked: PreparedTransaction[] = [];
  const gate: BroadcastGate = {
    beforeBroadcast: async (prepared) => {
      asked.push(prepared);
    },
    beforeSend: () => undefined,
  };

  const journaled = (overrides: Partial<JournaledTransfer> = {}): JournaledTransfer => ({
    recipient: recipient.toString(),
    token: token.toString(),
    amount: AMOUNT.toString(),
    txBytes: tx.toBuffer(),
    partialNoteRandomness: randomnessHex(randomness),
    txHash: tx.getTxHash().toString().toLowerCase(),
    expirationTimestamp: tx.data.expirationTimestamp.toString(),
    ...overrides,
  });
  return { client, tx, gate, asked, sendTx, journaled };
}

describe("broadcastPrepared re-identifies the journaled bytes before the gate (real codec)", () => {
  it("passes untampered journaled bytes to the gate and the node", async () => {
    const { client, tx, gate, asked, sendTx, journaled } = await harness();
    await expect(client.broadcastPrepared(journaled(), gate)).rejects.toThrow("node reached");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.txHash).toBe(tx.getTxHash().toString().toLowerCase());
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("refuses bytes whose expiry was changed under the stored hash", async () => {
    const { client, tx, gate, asked, sendTx, journaled } = await harness();
    const tampered = withExpiryUnderStoredHash(tx, tx.data.expirationTimestamp + 3_600n);
    // Same stored prefix: Tx.fromBuffer(...).getTxHash() alone still names the journaled hash.
    expect(Tx.fromBuffer(tampered).getTxHash().equals(tx.getTxHash())).toBe(true);

    await expect(client.broadcastPrepared(journaled({ txBytes: tampered }), gate)).rejects.toMatchObject({
      name: "JournaledBytesMismatch",
      detail: "stored_hash",
    });
    expect(asked).toEqual([]);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("refuses bytes with one byte flipped after the hash prefix", async () => {
    const { client, tx, gate, asked, sendTx, journaled } = await harness();
    const original = tx.toBuffer();
    // Locate the expiry field by diffing against a copy whose expiry alone differs.
    const moved = withExpiryUnderStoredHash(tx, tx.data.expirationTimestamp ^ 1n);
    const changed = [...original.keys()].filter((i) => original[i] !== moved[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]!).toBeGreaterThanOrEqual(32);
    const flipped = Buffer.from(original);
    flipped[changed[0]!]! ^= 0x01;

    await expect(client.broadcastPrepared(journaled({ txBytes: flipped }), gate)).rejects.toMatchObject({
      name: "JournaledBytesMismatch",
    });
    expect(asked).toEqual([]);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("refuses self-consistent bytes of another transaction than the journaled hash", async () => {
    const { client, tx, gate, asked, sendTx, journaled } = await harness();
    const other = await Tx.create({
      data: Object.assign(Tx.fromBuffer(tx.toBuffer()).data, {
        expirationTimestamp: tx.data.expirationTimestamp + 3_600n,
      }),
      chonkProof: tx.chonkProof,
      contractClassLogFields: tx.contractClassLogFields,
      publicFunctionCalldata: tx.publicFunctionCalldata,
    });
    await expect(client.broadcastPrepared(journaled({ txBytes: other.toBuffer() }), gate)).rejects.toMatchObject({
      name: "JournaledBytesMismatch",
      detail: "journaled_hash",
    });
    expect(asked).toEqual([]);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("refuses bytes whose expiry is not the journaled expiry", async () => {
    const { client, tx, gate, asked, sendTx, journaled } = await harness();
    const later = (tx.data.expirationTimestamp + 1n).toString();
    await expect(client.broadcastPrepared(journaled({ expirationTimestamp: later }), gate)).rejects.toMatchObject({
      name: "JournaledBytesMismatch",
      detail: "expiration",
    });
    expect(asked).toEqual([]);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("refuses bytes that do not decode as a transaction", async () => {
    const { client, tx, gate, asked, sendTx, journaled } = await harness();
    const truncated = tx.toBuffer().subarray(0, 64);
    await expect(client.broadcastPrepared(journaled({ txBytes: truncated }), gate)).rejects.toMatchObject({
      name: "JournaledBytesMismatch",
      detail: "undecodable",
    });
    expect(asked).toEqual([]);
    expect(sendTx).not.toHaveBeenCalled();
  });
});
