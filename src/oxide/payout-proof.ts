import { DomainSeparator } from "@aztec-labs/constants";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { poseidon2Hash, poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon";
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address";
import { computeNoteHashNonce, computeUniqueNoteHash, siloNoteHash } from "@aztec-labs/stdlib/hash";
import type { Effects } from "../settlement.js";
import { computeSiloedNoteHash } from "./vendor/oxide-lib-tee/hash.js";
import { BALANCES_STORAGE_SLOT } from "./vendor/oxide-lib-tee/oxide_constants.gen.js";

/**
 * The Oxide payout proof (pxe-bridge#84, decided 2026-11-03): what an
 * `oxide` mined observation carries so a consumer can prove the payout
 * reached the signed recipient, and how the bridge finds it.
 *
 * The recipient's note is an OxideToken balance note (`oxide_token_lib`
 * `note.nr`): inner hash `P2([amount, owner, BALANCES_STORAGE_SLOT,
 * randomness], DOM_SEP__NOTE_HASH)`, siloed with the token address. Its
 * randomness is `P2([seed, index])` (`randomness.nr`), carried as the
 * observation's `partialNoteRandomness`. In the mined transaction the
 * node publishes the UNIQUE note hash, `computeUniqueNoteHash(
 * computeNoteHashNonce(nullifiers[0], i), siloed)`, at position `i` of
 * `effects.noteHashes`; `payoutNoteHashIndex` is that `i`. The bridge reads it
 * from the mined effects, never from the TokenOperation (whose note order is
 * not the transaction's).
 */

/** `randomness.nr` `next_randomness`: the note randomness the token draws for its `index`-th value. */
export async function oxideNoteRandomness(seed: Fr, index: number): Promise<Fr> {
  return poseidon2Hash([seed, new Fr(BigInt(index))]);
}

export interface OxidePayoutNote {
  recipient: string;
  token: string;
  amount: bigint;
  randomness: string;
}

/**
 * The payout note's inner hash, `note.nr` `compute_inner_note_hash`:
 * `P2([amount, owner, BALANCES_STORAGE_SLOT, randomness], DOM_SEP__NOTE_HASH)`.
 */
export async function oxideInnerNoteHash(note: OxidePayoutNote): Promise<Fr> {
  return poseidon2HashWithSeparator(
    [
      new Fr(note.amount),
      AztecAddress.fromStringUnsafe(note.recipient).toField(),
      new Fr(BALANCES_STORAGE_SLOT),
      Fr.fromString(note.randomness),
    ],
    DomainSeparator.NOTE_HASH,
  );
}

/**
 * The payout note's siloed hash, recomputed with Oxide's own hash (vendored
 * `computeSiloedNoteHash`), and required to equal `siloNoteHash(token,
 * oxideInnerNoteHash)`: the two derivations a consumer may use agree.
 */
export async function oxideSiloedNoteHash(note: OxidePayoutNote): Promise<Fr> {
  const siloed = await computeSiloedNoteHash({
    amount: note.amount,
    owner: AztecAddress.fromStringUnsafe(note.recipient),
    randomness: Fr.fromString(note.randomness),
    l2Token: AztecAddress.fromStringUnsafe(note.token),
  });
  const direct = await siloNoteHash(AztecAddress.fromStringUnsafe(note.token), await oxideInnerNoteHash(note));
  if (!direct.equals(siloed)) throw new Error("Oxide's note hash and the note.nr derivation disagree");
  return siloed;
}

/** The unique note hash a siloed note hash becomes at position `index` of a transaction whose first nullifier is `firstNullifier`. */
export async function oxideUniqueNoteHash(siloed: Fr, firstNullifier: Fr, index: number): Promise<Fr> {
  return computeUniqueNoteHash(await computeNoteHashNonce(firstNullifier, index), siloed);
}

/** Why the payout's position in a mined transaction is not known. Every one holds the payout; none is a refusal of it. */
export type PayoutNoteHashUnresolved =
  | "effects_unavailable"
  | "effects_malformed"
  | "payout_note_hash_absent"
  | "payout_note_hash_duplicated";

export type PayoutNoteHashLocation =
  | { kind: "found"; index: number }
  | { kind: "unresolved"; reason: PayoutNoteHashUnresolved };

/**
 * Finds `i` with `effects.noteHashes[i] = uniqueNoteHash(siloed,
 * effects.nullifiers[0], i)`. Exactly one such position is a location; none,
 * or more than one, is unresolved: a consumer recomputing from any one index
 * could not tell which note it proved.
 */
export async function locatePayoutNoteHash(effects: Effects, siloed: Fr): Promise<PayoutNoteHashLocation> {
  if (effects.state !== "available") return { kind: "unresolved", reason: "effects_unavailable" };
  if (effects.noteHashes.length === 0) return { kind: "unresolved", reason: "payout_note_hash_absent" };
  const first = effects.nullifiers[0];
  if (first === undefined) return { kind: "unresolved", reason: "effects_malformed" };
  let firstNullifier: Fr;
  let published: Fr[];
  try {
    firstNullifier = Fr.fromString(first);
    published = effects.noteHashes.map((h) => Fr.fromString(h));
  } catch {
    return { kind: "unresolved", reason: "effects_malformed" };
  }
  const found: number[] = [];
  for (let i = 0; i < published.length; i += 1) {
    if (published[i]!.equals(await oxideUniqueNoteHash(siloed, firstNullifier, i))) found.push(i);
  }
  if (found.length === 0) return { kind: "unresolved", reason: "payout_note_hash_absent" };
  if (found.length > 1) return { kind: "unresolved", reason: "payout_note_hash_duplicated" };
  return { kind: "found", index: found[0]! };
}
