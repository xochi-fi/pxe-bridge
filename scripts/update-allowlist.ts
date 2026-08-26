/**
 * Adds, revokes or substitutes ONE allowlist recipient on the spending-limit
 * account.
 *
 * This script exists because the operation stopped being one a human can do by
 * hand. Under the old array, revoking meant calling
 * `remove_recipient(address)` from any wallet CLI. The allowlist is now a
 * Merkle tree of commitments, so an update needs the position, the old leaf,
 * the new leaf and a sibling path that verifies against the current root, none
 * of which can be typed out. Everything here is derived from the same seed and
 * position list the bridge runs on, so the script and the bridge cannot drift.
 *
 * The contract cannot tell the three operations apart, and neither can an
 * observer: adding, revoking and substituting are all one leaf becoming
 * another. That is the privacy property. It also means the change is IMMEDIATE
 * and there is no proposal to withdraw, so read the plan this prints before
 * confirming.
 *
 * Every root change invalidates transactions already in flight, additions
 * included. Stop accepting sends, run this, then resume.
 *
 * Usage:
 *   npx tsx scripts/update-allowlist.ts --add    0x<address> --index <n>
 *   npx tsx scripts/update-allowlist.ts --revoke 0x<address>
 *
 * Required env:
 *   PXE_BRIDGE_ALLOWLIST_SEED        -- the seed every leaf salt derives from
 *   PXE_BRIDGE_ALLOWLIST_RECIPIENTS  -- the CURRENT set, as the bridge has it
 *   ALLOWLIST_ADMIN_KEY              -- 32-byte hex secret key of the admin
 *   SPENDING_LIMIT_ACCOUNT           -- AztecAddress of the account to update
 *
 * Optional env:
 *   AZTEC_NODE_URL  -- Aztec node (default: http://localhost:8080)
 *
 * After a successful update, change PXE_BRIDGE_ALLOWLIST_RECIPIENTS to the set
 * this prints and restart the bridge. Until you do, the bridge refuses to send:
 * it checks its root against the account's before every transfer.
 */

import { AllowlistTree, allowlistLeaf } from "../src/allowlist-tree.js";
import { AllowlistRecipientsSchema } from "../src/types.js";
import type { AllowlistRecipient } from "../src/allowlist-tree.js";

const NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[update-allowlist] ${name} is required`);
    process.exit(1);
  }
  return value;
}

function fail(message: string): never {
  console.error(`[update-allowlist] ${message}`);
  process.exit(1);
}

interface Plan {
  mode: "add" | "revoke";
  address: string;
  index: number;
}

function parseArgs(argv: readonly string[], current: readonly AllowlistRecipient[]): Plan {
  const addAt = argv.indexOf("--add");
  const revokeAt = argv.indexOf("--revoke");
  if ((addAt === -1) === (revokeAt === -1)) {
    fail("pass exactly one of --add <address> --index <n> or --revoke <address>");
  }

  if (revokeAt !== -1) {
    const address = argv[revokeAt + 1];
    if (!address) fail("--revoke needs an address");
    const existing = current.find((r) => r.address.toLowerCase() === address.toLowerCase());
    if (!existing) {
      fail(
        `${address} is not in PXE_BRIDGE_ALLOWLIST_RECIPIENTS, so there is no leaf to replace. ` +
          `Revoking something the configured set does not contain would produce a path that ` +
          `fails against the stored root.`,
      );
    }
    return { mode: "revoke", address: existing.address, index: existing.index };
  }

  const address = argv[addAt + 1];
  if (!address) fail("--add needs an address");
  const indexAt = argv.indexOf("--index");
  const index = indexAt === -1 ? NaN : Number(argv[indexAt + 1]);
  if (!Number.isInteger(index)) {
    fail(
      "--add needs --index <n>. Choose it at RANDOM from the free positions this script " +
        "lists on failure, not the lowest one: filling left to right makes the first touch " +
        "of a position visibly an addition.",
    );
  }
  if (current.some((r) => r.index === index)) {
    fail(`position ${index} is already occupied. Pick a free one.`);
  }
  if (current.some((r) => r.address.toLowerCase() === address.toLowerCase())) {
    fail(`${address} is already in the allowlist. Revoke it first if you want to move it.`);
  }
  return { mode: "add", address, index };
}

async function main(): Promise<void> {
  const seed = required("PXE_BRIDGE_ALLOWLIST_SEED");
  const account = required("SPENDING_LIMIT_ACCOUNT");
  const adminKey = required("ALLOWLIST_ADMIN_KEY");

  const parsed = AllowlistRecipientsSchema.safeParse(
    JSON.parse(required("PXE_BRIDGE_ALLOWLIST_RECIPIENTS")),
  );
  if (!parsed.success) {
    fail(
      "PXE_BRIDGE_ALLOWLIST_RECIPIENTS is malformed: " +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const current = parsed.data;
  const plan = parseArgs(process.argv.slice(2), current);

  const { Fr } = await import("@aztec/foundation/curves/bn254");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const { EmbeddedWallet } = await import("@aztec/wallets/embedded");
  const { Contract } = await import("@aztec/aztec.js/contracts");
  const { SpendingLimitAccountContract } = await import("../src/spending-limit-account.js");
  const { deriveAccountKeys } = await import("../src/aztec-client.js");

  // The tree as it stands. The witness for the position being changed is what
  // proves to the contract that nothing else moved.
  const before = await AllowlistTree.build(seed, current);

  // Whichever direction, one leaf becomes another. An empty position commits
  // to the zero address under that position's own salt, so the "before" tree
  // already holds the leaf an addition replaces.
  const salt = before.saltAt(plan.index);
  const [oldRecipient, newRecipient] =
    plan.mode === "add"
      ? [Fr.ZERO, Fr.fromString(plan.address)]
      : [Fr.fromString(plan.address), Fr.ZERO];

  const oldLeaf = await allowlistLeaf(oldRecipient, salt);
  const newLeaf = await allowlistLeaf(newRecipient, salt);
  const witness = before.witnessAt(plan.index);

  const after = await AllowlistTree.build(
    seed,
    plan.mode === "add"
      ? [...current, { address: plan.address, index: plan.index }]
      : current.filter((r) => r.index !== plan.index),
  );

  console.log(`[update-allowlist] ${plan.mode}: ${plan.address} at position ${plan.index}`);
  console.log(`[update-allowlist] account:  ${account}`);
  console.log(`[update-allowlist] root now: ${before.root.toString()}`);
  console.log(`[update-allowlist] root after: ${after.root.toString()}`);
  console.log(
    "[update-allowlist] this takes effect immediately and invalidates every transaction " +
      "already in flight",
  );

  // The admin is an ordinary Schnorr account, derived exactly the way the
  // bridge derives its own, so this script and the bridge cannot disagree about
  // which address a key produces.
  const wallet = await EmbeddedWallet.create(NODE_URL);
  const { secret, salt: accountSalt, signingKey } = await deriveAccountKeys(adminKey);
  const manager = await wallet.createSchnorrAccount(secret, accountSalt, signingKey);
  const adminAddress = (await manager.getAccount()).getAddress();
  console.log(`[update-allowlist] admin:    ${adminAddress.toString()}`);

  // Only the artifact is wanted here. update_recipient is a public function the
  // admin calls directly, not through the spending-limit entrypoint, so the
  // limits below are never read by anything.
  const artifact = await new SpendingLimitAccountContract(signingKey, {
    maxAmountPerTx: 1n,
    dailyLimit: 1n,
    admin: adminAddress.toString(),
    token: "0x" + "0".repeat(63) + "1",
    allowlistSeed: seed,
    allowlistRecipients: current,
  }).getContractArtifact();

  const contract = await Contract.at(
    AztecAddress.fromStringUnsafe(account) as Parameters<typeof Contract.at>[0],
    artifact as Parameters<typeof Contract.at>[1],
    wallet as unknown as Parameters<typeof Contract.at>[2],
  );

  // The contract verifies the path against its CURRENT root before recomputing,
  // so a stale configured set fails here rather than committing a wrong root.
  await contract.methods["update_recipient"]!(
    plan.index,
    oldLeaf,
    newLeaf,
    witness.siblingPath,
  ).send({ from: adminAddress });

  const nextConfig =
    plan.mode === "add"
      ? [...current, { address: plan.address, index: plan.index }]
      : current.filter((r) => r.index !== plan.index);

  console.log("[update-allowlist] done");
  console.log("[update-allowlist] set PXE_BRIDGE_ALLOWLIST_RECIPIENTS to this and restart:");
  console.log(JSON.stringify(nextConfig));
}

main().catch((err) => {
  console.error("[update-allowlist]", err instanceof Error ? err.message : err);
  process.exit(1);
});
