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
 *   SPENDING_LIMIT_ADMIN_KEY         -- 32-byte hex secret key of the admin
 *   SPENDING_LIMIT_ACCOUNT           -- AztecAddress of the account to update
 *
 * Optional env:
 *   AZTEC_NODE_URL  -- Aztec node (default: http://localhost:8080)
 *
 * Refuses before sending unless the key derives the account's admin and the
 * configured set reproduces the account's allowlist_root.
 *
 * The next PXE_BRIDGE_ALLOWLIST_RECIPIENTS set is printed as soon as the tx is
 * sent, before the wait, so a timeout or signal does not lose it; the script
 * then says how to check whether the update landed. Once it has, set it and
 * restart the bridge. Until you do, the bridge refuses to send:
 * it checks its root against the account's before every transfer.
 */

import { AllowlistTree, allowlistLeaf } from "../src/allowlist-tree.js";
import type { AllowlistRecipient } from "../src/allowlist-tree.js";
import {
  accountContract,
  allowlistSentNotice,
  connectAdmin,
  onInterrupt,
  parseAllowlistEnv,
  readAccountState,
  requiredEnv,
  runScript,
  sendAndWait,
  takeSecretEnv,
  validateSecret,
} from "./spending-limit-admin.js";

const NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";

function fail(message: string): never {
  throw new Error(message);
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

async function main(): Promise<number> {
  // Before anything that could spawn a prover.
  const seedEnv = takeSecretEnv("PXE_BRIDGE_ALLOWLIST_SEED");
  const adminKeyEnv = takeSecretEnv("SPENDING_LIMIT_ADMIN_KEY");

  const account = requiredEnv("SPENDING_LIMIT_ACCOUNT");
  const adminKey = await validateSecret("SPENDING_LIMIT_ADMIN_KEY", adminKeyEnv);
  const allowlist = await parseAllowlistEnv(seedEnv);
  if (!allowlist) {
    fail("PXE_BRIDGE_ALLOWLIST_SEED and PXE_BRIDGE_ALLOWLIST_RECIPIENTS are required");
  }
  const { seed, recipients: current } = allowlist;
  const plan = parseArgs(process.argv.slice(2), current);

  const { Fr } = await import("@aztec/foundation/curves/bn254");
  const { TxExecutionResult } = await import("@aztec/stdlib/tx");

  // The tree as it stands. The witness for the position being changed is what
  // proves to the contract that nothing else moved.
  const before = await AllowlistTree.build(seed, current);

  // The contract verifies the path against its current root and reverts on a
  // stale set; checked here so the admin does not pay for the revert.
  const { state } = await readAccountState(NODE_URL, account);
  if (before.root.toString() !== state.allowlistRoot) {
    fail(
      `allowlist root mismatch: PXE_BRIDGE_ALLOWLIST_SEED and PXE_BRIDGE_ALLOWLIST_RECIPIENTS ` +
        `build ${before.root.toString()}, the account's allowlist_root is ${state.allowlistRoot}`,
    );
  }

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

  const nextConfig =
    plan.mode === "add"
      ? [...current, { address: plan.address, index: plan.index }]
      : current.filter((r) => r.index !== plan.index);
  const after = await AllowlistTree.build(seed, nextConfig);

  console.log(`[update-allowlist] ${plan.mode}: ${plan.address} at position ${plan.index}`);
  console.log(`[update-allowlist] account:  ${account}`);
  console.log(`[update-allowlist] root now: ${before.root.toString()}`);
  console.log(`[update-allowlist] root after: ${after.root.toString()}`);
  console.log(
    "[update-allowlist] this takes effect immediately and invalidates every transaction " +
      "already in flight",
  );

  const { wallet, admin } = await connectAdmin(NODE_URL, adminKey, state.admin);
  console.log(`[update-allowlist] admin:    ${admin.toString()}`);
  const contract = await accountContract(wallet, account);

  const say = (line: string): void => console.log(`[update-allowlist] ${line}`);
  let uncertain: string[] = [];
  let receipt;
  try {
    receipt = await sendAndWait(
      NODE_URL,
      contract.methods["update_recipient"]!(plan.index, oldLeaf, newLeaf, witness.siblingPath),
      admin,
      say,
      (txHash) => {
        // Before the wait: a timeout or signal must not lose the next set.
        const notice = allowlistSentNotice(txHash, nextConfig, after.root.toString());
        for (const line of notice.applyLines) say(line);
        uncertain = notice.uncertainLines;
        onInterrupt(uncertain);
      },
    );
  } catch (err) {
    for (const line of uncertain) console.error(`[update-allowlist] ${line}`);
    throw err;
  }
  if (receipt.executionResult !== TxExecutionResult.SUCCESS) {
    fail("update_recipient did not succeed; the set above does NOT apply");
  }

  console.log("[update-allowlist] done: the update landed. Apply the set printed above and restart");
  return 0;
}

runScript("[update-allowlist]", main);
