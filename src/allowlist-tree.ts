/**
 * Client-side Merkle allowlist for the spending-limit account.
 *
 * The account stores one root. The set itself never goes on chain, so the
 * bridge cannot read it back the way it used to read the eight-slot array. It
 * holds the tree, derives a membership witness per transfer, and reconciles its
 * root against the account's `get_allowlist_root` before each send.
 *
 * Every constant and hash here is paired with `main.nr` by hand. Drift is not a
 * type error: it produces witnesses that reproduce a different root, so every
 * transfer fails on the root comparison in `check_spending_public`. The pinning
 * tests in `tests/allowlist-tree.test.ts` are what catch it.
 */

import type { Fr as FrType } from "@aztec/foundation/curves/bn254";

/** Must match ALLOWLIST_TREE_HEIGHT in main.nr. Part of the entrypoint ABI. */
export const ALLOWLIST_TREE_HEIGHT = 10;

/** 2^height. The contract rejects an index at or above this. */
export const ALLOWLIST_CAPACITY = 1 << ALLOWLIST_TREE_HEIGHT;

/** Must match DOM_SEP__ALLOWLIST_LEAF in main.nr. */
export const DOM_SEP_ALLOWLIST_LEAF = 10043;

/**
 * Must match DOM_SEP__MERKLE_HASH in Aztec's protocol types, which is what
 * `merkle_hash` uses for internal nodes and therefore what
 * `root_from_sibling_path` reconstructs with.
 * aztec-packages v5.1.0, noir-protocol-circuits/crates/types/src/constants.nr:772.
 */
export const DOM_SEP_MERKLE_HASH = 2982624097;

/**
 * Salt derivation separator. CLIENT-ONLY: the contract never derives a salt, it
 * only ever sees finished leaves, so this has no counterpart in main.nr.
 */
export const DOM_SEP_ALLOWLIST_SALT = 10044;

/** A recipient and the tree position it occupies. */
export interface AllowlistRecipient {
  /** AztecAddress as 0x-prefixed 64-char hex. */
  address: string;
  /** Leaf position, in [0, ALLOWLIST_CAPACITY). */
  index: number;
}

/** What the entrypoint needs to prove one recipient's membership. */
export interface AllowlistWitness {
  leafSalt: FrType;
  leafIndex: number;
  siblingPath: FrType[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Salts are derived from one secret seed rather than stored per leaf.
 *
 * They have to be secret. Addresses are low-entropy and enumerable, so a
 * publicly derivable salt (the index, say) would let anyone recompute
 * h(candidate, salt) and test it against a leaf, which is the whole thing the
 * commitment exists to prevent. Deriving them means the operator archives one
 * value instead of 1,024, and the empty leaves get distinct salts for free,
 * which is what stops an observer recognising them as empty.
 */
async function deriveSalt(seed: FrType, index: number): Promise<FrType> {
  const { Fr } = await import("@aztec/foundation/curves/bn254");
  const { poseidon2HashWithSeparator } = await import("@aztec/foundation/crypto/poseidon");
  return poseidon2HashWithSeparator([seed, new Fr(BigInt(index))], DOM_SEP_ALLOWLIST_SALT);
}

/** Leaf commitment. Pairs with `allowlist_leaf` in main.nr. */
export async function allowlistLeaf(recipient: FrType, salt: FrType): Promise<FrType> {
  const { poseidon2HashWithSeparator } = await import("@aztec/foundation/crypto/poseidon");
  return poseidon2HashWithSeparator([recipient, salt], DOM_SEP_ALLOWLIST_LEAF);
}

/** Internal node hash. Pairs with `merkle_hash` in Aztec's protocol types. */
async function nodeHash(left: FrType, right: FrType): Promise<FrType> {
  const { poseidon2HashWithSeparator } = await import("@aztec/foundation/crypto/poseidon");
  return poseidon2HashWithSeparator([left, right], DOM_SEP_MERKLE_HASH);
}

/**
 * Rebuild a root from a recipient and its witness.
 *
 * Mirrors `root_from_sibling_path` in Aztec's protocol types, which is what the
 * circuit calls, including its bit order: bit `level` of the index decides
 * which side the running node goes on at that level.
 *
 * Exported because it is the only way to check a witness without a node. The
 * cross-check tests use it to prove the tree and the circuit agree, and it is
 * what an operator script would use to verify a published set against the
 * on-chain root.
 */
export async function rootFromSiblingPath(
  recipient: FrType,
  salt: FrType,
  index: number,
  siblingPath: readonly FrType[],
): Promise<FrType> {
  if (siblingPath.length !== ALLOWLIST_TREE_HEIGHT) {
    throw new Error(
      `sibling path must have ${ALLOWLIST_TREE_HEIGHT} entries, got ${siblingPath.length}`,
    );
  }
  let node = await allowlistLeaf(recipient, salt);
  let remaining = index;
  for (let level = 0; level < ALLOWLIST_TREE_HEIGHT; level++) {
    const sibling = siblingPath[level]!;
    node =
      (remaining & 1) === 1 ? await nodeHash(sibling, node) : await nodeHash(node, sibling);
    remaining >>= 1;
  }
  return node;
}

/**
 * The allowlist, as the bridge holds it.
 *
 * Dense: all ALLOWLIST_CAPACITY leaves are materialised, because per-leaf salts
 * mean there are no canonical empty subtrees to short-circuit. That is what
 * bounds the height, and why it is 10 rather than something larger. Building
 * costs 2 * ALLOWLIST_CAPACITY hashes, roughly 0.7s against this SDK.
 */
export class AllowlistTree {
  private constructor(
    private readonly layers: FrType[][],
    private readonly salts: readonly FrType[],
    private readonly byAddress: Map<string, number>,
  ) {}

  /**
   * Build from a secret seed and the occupied positions.
   *
   * Positions not named here hold h(0, salt) with that position's own salt, so
   * they are indistinguishable from occupied ones to anyone without the seed.
   */
  static async build(
    seed: string,
    recipients: readonly AllowlistRecipient[],
  ): Promise<AllowlistTree> {
    const { Fr } = await import("@aztec/foundation/curves/bn254");

    if (!ADDRESS_RE.test(seed)) {
      throw new Error("Allowlist seed must be 32-byte hex");
    }
    const seedFr = Fr.fromString(seed);

    const occupied = new Map<number, string>();
    for (const { address, index } of recipients) {
      if (!ADDRESS_RE.test(address)) {
        throw new Error(`Allowlist recipient is not 32-byte hex: ${address}`);
      }
      if (!Number.isInteger(index) || index < 0 || index >= ALLOWLIST_CAPACITY) {
        throw new Error(
          `Allowlist index ${index} for ${address} is outside [0, ${ALLOWLIST_CAPACITY})`,
        );
      }
      const existing = occupied.get(index);
      if (existing !== undefined) {
        throw new Error(`Allowlist index ${index} is claimed by both ${existing} and ${address}`);
      }
      occupied.set(index, address.toLowerCase());
    }
    // A duplicate address across two indices would silently give one recipient
    // two witnesses, and witnessFor would return an arbitrary one of them.
    const seen = new Set<string>();
    for (const address of occupied.values()) {
      if (seen.has(address)) {
        throw new Error(`Allowlist recipient appears at more than one index: ${address}`);
      }
      seen.add(address);
    }

    const byAddress = new Map<string, number>();
    const salts: FrType[] = new Array(ALLOWLIST_CAPACITY);
    const leaves: FrType[] = new Array(ALLOWLIST_CAPACITY);
    for (let i = 0; i < ALLOWLIST_CAPACITY; i++) {
      salts[i] = await deriveSalt(seedFr, i);
      const address = occupied.get(i);
      // An unoccupied position commits to the zero address, not to zero. A
      // literal zero leaf is recognisable as empty, and the contract rejects
      // one on the admin path for that reason.
      const recipient = address === undefined ? Fr.ZERO : Fr.fromString(address);
      leaves[i] = await allowlistLeaf(recipient, salts[i]!);
      if (address !== undefined) {
        byAddress.set(address, i);
      }
    }

    const layers: FrType[][] = [leaves];
    for (let level = 0; level < ALLOWLIST_TREE_HEIGHT; level++) {
      const below = layers[level]!;
      const above: FrType[] = new Array(below.length / 2);
      for (let i = 0; i < above.length; i++) {
        above[i] = await nodeHash(below[2 * i]!, below[2 * i + 1]!);
      }
      layers.push(above);
    }

    return new AllowlistTree(layers, salts, byAddress);
  }

  /** The value `check_spending_public` compares against. */
  get root(): FrType {
    return this.layers[ALLOWLIST_TREE_HEIGHT]![0]!;
  }

  /** Recipients this tree can build a witness for, for logging and diagnostics. */
  get size(): number {
    return this.byAddress.size;
  }

  /**
   * Witness for one recipient, or undefined if it is not in the tree.
   *
   * Undefined is not an error here. The caller decides: a real transfer to an
   * unlisted recipient must fail loudly, but the entrypoint also runs for view
   * simulations that carry no transfer at all.
   */
  witnessFor(address: string): AllowlistWitness | undefined {
    const index = this.byAddress.get(address.toLowerCase());
    return index === undefined ? undefined : this.witnessAt(index);
  }

  /**
   * Witness for a POSITION, occupied or not.
   *
   * The admin path needs this: an addition proves the old leaf, which is the
   * commitment to the zero address that the empty position already holds. There
   * is no separate "empty" case, which is the same reason the contract cannot
   * tell an addition from a revocation.
   */
  witnessAt(index: number): AllowlistWitness {
    if (!Number.isInteger(index) || index < 0 || index >= ALLOWLIST_CAPACITY) {
      throw new Error(`index ${index} is outside [0, ${ALLOWLIST_CAPACITY})`);
    }
    const siblingPath: FrType[] = new Array(ALLOWLIST_TREE_HEIGHT);
    let remaining = index;
    for (let level = 0; level < ALLOWLIST_TREE_HEIGHT; level++) {
      // root_from_sibling_path consumes bit `level` of the index to decide
      // which side the running node goes on, so the sibling is the node whose
      // index differs in exactly that bit.
      siblingPath[level] = this.layers[level]![remaining ^ 1]!;
      remaining >>= 1;
    }
    return { leafSalt: this.salts[index]!, leafIndex: index, siblingPath };
  }

  /** The salt at a position, which the admin path needs to rebuild its leaves. */
  saltAt(index: number): FrType {
    if (!Number.isInteger(index) || index < 0 || index >= ALLOWLIST_CAPACITY) {
      throw new Error(`index ${index} is outside [0, ${ALLOWLIST_CAPACITY})`);
    }
    return this.salts[index]!;
  }

  /**
   * A witness that proves nothing, for entrypoint invocations that carry no
   * transfer.
   *
   * The SDK routes private view simulations through the entrypoint, and those
   * arrive with no `transfer_to_private` call and therefore no recipient. The
   * arguments still have to encode. Nothing accepts this: the circuit asserts a
   * non-zero recipient, and the root it produces will not match storage.
   */
  static async zeroWitness(): Promise<AllowlistWitness> {
    const { Fr } = await import("@aztec/foundation/curves/bn254");
    return {
      leafSalt: Fr.ZERO,
      leafIndex: 0,
      siblingPath: new Array(ALLOWLIST_TREE_HEIGHT).fill(Fr.ZERO),
    };
  }
}
