/**
 * Shared by scripts/admin.ts and scripts/update-allowlist.ts. Not runnable.
 *
 * The pure half (argument parsing, storage decoding, the apply window) is
 * unit-tested; the rest talks to a node.
 */

import { parseArgs } from "node:util";
import type { ContractFunctionInteraction } from "@aztec/aztec.js/contracts";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { TxReceipt } from "@aztec/stdlib/tx";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

// Must match PARAM_TIMELOCK_SECONDS and PARAM_APPLY_WINDOW_SECONDS in main.nr.
export const PARAM_TIMELOCK_SECONDS = 86_400n;
export const PARAM_APPLY_WINDOW_SECONDS = 86_400n;

export const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

// Generous: a send proves locally before it is submitted, and inclusion waits
// for a checkpoint.
const RECEIPT_TIMEOUT_SECONDS = 300;

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export type AdminCommand =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "unpause" }
  | { kind: "propose-limits"; maxPerTx: bigint; dailyLimit: bigint }
  | { kind: "apply-limits" }
  | { kind: "cancel-limits" };

export const ADMIN_USAGE =
  "usage: npm run admin -- <status|pause|unpause|apply-limits|cancel-limits>\n" +
  "       npm run admin -- propose-limits --max-per-tx <n> --daily <n>";

/** A u128 in base units, as a plain decimal. No sign, exponent or leading zero. */
export function parseU128(value: string, flag: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${flag} must be a decimal integer in base units, got "${value}"`);
  }
  const n = BigInt(value);
  if (n > U128_MAX) throw new Error(`${flag} exceeds u128 max (${U128_MAX})`);
  return n;
}

/** Mirrors assert_limits_valid in main.nr, with the contract's messages. */
export function assertLimitsValid(maxPerTx: bigint, dailyLimit: bigint): void {
  if (maxPerTx === 0n) throw new Error("Per-tx limit must be non-zero");
  if (dailyLimit === 0n) throw new Error("Daily limit must be non-zero");
  if (dailyLimit < maxPerTx) throw new Error("Daily limit must be >= per-tx max");
}

export function parseAdminCommand(argv: readonly string[]): AdminCommand {
  const { values, positionals } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      "max-per-tx": { type: "string" },
      daily: { type: "string" },
    },
  });

  if (positionals.length !== 1) throw new Error("expected exactly one command");
  const [command] = positionals;
  const limitFlags = values["max-per-tx"] !== undefined || values.daily !== undefined;

  switch (command) {
    case "propose-limits": {
      const max = values["max-per-tx"];
      const daily = values.daily;
      if (max === undefined || daily === undefined) {
        throw new Error("propose-limits needs --max-per-tx <n> and --daily <n>");
      }
      const maxPerTx = parseU128(max, "--max-per-tx");
      const dailyLimit = parseU128(daily, "--daily");
      assertLimitsValid(maxPerTx, dailyLimit);
      return { kind: "propose-limits", maxPerTx, dailyLimit };
    }
    case "status":
    case "pause":
    case "unpause":
    case "apply-limits":
    case "cancel-limits":
      if (limitFlags) throw new Error(`${command} takes no flags`);
      return { kind: command };
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

/** The public storage the status command reads, by its name in main.nr. */
export const STATUS_FIELDS = [
  "initialized",
  "paused",
  "max_amount_per_tx",
  "daily_limit",
  "pending_max_amount",
  "pending_daily_limit",
  "pending_change_time",
  "allowlist_root",
  "admin",
  "permitted_token",
] as const;
export type StatusField = (typeof STATUS_FIELDS)[number];

export interface AccountState {
  initialized: boolean;
  paused: boolean;
  maxAmountPerTx: bigint;
  dailyLimit: bigint;
  pendingMaxAmount: bigint;
  pendingDailyLimit: bigint;
  /** Unix seconds; 0 when nothing is proposed. */
  pendingChangeTime: bigint;
  allowlistRoot: string;
  admin: string;
  permittedToken: string;
}

function decodeBool(name: string, value: bigint): boolean {
  if (value === 0n) return false;
  if (value === 1n) return true;
  throw new Error(`${name} holds ${value}, not a bool: wrong account or storage layout`);
}

function decodeBounded(name: string, value: bigint, max: bigint): bigint {
  if (value > max) throw new Error(`${name} holds ${value}, out of range: wrong storage layout`);
  return value;
}

const toHex32 = (value: bigint): string => "0x" + value.toString(16).padStart(64, "0");

/**
 * Raw storage fields to typed state. Every field here packs to one Field at
 * its slot; PublicImmutable puts the value at its slot and the hash after it.
 */
export function decodeAccountState(raw: Readonly<Record<StatusField, bigint>>): AccountState {
  return {
    initialized: decodeBool("initialized", raw.initialized),
    paused: decodeBool("paused", raw.paused),
    maxAmountPerTx: decodeBounded("max_amount_per_tx", raw.max_amount_per_tx, U128_MAX),
    dailyLimit: decodeBounded("daily_limit", raw.daily_limit, U128_MAX),
    pendingMaxAmount: decodeBounded("pending_max_amount", raw.pending_max_amount, U128_MAX),
    pendingDailyLimit: decodeBounded("pending_daily_limit", raw.pending_daily_limit, U128_MAX),
    pendingChangeTime: decodeBounded("pending_change_time", raw.pending_change_time, U64_MAX),
    allowlistRoot: toHex32(raw.allowlist_root),
    admin: toHex32(raw.admin),
    permittedToken: toHex32(raw.permitted_token),
  };
}

export type ProposalWindow =
  | { state: "none" }
  | { state: "timelocked" | "open" | "expired"; opensAt: bigint; closesAt: bigint };

/**
 * Where a proposal stands at `now`, per apply_limits: applicable from
 * pending_change_time inclusive to pending_change_time + window exclusive.
 */
export function proposalWindow(pendingChangeTime: bigint, now: bigint): ProposalWindow {
  if (pendingChangeTime === 0n) return { state: "none" };
  const opensAt = pendingChangeTime;
  const closesAt = pendingChangeTime + PARAM_APPLY_WINDOW_SECONDS;
  const state = now < opensAt ? "timelocked" : now < closesAt ? "open" : "expired";
  return { state, opensAt, closesAt };
}

/**
 * 0 clean; 2 paused; 4 proposal pending (any state, expired included, until
 * cancel-limits clears it); 6 both. 1 is reserved for errors.
 */
export function statusExitCode(state: AccountState): number {
  return (state.paused ? 2 : 0) | (state.pendingChangeTime !== 0n ? 4 : 0);
}

const isoSeconds = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

export function formatStatus(account: string, state: AccountState, now: bigint): string[] {
  const window = proposalWindow(state.pendingChangeTime, now);
  const rows: [string, string][] = [
    ["account", account],
    ["block time", `${now} (${isoSeconds(now)})`],
    ["paused", String(state.paused)],
    ["max_amount_per_tx", String(state.maxAmountPerTx)],
    ["daily_limit", String(state.dailyLimit)],
    ["allowlist_root", state.allowlistRoot],
    ["admin", state.admin],
    ["permitted_token", state.permittedToken],
  ];
  if (window.state === "none") {
    rows.push(["pending limits", "none"]);
  } else {
    rows.push(
      ["pending_max_amount", String(state.pendingMaxAmount)],
      ["pending_daily_limit", String(state.pendingDailyLimit)],
      ["pending_change_time", String(state.pendingChangeTime)],
      ["apply opens", `${window.opensAt} (${isoSeconds(window.opensAt)})`],
      ["apply closes", `${window.closesAt} (${isoSeconds(window.closesAt)}, exclusive)`],
      ["proposal", window.state],
    );
  }
  return rows.map(([key, value]) => `${(key + ":").padEnd(21)}${value}`);
}

/**
 * Reads the account's public storage straight from the node, by the slots the
 * artifact's storage layout assigns. No wallet and no key: the getters are not
 * on the contract yet.
 *
 * Returns the latest block's timestamp alongside, since the timelock is judged
 * against block time rather than this machine's clock.
 */
export async function readAccountState(
  nodeUrl: string,
  account: string,
): Promise<{ state: AccountState; now: bigint }> {
  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  const { loadSpendingLimitArtifact } = await import("../src/spending-limit-account.js");

  const address = await parseAccountAddress(account);
  const artifact = await loadSpendingLimitArtifact();
  const node = createAztecNodeClient(nodeUrl);

  let raw: Record<StatusField, bigint>;
  let now: bigint;
  try {
    const block = await node.getBlockData("latest");
    if (!block) throw new Error("node returned no latest block");
    now = block.header.globalVariables.timestamp;
    const values = await Promise.all(
      STATUS_FIELDS.map(async (field) => {
        const layout = artifact.storageLayout[field];
        if (!layout) throw new Error(`artifact has no storage field ${field}`);
        const value = await node.getPublicStorageAt("latest", address, layout.slot);
        return [field, value.toBigInt()] as const;
      }),
    );
    raw = Object.fromEntries(values) as Record<StatusField, bigint>;
  } catch (err) {
    throw new Error(
      `cannot read account state from ${nodeUrl}: ${err instanceof Error ? err.message : err}`,
    );
  }

  const state = decodeAccountState(raw);
  if (!state.initialized) {
    throw new Error(`no initialized spending-limit account at ${account} on ${nodeUrl}`);
  }
  return { state, now };
}

/**
 * The admin wallet. The admin is an ordinary Schnorr account derived exactly
 * the way the bridge derives its own, so a key cannot map to two addresses.
 */
export async function connectAdmin(
  nodeUrl: string,
  adminKey: string,
): Promise<{ wallet: EmbeddedWallet; admin: AztecAddress }> {
  const { EmbeddedWallet } = await import("@aztec/wallets/embedded");
  const { ContractInitializationStatus } = await import("@aztec/aztec.js/wallet");
  const { deriveAccountKeys } = await import("../src/aztec-client.js");

  // Ephemeral: createSchnorrAccount stores the secret and signing key in the
  // wallet DB, which otherwise persists under ./aztec-wallet-data. Without
  // proverEnabled the SDK does not produce real proofs, and a network that
  // verifies them rejects the send.
  const wallet = await EmbeddedWallet.create(nodeUrl, {
    ephemeral: true,
    pxe: { proverEnabled: true },
  });
  const keys = await deriveAccountKeys(adminKey);
  const manager = await wallet.createSchnorrAccount(keys.secret, keys.salt, keys.signingKey);
  const admin = (await manager.getAccount()).getAddress();

  const { initializationStatus } = await wallet.getContractMetadata(admin);
  if (initializationStatus !== ContractInitializationStatus.INITIALIZED) {
    throw new Error(
      `admin ${admin.toString()} is not deployed on ${nodeUrl}; it sends and pays its own fee`,
    );
  }
  return { wallet, admin };
}

async function parseAccountAddress(account: string): Promise<AztecAddress> {
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  if (!AztecAddress.isAddress(account)) {
    throw new Error(`SPENDING_LIMIT_ACCOUNT must be 32-byte hex, got "${account}"`);
  }
  return AztecAddress.fromStringUnsafe(account);
}

/** The spending-limit account, bound to the admin's wallet. */
export async function accountContract(wallet: EmbeddedWallet, account: string) {
  const { Contract } = await import("@aztec/aztec.js/contracts");
  const { loadSpendingLimitArtifact } = await import("../src/spending-limit-account.js");
  return Contract.at(
    await parseAccountAddress(account),
    await loadSpendingLimitArtifact(),
    // NodeEmbeddedWallet's getContractMetadata is typed without
    // exactOptionalPropertyTypes, so it misses Wallet by `| undefined` only.
    wallet as unknown as Parameters<typeof Contract.at>[2],
  );
}

/**
 * Sends, prints the tx hash before waiting so a timeout does not lose it, then
 * waits for the receipt. Reverts are returned, not thrown, so the caller
 * reports the reason.
 */
export async function sendAndWait(
  nodeUrl: string,
  interaction: ContractFunctionInteraction,
  from: AztecAddress,
  log: (line: string) => void,
): Promise<TxReceipt> {
  const { NO_WAIT } = await import("@aztec/aztec.js/contracts");
  const { createAztecNodeClient, waitForTx } = await import("@aztec/aztec.js/node");
  const { headroomGasSettings } = await import("../src/aztec-client.js");

  const { txHash } = await interaction.send({
    from,
    fee: { gasSettings: await headroomGasSettings(nodeUrl) },
    wait: NO_WAIT,
  });
  log(`tx:     ${txHash.toString()}`);

  const receipt = await waitForTx(createAztecNodeClient(nodeUrl), txHash, {
    timeout: RECEIPT_TIMEOUT_SECONDS,
    dontThrowOnRevert: true,
  });
  log(`status: ${receipt.status}`);
  log(`result: ${receipt.executionResult ?? "none"}`);
  if (receipt.blockNumber !== undefined) log(`block:  ${receipt.blockNumber}`);
  if (receipt.error) log(`error:  ${receipt.error}`);
  return receipt;
}
