/**
 * Admin operations on the spending-limit account.
 *
 * Usage:
 *   npm run admin -- status [--expect-root <hex>] [--expect-paused] [--min-fee-juice <n>]
 *   npm run admin -- deploy
 *   npm run admin -- pause
 *   npm run admin -- unpause
 *   npm run admin -- propose-limits --max-per-tx <n> --daily <n>
 *   npm run admin -- apply-limits
 *   npm run admin -- cancel-limits
 *
 * Env:
 *   SPENDING_LIMIT_ACCOUNT           -- AztecAddress of the account (all but deploy)
 *   SPENDING_LIMIT_ADMIN_KEY         -- 32-byte hex secret key of the admin (all but status)
 *   FEE_JUICE_CLAIM                  -- deploy: claim JSON from bridge-fee-juice to the admin
 *   PXE_BRIDGE_ALLOWLIST_SEED        -- status: with RECIPIENTS, the expected root
 *   PXE_BRIDGE_ALLOWLIST_RECIPIENTS     when --expect-root is not given
 *   AZTEC_NODE_URL                   -- Aztec node (default: http://localhost:8080)
 *
 * `status` reads public storage and needs no key. Exit code bits, ORed:
 *   2  pause state is not the expected one (unpaused, or paused with --expect-paused)
 *   4  limit proposal pending, expired included, until applied or cancelled
 *   8  allowlist_root is not the expected root
 *   16 admin fee juice below --min-fee-juice
 * 1 alone is an error, including a contract class that is not the artifact's.
 *
 * pause and unpause take effect at the inclusion of the next transfer. pause is
 * checked only in check_spending_public, so a compromised signing key can
 * still burn the account's fee juice on transfers that revert while paused.
 *
 * Every send is paid by the admin from its own fee juice.
 */

import { AllowlistTree } from "../src/allowlist-tree.js";
import {
  ADMIN_USAGE,
  PARAM_TIMELOCK_SECONDS,
  accountContract,
  connectAdmin,
  deployAdmin,
  formatStatus,
  parseAdminCommand,
  parseFeeJuiceClaim,
  parseAllowlistEnv,
  proposalWindow,
  readAccountState,
  readFeeJuiceBalance,
  requiredEnv,
  runScript,
  sendAndWait,
  statusExitCode,
  takeSecretEnv,
  validateSecret,
} from "./spending-limit-admin.js";
import type { AccountState, AdminCommand } from "./spending-limit-admin.js";

const NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";

const CONTRACT_METHOD = {
  pause: "pause",
  unpause: "unpause",
  "propose-limits": "propose_limits",
  "apply-limits": "apply_limits",
  "cancel-limits": "cancel_limits",
} as const;

const log = (line: string): void => console.log(`[admin] ${line}`);

/**
 * Refuses sends the contract would revert on, judged at the latest block, so
 * the admin does not pay for a known failure. Inclusion is later than that
 * block, so a send within seconds of a boundary can still go either way.
 */
function refuseKnownReverts(command: AdminCommand, state: AccountState, now: bigint): void {
  const window = proposalWindow(state.pendingChangeTime, now);
  if (command.kind === "cancel-limits" && window.state === "none") {
    throw new Error("No pending changes");
  }
  if (command.kind !== "apply-limits") return;
  if (window.state === "none") throw new Error("No pending changes");
  if (window.state === "timelocked") {
    throw new Error(`Timelock not expired: opens at ${window.opensAt}, block time is ${now}`);
  }
  if (window.state === "expired") {
    throw new Error(
      `Proposal expired at ${window.closesAt}, block time is ${now}. cancel-limits, then propose again.`,
    );
  }
}

function describe(command: AdminCommand, state: AccountState, now: bigint): string[] {
  switch (command.kind) {
    case "pause":
      return [
        "pause(): transfers revert at inclusion until unpause",
        ...(state.paused ? ["account is already paused"] : []),
      ];
    case "unpause":
      return [
        "unpause(): transfers resume immediately",
        ...(state.paused ? [] : ["account is not paused"]),
      ];
    case "propose-limits":
      return [
        `propose_limits(${command.maxPerTx}, ${command.dailyLimit})`,
        `current: max_per_tx ${state.maxAmountPerTx}, daily ${state.dailyLimit}`,
        `applicable from about ${now + PARAM_TIMELOCK_SECONDS} for 24h, by apply-limits`,
        ...(state.pendingChangeTime !== 0n
          ? [
              `replaces pending max_per_tx ${state.pendingMaxAmount}, daily ${state.pendingDailyLimit} and restarts the timelock`,
            ]
          : []),
      ];
    case "apply-limits":
      return [
        "apply_limits()",
        `max_per_tx ${state.maxAmountPerTx} -> ${state.pendingMaxAmount}`,
        `daily ${state.dailyLimit} -> ${state.pendingDailyLimit}`,
      ];
    case "cancel-limits":
      return [
        "cancel_limits()",
        `drops pending max_per_tx ${state.pendingMaxAmount}, daily ${state.pendingDailyLimit}`,
      ];
    case "status":
    case "deploy":
      return [];
  }
}

async function main(): Promise<number> {
  // Before anything that could spawn a prover.
  const adminKeyEnv = takeSecretEnv("SPENDING_LIMIT_ADMIN_KEY");
  const seedEnv = takeSecretEnv("PXE_BRIDGE_ALLOWLIST_SEED");
  const claimEnv = takeSecretEnv("FEE_JUICE_CLAIM");

  let command: AdminCommand;
  try {
    command = parseAdminCommand(process.argv.slice(2));
  } catch (err) {
    throw new Error(`${(err as Error).message}\n${ADMIN_USAGE}`);
  }

  if (command.kind === "deploy") {
    const adminKey = await validateSecret("SPENDING_LIMIT_ADMIN_KEY", adminKeyEnv);
    const claim = await parseFeeJuiceClaim(claimEnv);
    await deployAdmin(NODE_URL, adminKey, claim, log);
    return 0;
  }

  const account = requiredEnv("SPENDING_LIMIT_ACCOUNT");

  if (command.kind === "status") {
    const allowlist =
      command.expect.allowlistRoot === undefined ? await parseAllowlistEnv(seedEnv) : undefined;
    const expect = {
      ...command.expect,
      allowlistRoot:
        command.expect.allowlistRoot ??
        (allowlist
          ? (await AllowlistTree.build(allowlist.seed, allowlist.recipients)).root.toString()
          : undefined),
    };
    const { state, now } = await readAccountState(NODE_URL, account);
    const adminFeeJuice = await readFeeJuiceBalance(NODE_URL, state.admin);
    for (const line of formatStatus(account, state, now, { expect, adminFeeJuice })) {
      console.log(line);
    }
    return statusExitCode(state, expect, adminFeeJuice);
  }

  const adminKey = await validateSecret("SPENDING_LIMIT_ADMIN_KEY", adminKeyEnv);
  const { state, now } = await readAccountState(NODE_URL, account);
  refuseKnownReverts(command, state, now);

  const { wallet, admin } = await connectAdmin(NODE_URL, adminKey, state.admin);

  log(`account: ${account}`);
  log(`admin:   ${admin.toString()}`);
  for (const line of describe(command, state, now)) log(line);

  const contract = await accountContract(wallet, account);
  const method = contract.methods[CONTRACT_METHOD[command.kind]]!;
  const interaction =
    command.kind === "propose-limits"
      ? method(command.maxPerTx, command.dailyLimit)
      : method();

  const { TxExecutionResult } = await import("@aztec/stdlib/tx");
  const receipt = await sendAndWait(NODE_URL, interaction, admin, log);
  if (receipt.executionResult !== TxExecutionResult.SUCCESS) return 1;

  const after = await readAccountState(NODE_URL, account);
  for (const line of formatStatus(account, after.state, after.now)) console.log(line);
  return 0;
}

runScript("[admin]", main);
