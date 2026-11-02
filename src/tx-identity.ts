import { Tx } from "@aztec-labs/aztec.js/tx";

/** A transaction's identity as the node derives it from the transaction's data. */
export interface TxIdentity {
  /** Lowercase `0x` + 64 hex, recomputed from the data, never read from the stored prefix. */
  txHash: string;
  /** Protocol expiry (unix seconds) inside the data. */
  expirationTimestamp: bigint;
}

/**
 * Which check refused the bytes:
 *
 * - `undecodable`: the bytes do not decode as a transaction.
 * - `stored_hash`: the hash stored at the front of the bytes is not the hash
 *   of their data (the node would refuse them).
 * - `journaled_hash`: the bytes are another transaction than the journaled hash.
 * - `expiration`: their expiry is not the journaled expiry.
 */
export type JournaledBytesMismatchDetail = "undecodable" | "stored_hash" | "journaled_hash" | "expiration";

/** Journaled bytes are not the journaled transaction; nothing was sent and no gate was asked. */
export class JournaledBytesMismatch extends Error {
  constructor(
    readonly detail: JournaledBytesMismatchDetail,
    options?: ErrorOptions,
  ) {
    super(`journaled bytes are not the journaled transaction (${detail}); nothing was sent`, options);
    this.name = "JournaledBytesMismatch";
  }
}

/**
 * The identity of `tx`, its hash recomputed from its data. `Tx.fromBuffer`
 * keeps the hash stored at the front of the bytes and `getTxHash()` returns it
 * as is, so a hash read that way vouches for nothing after the prefix, the
 * expiry included. Throws `stored_hash` when the two differ.
 */
export async function identifyTx(tx: Tx): Promise<TxIdentity> {
  const computed = await Tx.computeTxHash(tx);
  if (!computed.equals(tx.getTxHash())) throw new JournaledBytesMismatch("stored_hash");
  return { txHash: computed.toString().toLowerCase(), expirationTimestamp: tx.data.expirationTimestamp };
}

/** Decodes `txBytes` and identifies the transaction (see `identifyTx`). */
export async function decodeTxBytes(txBytes: Buffer): Promise<{ tx: Tx; identity: TxIdentity }> {
  let tx: Tx;
  try {
    tx = Tx.fromBuffer(txBytes);
  } catch (cause) {
    throw new JournaledBytesMismatch("undecodable", { cause });
  }
  return { tx, identity: await identifyTx(tx) };
}

/**
 * Refuses an identity that is not the journaled one: the hash (compared
 * lowercase) and the expiry (the journal's decimal string) must both match.
 */
export function assertJournaledIdentity(
  identity: TxIdentity,
  journaled: { txHash: string; expirationTimestamp: string },
): void {
  if (identity.txHash.toLowerCase() !== journaled.txHash.toLowerCase()) {
    throw new JournaledBytesMismatch("journaled_hash");
  }
  if (identity.expirationTimestamp.toString() !== journaled.expirationTimestamp) {
    throw new JournaledBytesMismatch("expiration");
  }
}
