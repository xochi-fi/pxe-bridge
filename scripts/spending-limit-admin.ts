/**
 * Shared by scripts/admin.ts and scripts/update-allowlist.ts. Not runnable.
 *
 * The pure half (argument parsing, storage decoding, the apply window) is
 * unit-tested; the rest talks to a node.
 */

import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ContractFunctionInteraction } from "@aztec/aztec.js/contracts";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import type { TxReceipt } from "@aztec/stdlib/tx";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AllowlistRecipient } from "../src/allowlist-tree.js";
import type { FeeJuiceClaim } from "../src/types.js";

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

/**
 * Reads a secret and deletes it from the environment, so a prover or any
 * other child process does not inherit it. Call before anything spawns.
 */
export function takeSecretEnv(name: string): string | undefined {
  const value = process.env[name];
  delete process.env[name];
  return value || undefined;
}

/**
 * 32-byte hex below the BN254 modulus, checked before the SDK sees it: the
 * SDK's own range error prints the value in full. Errors name the variable,
 * never the value.
 */
export async function validateSecret(name: string, value: string | undefined): Promise<string> {
  if (!value) throw new Error(`${name} is required`);
  const { validateKey } = await import("../src/secrets.js");
  try {
    return "0x" + (await validateKey(value));
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

export interface AllowlistEnv {
  seed: string;
  recipients: AllowlistRecipient[];
}

/**
 * The allowlist as configured: `seed` is PXE_BRIDGE_ALLOWLIST_SEED, already
 * taken with takeSecretEnv; recipients come from PXE_BRIDGE_ALLOWLIST_RECIPIENTS.
 * Undefined when neither is set.
 */
export async function parseAllowlistEnv(seed: string | undefined): Promise<AllowlistEnv | undefined> {
  const raw = process.env["PXE_BRIDGE_ALLOWLIST_RECIPIENTS"];
  if (seed === undefined && !raw) return undefined;
  if (!raw) throw new Error("PXE_BRIDGE_ALLOWLIST_SEED is set without PXE_BRIDGE_ALLOWLIST_RECIPIENTS");

  const { AllowlistRecipientsSchema } = await import("../src/types.js");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("PXE_BRIDGE_ALLOWLIST_RECIPIENTS is not valid JSON");
  }
  const parsed = AllowlistRecipientsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      "PXE_BRIDGE_ALLOWLIST_RECIPIENTS is malformed: " +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return {
    seed: await validateSecret("PXE_BRIDGE_ALLOWLIST_SEED", seed),
    recipients: parsed.data,
  };
}

// Run LIFO on exit. `graceful` is false on a signal, where wallet.stop() may
// wait on a proof in flight; stores are deleted either way.
type Disposer = (graceful: boolean) => Promise<void>;
const disposers: Disposer[] = [];

async function disposeAll(tag: string, graceful: boolean): Promise<void> {
  for (let d = disposers.pop(); d; d = disposers.pop()) {
    try {
      await d(graceful);
    } catch (err) {
      console.error(tag, "cleanup:", err instanceof Error ? err.message : err);
    }
  }
}

function adoptStore(store: AztecLMDBStoreV2): void {
  disposers.push(async () => {
    try {
      await store.delete();
    } finally {
      // delete() closes first and skips the rm if closing throws.
      await rm(store.dataDirectory, { recursive: true, force: true });
    }
  });
}

/**
 * Runs `main`, then deletes every wallet store and exits with its code; 1 on a
 * throw. SIGHUP, SIGINT and SIGTERM delete the stores too, without waiting for
 * the wallet to stop, and exit 128 + signal number. Codes >= 128 are
 * interrupts, not status bits; statusExitCode stays below 32.
 */
export function runScript(tag: string, main: () => Promise<number>): void {
  let signalled = false;
  for (const [signal, code] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      if (signalled) return;
      signalled = true;
      console.error(`${tag} ${signal}: deleting wallet stores`);
      void disposeAll(tag, false).finally(() => process.exit(code));
    });
  }
  main()
    .catch((err: unknown) => {
      console.error(tag, err instanceof Error ? err.message : err);
      return 1;
    })
    .then(async (code) => {
      await disposeAll(tag, true);
      if (!signalled) process.exit(code);
    });
}

/** What `status` alerts against. Absent fields are not checked. */
export interface StatusExpectations {
  /** Default false: a paused account alerts. */
  paused: boolean;
  /** 0x-prefixed lowercase 32-byte hex. */
  allowlistRoot?: string | undefined;
  /** Admin fee juice below this alerts. */
  minFeeJuice?: bigint | undefined;
}

export type AdminCommand =
  | { kind: "status"; expect: StatusExpectations }
  | { kind: "pause" }
  | { kind: "unpause" }
  | { kind: "propose-limits"; maxPerTx: bigint; dailyLimit: bigint }
  | { kind: "apply-limits" }
  | { kind: "cancel-limits" }
  | { kind: "deploy" };

export const ADMIN_USAGE =
  "usage: npm run admin -- status [--expect-root <hex>] [--expect-paused] [--min-fee-juice <n>]\n" +
  "       npm run admin -- <deploy|pause|unpause|apply-limits|cancel-limits>\n" +
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
      "expect-root": { type: "string" },
      "expect-paused": { type: "boolean" },
      "min-fee-juice": { type: "string" },
    },
  });

  if (positionals.length !== 1) throw new Error("expected exactly one command");
  const [command] = positionals;
  const limitFlags = values["max-per-tx"] !== undefined || values.daily !== undefined;
  const statusFlags =
    values["expect-root"] !== undefined ||
    values["expect-paused"] !== undefined ||
    values["min-fee-juice"] !== undefined;

  switch (command) {
    case "propose-limits": {
      if (statusFlags) throw new Error("propose-limits takes only --max-per-tx and --daily");
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
    case "status": {
      if (limitFlags) throw new Error("status takes only --expect-root, --expect-paused and --min-fee-juice");
      const root = values["expect-root"];
      if (root !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(root)) {
        throw new Error(`--expect-root must be 32-byte hex, got "${root}"`);
      }
      const minFeeJuice = values["min-fee-juice"];
      return {
        kind: "status",
        expect: {
          paused: values["expect-paused"] ?? false,
          allowlistRoot: root?.toLowerCase(),
          minFeeJuice: minFeeJuice === undefined ? undefined : parseU128(minFeeJuice, "--min-fee-juice"),
        },
      };
    }
    case "deploy":
    case "pause":
    case "unpause":
    case "apply-limits":
    case "cancel-limits":
      if (limitFlags || statusFlags) throw new Error(`${command} takes no flags`);
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
 * Bits, ORed: 2 pause state is not the expected one; 4 limit proposal pending
 * (expired included, until cancel-limits clears it); 8 allowlist_root is not
 * the expected root; 16 admin fee juice below the minimum, or unread. 1 alone
 * is an error. New bits must stay below 32: runScript's signal exits (129,
 * 130, 143) would otherwise read as bit combinations.
 */
export function statusExitCode(
  state: AccountState,
  expect: StatusExpectations = { paused: false },
  adminFeeJuice?: bigint,
): number {
  let code = 0;
  if (state.paused !== expect.paused) code |= 2;
  if (state.pendingChangeTime !== 0n) code |= 4;
  if (expect.allowlistRoot !== undefined && expect.allowlistRoot !== state.allowlistRoot) code |= 8;
  if (
    expect.minFeeJuice !== undefined &&
    (adminFeeJuice === undefined || adminFeeJuice < expect.minFeeJuice)
  ) {
    code |= 16;
  }
  return code;
}

const isoSeconds = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

export function formatStatus(
  account: string,
  state: AccountState,
  now: bigint,
  checked?: { expect: StatusExpectations; adminFeeJuice: bigint },
): string[] {
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
  if (checked) {
    const { expect, adminFeeJuice } = checked;
    rows.push(
      ["expected paused", String(expect.paused)],
      ["expected root", expect.allowlistRoot ?? "not checked"],
      ["admin fee juice", String(adminFeeJuice)],
      ["min fee juice", expect.minFeeJuice === undefined ? "not checked" : String(expect.minFeeJuice)],
    );
  }
  return rows.map(([key, value]) => `${(key + ":").padEnd(21)}${value}`);
}

/**
 * Reads the account's public storage straight from the node, by the slots the
 * artifact's storage layout assigns. No wallet and no key: the getters are not
 * on the contract yet.
 *
 * Refuses unless the account's contract class is the artifact's: the slots
 * come from the artifact, and a layout from another contract version would
 * decode the wrong fields, a zero reading as "not paused".
 *
 * The node is trusted: values are not checked against a public-data witness.
 *
 * Returns the latest block's timestamp alongside, since the timelock is judged
 * against block time rather than this machine's clock.
 */
export async function readAccountState(
  nodeUrl: string,
  account: string,
): Promise<{ state: AccountState; now: bigint }> {
  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  const { getContractClassFromArtifact } = await import("@aztec/stdlib/contract");
  const { loadSpendingLimitArtifact } = await import("../src/spending-limit-account.js");

  const address = await parseAccountAddress(account);
  const artifact = await loadSpendingLimitArtifact();
  const artifactClassId = (await getContractClassFromArtifact(artifact)).id.toString();
  const node = createAztecNodeClient(nodeUrl);

  let raw: Record<StatusField, bigint>;
  let now: bigint;
  let accountClassId: string | undefined;
  try {
    const block = await node.getBlockData("latest");
    if (!block) throw new Error("node returned no latest block");
    now = block.header.globalVariables.timestamp;
    accountClassId = (await node.getContract(address))?.currentContractClassId.toString();
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

  if (accountClassId === undefined) {
    throw new Error(`no contract instance at ${account} on ${nodeUrl}`);
  }
  if (accountClassId !== artifactClassId) {
    throw new Error(
      `contract class mismatch: ${account} runs ${accountClassId}, the artifact in ` +
        `contracts/spending_limit_account/target/ is ${artifactClassId}. Its storage layout ` +
        `may not be the account's; build the artifact the account was deployed from`,
    );
  }

  const state = decodeAccountState(raw);
  if (!state.initialized) {
    throw new Error(`no initialized spending-limit account at ${account} on ${nodeUrl}`);
  }
  return { state, now };
}

/** Fee juice balance from the FeeJuice contract's public storage. Trusts the node. */
export async function readFeeJuiceBalance(nodeUrl: string, owner: string): Promise<bigint> {
  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  const { getFeeJuiceBalance } = await import("@aztec/aztec.js/utils");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  try {
    return await getFeeJuiceBalance(
      AztecAddress.fromStringUnsafe(owner),
      createAztecNodeClient(nodeUrl),
    );
  } catch (err) {
    throw new Error(
      `cannot read fee juice of ${owner} from ${nodeUrl}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * FEE_JUICE_CLAIM as produced by `npm run bridge-fee-juice`, validated as
 * src/index.ts does. `raw` already taken with takeSecretEnv.
 */
export async function parseFeeJuiceClaim(raw: string | undefined): Promise<FeeJuiceClaim | undefined> {
  if (!raw) return undefined;
  const { FeeJuiceClaimSchema } = await import("../src/types.js");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("FEE_JUICE_CLAIM is not valid JSON");
  }
  const parsed = FeeJuiceClaimSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("FEE_JUICE_CLAIM must be: {claimAmount, claimSecret, messageLeafIndex}");
  }
  return parsed.data;
}

/**
 * The admin as an ordinary Schnorr account in a wallet whose stores runScript
 * deletes on exit. Derived exactly the way the bridge derives its own, so a
 * key cannot map to two addresses.
 */
async function openAdminWallet(nodeUrl: string, adminKey: string) {
  const { EmbeddedWallet } = await import("@aztec/wallets/embedded");
  const { openEphemeralStore } = await import("@aztec/kv-store/lmdb-v2");
  const { deriveAccountKeys } = await import("../src/aztec-client.js");

  // createSchnorrAccount writes the secret and signing key to the wallet DB,
  // and the PXE stores keys derived from them. `ephemeral: true` alone still
  // puts both stores on disk under os.tmpdir() and never deletes them, so the
  // stores are opened here and deleted by runScript. Without proverEnabled
  // the SDK does not produce real proofs, and a network that verifies them
  // rejects the send.
  const walletStore = await openEphemeralStore("wallet_data");
  adoptStore(walletStore);
  const pxeStore = await openEphemeralStore("pxe_data");
  adoptStore(pxeStore);
  const wallet = await EmbeddedWallet.create(nodeUrl, {
    ephemeral: true,
    walletDb: { store: walletStore },
    pxe: { store: pxeStore, proverEnabled: true },
  });
  disposers.push(async (graceful) => {
    if (graceful) await wallet.stop();
  });

  const keys = await deriveAccountKeys(adminKey);
  const manager = await wallet.createSchnorrAccount(keys.secret, keys.salt, keys.signingKey);
  const admin = (await manager.getAccount()).getAddress();
  return { wallet, manager, admin };
}

/**
 * Self-deploys the admin account, paying with a fee juice claim bridged to
 * its address. Returns false without sending when it is already initialized,
 * which needs no claim.
 *
 * Only call under runScript, which deletes the wallet's stores on exit.
 */
export async function deployAdmin(
  nodeUrl: string,
  adminKey: string,
  claim: FeeJuiceClaim | undefined,
  log: (line: string) => void,
): Promise<boolean> {
  const { ContractInitializationStatus } = await import("@aztec/aztec.js/wallet");
  const { NO_FROM } = await import("@aztec/aztec.js/account");
  const { FeeJuicePaymentMethodWithClaim } = await import("@aztec/aztec.js/fee");
  const { Fr } = await import("@aztec/aztec.js/fields");
  const { headroomGasSettings } = await import("../src/aztec-client.js");

  const { wallet, manager, admin } = await openAdminWallet(nodeUrl, adminKey);
  log(`admin:  ${admin.toString()}`);
  const { initializationStatus } = await wallet.getContractMetadata(admin);
  if (initializationStatus === ContractInitializationStatus.INITIALIZED) {
    log("already deployed; nothing sent");
    return false;
  }
  if (!claim) {
    throw new Error(`FEE_JUICE_CLAIM is required: npm run bridge-fee-juice to ${admin.toString()}`);
  }

  const paymentMethod = new FeeJuicePaymentMethodWithClaim(admin, {
    claimAmount: BigInt(claim.claimAmount),
    claimSecret: Fr.fromString(claim.claimSecret),
    messageLeafIndex: BigInt(claim.messageLeafIndex),
  });
  const deployMethod = await manager.getDeployMethod();
  await deployMethod.send({
    from: NO_FROM,
    fee: { paymentMethod, gasSettings: await headroomGasSettings(nodeUrl) },
    skipClassPublication: false,
    skipInstancePublication: false,
  });
  log("deployed");
  return true;
}

/**
 * The deployed admin's wallet. Refuses unless the key derives `expectedAdmin`,
 * the account's on-chain admin, when given.
 *
 * Only call under runScript, which deletes the wallet's stores on exit.
 */
export async function connectAdmin(
  nodeUrl: string,
  adminKey: string,
  expectedAdmin: string | undefined,
): Promise<{ wallet: EmbeddedWallet; admin: AztecAddress }> {
  const { ContractInitializationStatus } = await import("@aztec/aztec.js/wallet");
  const { wallet, admin } = await openAdminWallet(nodeUrl, adminKey);
  if (expectedAdmin !== undefined && admin.toString() !== expectedAdmin) {
    throw new Error(
      `admin mismatch: SPENDING_LIMIT_ADMIN_KEY derives ${admin.toString()}, the account's admin is ${expectedAdmin}`,
    );
  }

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
  // Admission needs the declared fee limit, ~11x this at unchanged base fees:
  // estimated gas (+10%) at 10x the worst predicted base fee. Sizes --min-fee-juice.
  if (receipt.transactionFee !== undefined) log(`fee:    ${receipt.transactionFee}`);
  return receipt;
}
