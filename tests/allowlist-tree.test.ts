import { describe, it, expect, beforeAll } from "vitest";
import { Fr } from "@aztec/foundation/curves/bn254";
import { poseidon2HashWithSeparator } from "@aztec/foundation/crypto/poseidon";
import {
  ALLOWLIST_CAPACITY,
  ALLOWLIST_TREE_HEIGHT,
  AllowlistTree,
  DOM_SEP_ALLOWLIST_LEAF,
  DOM_SEP_MERKLE_HASH,
  allowlistLeaf,
  rootFromSiblingPath,
} from "../src/allowlist-tree.js";

const SEED = "0x" + "07".repeat(32);
const A = "0x" + "11".repeat(32);
const B = "0x" + "22".repeat(32);
const UNLISTED = "0x" + "13".repeat(32);

describe("allowlist leaf and node hashing", () => {
  /**
   * CROSS-CHECK against the Noir contract.
   *
   * The bridge builds the tree and the contract only ever verifies paths, so
   * the two implementations never meet at runtime. A mismatched domain
   * separator or a swapped argument order produces witnesses that reproduce a
   * different root, and every transfer fails on the root comparison in public
   * with nothing naming the cause.
   *
   * The identical values are pinned in main.nr's
   * `leaf_and_node_hashes_match_typescript`. Changing one side without the
   * other fails a test here or there. Modelled on Aztec's own
   * test_merkle_roots_match_typescript.
   */
  it("matches the values pinned in main.nr", async () => {
    const a = new Fr(0xaaaan);
    const saltA = new Fr(0x1111n);
    const b = new Fr(0xbbbbn);
    const saltB = new Fr(0x2222n);

    const leafA = await allowlistLeaf(a, saltA);
    const leafB = await allowlistLeaf(b, saltB);

    expect(leafA.toString()).toBe(
      "0x2b3ecd2e783b91419ce504e161af3369b15693052b8d91053c11ae18713e866c",
    );
    expect(leafB.toString()).toBe(
      "0x153a2305b86080c96c3097c14ea9c839f2bba69bf3d2d975e59f7dabf5fe6179",
    );
    expect(
      (await poseidon2HashWithSeparator([leafA, leafB], DOM_SEP_MERKLE_HASH)).toString(),
    ).toBe("0x133cf86ffe27a4828f3f6691affe6b955c8daac660e3b5221fffacf70eee5d2c");
    // An empty position commits to the zero address, not to zero.
    expect((await allowlistLeaf(Fr.ZERO, new Fr(0x5555n))).toString()).toBe(
      "0x0652dcfe4f122ce546e2328a45993c0fb0d23fc3a369433596fa3641255228ad",
    );
  });

  // Pins the constants themselves, so a typo is a failing test rather than a
  // tree that silently disagrees with the contract.
  it("pins the domain separators and the height", () => {
    expect(DOM_SEP_ALLOWLIST_LEAF).toBe(10043);
    expect(DOM_SEP_MERKLE_HASH).toBe(2982624097);
    expect(ALLOWLIST_TREE_HEIGHT).toBe(10);
    expect(ALLOWLIST_CAPACITY).toBe(1024);
  });

  // Leaves and internal nodes must not share a hash. Without the domain split,
  // an internal node is a well-formed leaf and a path one level short proves
  // membership of something that is not a recipient.
  it("separates leaf hashing from node hashing", async () => {
    const x = new Fr(0xaaaan);
    const y = new Fr(0x1111n);
    expect((await allowlistLeaf(x, y)).toString()).not.toBe(
      (await poseidon2HashWithSeparator([x, y], DOM_SEP_MERKLE_HASH)).toString(),
    );
  });
});

describe("AllowlistTree", () => {
  let tree: AllowlistTree;

  beforeAll(async () => {
    tree = await AllowlistTree.build(SEED, [
      { address: A, index: 137 },
      { address: B, index: 942 },
    ]);
  });

  it("builds a witness that reproduces the root", async () => {
    const witness = tree.witnessFor(A);
    expect(witness).toBeDefined();

    const reproduced = await rootFromSiblingPath(
      Fr.fromString(A),
      witness!.leafSalt,
      witness!.leafIndex,
      witness!.siblingPath,
    );
    expect(reproduced.toString()).toBe(tree.root.toString());
  });

  it("builds a witness for every listed recipient", async () => {
    for (const address of [A, B]) {
      const witness = tree.witnessFor(address)!;
      const reproduced = await rootFromSiblingPath(
        Fr.fromString(address),
        witness.leafSalt,
        witness.leafIndex,
        witness.siblingPath,
      );
      expect(reproduced.toString()).toBe(tree.root.toString());
    }
  });

  it("has no witness for an unlisted recipient", () => {
    expect(tree.witnessFor(UNLISTED)).toBeUndefined();
  });

  // The address is bound into the leaf, so a real path for one recipient does
  // not verify another. This is what makes the witness safe to leave unsigned.
  it("does not verify one recipient against another's path", async () => {
    const witness = tree.witnessFor(A)!;
    const reproduced = await rootFromSiblingPath(
      Fr.fromString(B),
      witness.leafSalt,
      witness.leafIndex,
      witness.siblingPath,
    );
    expect(reproduced.toString()).not.toBe(tree.root.toString());
  });

  // The salt is bound too, so knowing an address is not enough to build a
  // witness for it.
  it("does not verify a correct recipient with the wrong salt", async () => {
    const witness = tree.witnessFor(A)!;
    const other = tree.witnessFor(B)!;
    const reproduced = await rootFromSiblingPath(
      Fr.fromString(A),
      other.leafSalt,
      witness.leafIndex,
      witness.siblingPath,
    );
    expect(reproduced.toString()).not.toBe(tree.root.toString());
  });

  it("addresses are matched case-insensitively", () => {
    expect(tree.witnessFor(A.toUpperCase().replace("0X", "0x"))).toBeDefined();
  });

  /**
   * THE SET STAYS SECRET. Changing the seed changes every salt and therefore
   * every leaf, so the same recipients at the same positions produce a
   * different root.
   *
   * This is what stops an observer testing candidate addresses against the
   * tree: without the seed they cannot compute any leaf, and the root commits
   * to leaves rather than to addresses.
   */
  it("produces a different root under a different seed", async () => {
    const other = await AllowlistTree.build("0x" + "09".repeat(32), [
      { address: A, index: 137 },
      { address: B, index: 942 },
    ]);
    expect(other.root.toString()).not.toBe(tree.root.toString());
  });

  // Position is part of the commitment, which is why the bridge's configured
  // indices have to match what the admin actually built.
  it("produces a different root when a recipient moves position", async () => {
    const moved = await AllowlistTree.build(SEED, [
      { address: A, index: 138 },
      { address: B, index: 942 },
    ]);
    expect(moved.root.toString()).not.toBe(tree.root.toString());
  });

  // An empty allowlist is a legitimate state with an ordinary non-zero root.
  // The contract's zero-check is about a root nobody built, not about an empty
  // set.
  it("gives an empty allowlist an ordinary non-zero root", async () => {
    const empty = await AllowlistTree.build(SEED, []);
    expect(empty.root.toBigInt()).not.toBe(0n);
    expect(empty.size).toBe(0);
    expect(empty.root.toString()).not.toBe(tree.root.toString());
  });

  // A zero witness proves nothing. It exists so private view simulations, which
  // the SDK routes through the entrypoint with no transfer, can still encode.
  it("gives a zero witness that does not verify", async () => {
    const zero = await AllowlistTree.zeroWitness();
    const reproduced = await rootFromSiblingPath(
      Fr.ZERO,
      zero.leafSalt,
      zero.leafIndex,
      zero.siblingPath,
    );
    expect(reproduced.toString()).not.toBe(tree.root.toString());
  });

  describe("configuration errors", () => {
    // Each of these is silent on chain if it gets through: the tree builds, the
    // root is wrong, and every transfer reverts in public with nothing naming
    // the cause.
    it("rejects a seed that is not 32-byte hex", async () => {
      await expect(AllowlistTree.build("0xdeadbeef", [])).rejects.toThrow("32-byte hex");
    });

    it("rejects a recipient that is not an address", async () => {
      await expect(
        AllowlistTree.build(SEED, [{ address: "0xnope", index: 0 }]),
      ).rejects.toThrow("not 32-byte hex");
    });

    it("rejects an index outside the tree", async () => {
      await expect(
        AllowlistTree.build(SEED, [{ address: A, index: ALLOWLIST_CAPACITY }]),
      ).rejects.toThrow("outside");
    });

    it("rejects two recipients at one index", async () => {
      await expect(
        AllowlistTree.build(SEED, [
          { address: A, index: 5 },
          { address: B, index: 5 },
        ]),
      ).rejects.toThrow("claimed by both");
    });

    // Would silently give one recipient two witnesses, with witnessFor
    // returning an arbitrary one of them.
    it("rejects one recipient at two indices", async () => {
      await expect(
        AllowlistTree.build(SEED, [
          { address: A, index: 5 },
          { address: A, index: 6 },
        ]),
      ).rejects.toThrow("more than one index");
    });
  });
});
