/**
 * Admin operations on the spending-limit account.
 *
 * Usage:
 *   npm run admin -- status
 *   npm run admin -- pause
 *   npm run admin -- unpause
 *   npm run admin -- propose-limits --max-per-tx <n> --daily <n>
 *   npm run admin -- apply-limits
 *   npm run admin -- cancel-limits
 *
 * Env:
 *   SPENDING_LIMIT_ACCOUNT    -- AztecAddress of the account (all commands)
 *   SPENDING_LIMIT_ADMIN_KEY  -- 32-byte hex secret key of the admin (all but status)
 *   AZTEC_NODE_URL            -- Aztec node (default: http://localhost:8080)
 *
 * `status` reads public storage directly and needs no key. Exit codes:
 *   0 clean, 1 error, 2 paused, 4 limit proposal pending, 6 both.
 * A proposal counts as pending until apply-limits or cancel-limits clears it,
 * expired ones included.
 *
 * pause and unpause take effect at the inclusion of the next transfer. pause is
 * checked only in check_spending_public, so a compromised signing key can
 * still burn the account's fee juice on transfers that revert while paused.
 *
 * Every send is paid by the admin from its own fee juice.
 */

import {
  ADMIN_USAGE,
  PARAM_TIMELOCK_SECONDS,
  accountContract,
  connectAdmin,
  formatStatus,
  parseAdminCommand,
  proposalWindow,
  readAccountState,
  requiredEnv,
  sendAndWait,
  statusExitCode,
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
      return [];
  }
}

async function main(): Promise<number> {
  let command: AdminCommand;
  try {
    command = parseAdminCommand(process.argv.slice(2));
  } catch (err) {
    throw new Error(`${(err as Error).message}\n${ADMIN_USAGE}`);
  }
  const account = requiredEnv("SPENDING_LIMIT_ACCOUNT");

  const { state, now } = await readAccountState(NODE_URL, account);
  if (command.kind === "status") {
    for (const line of formatStatus(account, state, now)) console.log(line);
    return statusExitCode(state);
  }

  const adminKey = requiredEnv("SPENDING_LIMIT_ADMIN_KEY");
  refuseKnownReverts(command, state, now);

  const { wallet, admin } = await connectAdmin(NODE_URL, adminKey);
  if (admin.toString() !== state.admin) {
    throw new Error(
      `SPENDING_LIMIT_ADMIN_KEY derives ${admin.toString()}, but the account's admin is ${state.admin}`,
    );
  }

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

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[admin]", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
