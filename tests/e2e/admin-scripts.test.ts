import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecClient, deriveAccountKeys } from "../../src/aztec-client.js";
import { AllowlistTree } from "../../src/allowlist-tree.js";
import type { AllowlistRecipient } from "../../src/allowlist-tree.js";
import { readAccountState, readFeeJuiceBalance } from "../../scripts/spending-limit-admin.js";
import {
  getTestConfig,
  bridgeFeeJuiceClaim,
  deployTestToken,
  mintOne,
  FUNDER_KEY,
} from "./helpers.js";

/**
 * scripts/admin.ts and scripts/update-allowlist.ts, run as the operator runs
 * them: a subprocess per command, judged by exit code, output and the
 * account's public storage afterwards.
 *
 * The suite deploys its own spending-limit account whose admin is a fresh key
 * that `admin deploy` brings up, so every admin send is paid from fee juice the
 * admin claimed itself.
 */

const config = getTestConfig();

const ADMIN_KEY = "0x" + "a11c".padStart(64, "0");
const LIMIT_KEY = "0x" + "f00d".padStart(64, "0");

const MAX_PER_TX = 1_000_000_000_000_000_000_000n;
const DAILY_LIMIT = 5_000_000_000_000_000_000_000n;
const FEE_JUICE_AMOUNT = 1_000_000_000_000_000_000_000n;

const ALLOWLIST_SEED = "0x" + "09".repeat(32);
const RECIPIENTS: AllowlistRecipient[] = [{ address: "0x" + "13".repeat(32), index: 137 }];
const ADDED: AllowlistRecipient = { address: "0x" + "14".repeat(32), index: 613 };

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ARTIFACT =
  "contracts/spending_limit_account/target/spending_limit_account_contract-SpendingLimitAccount.json";

// What openEphemeralStore names its directories under os.tmpdir().
const STORE_DIR = /^(wallet_data|pxe_data)-/;

// Read by the scripts; never inherited from the test process.
const SCRIPT_ENV = [
  "SPENDING_LIMIT_ACCOUNT",
  "SPENDING_LIMIT_ADMIN_KEY",
  "SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM",
  "PXE_BRIDGE_ALLOWLIST_SEED",
  "PXE_BRIDGE_ALLOWLIST_RECIPIENTS",
];

interface CliRun {
  code: number | null;
  output: string;
  /** Wallet store directories the run created in its TMPDIR. */
  storesCreated: string[];
  /** Wallet store directories still there after it exited. */
  storesLeft: string[];
}

/** Runs `scripts/<script>.ts` under `root` with a TMPDIR of its own. */
async function runCli(
  script: "admin" | "update-allowlist",
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  root = REPO_ROOT,
): Promise<CliRun> {
  const tmp = await mkdtemp(join(tmpdir(), "admin-cli-"));
  const created = new Set<string>();
  const watcher = watch(tmp, (_event, name) => {
    if (name && STORE_DIR.test(name)) created.add(name);
  });
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SCRIPT_ENV) delete childEnv[name];
  Object.assign(childEnv, { AZTEC_NODE_URL: config.nodeUrl, TMPDIR: tmp }, env);

  try {
    const child = spawn(TSX, [join(root, "scripts", `${script}.ts`), ...args], {
      cwd: root,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const storesLeft = (await readdir(tmp)).filter((name) => STORE_DIR.test(name));
    return { code, output, storesCreated: [...created], storesLeft };
  } finally {
    watcher.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * A copy of src/ and scripts/ whose artifact differs from the deployed one in
 * its name only. The name feeds the artifact metadata hash and so the class
 * ID; the ABI and storage layout are unchanged.
 */
async function mismatchedCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "admin-mismatch-"));
  await cp(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  await cp(join(REPO_ROOT, "scripts"), join(root, "scripts"), { recursive: true });
  await cp(join(REPO_ROOT, "package.json"), join(root, "package.json"));
  await symlink(await realpath(join(REPO_ROOT, "node_modules")), join(root, "node_modules"));
  const artifact = JSON.parse(await readFile(join(REPO_ROOT, ARTIFACT), "utf8")) as {
    name: string;
  };
  artifact.name = `${artifact.name}Mismatch`;
  await mkdir(dirname(join(root, ARTIFACT)), { recursive: true });
  await writeFile(join(root, ARTIFACT), JSON.stringify(artifact));
  return root;
}

describe("operator scripts (e2e)", () => {
  let funderWallet: unknown;
  let funderAddress: string;
  let token: string;
  let adminAddress: string;
  let account: string;

  const adminEnv = (): Record<string, string> => ({
    SPENDING_LIMIT_ACCOUNT: account,
    SPENDING_LIMIT_ADMIN_KEY: ADMIN_KEY,
  });
  const status = (args: string[] = [], env: Record<string, string> = {}): Promise<CliRun> =>
    runCli("admin", ["status", ...args], { SPENDING_LIMIT_ACCOUNT: account, ...env });
  const accountState = async () => (await readAccountState(config.nodeUrl, account)).state;

  beforeAll(async () => {
    const funder = new AztecClient(config.nodeUrl, FUNDER_KEY);
    await funder.connect();
    funderWallet = (funder as unknown as { wallet: unknown }).wallet;
    funderAddress = funder.getAddress()!;
    token = await deployTestToken(funderWallet, funderAddress);

    const keys = await deriveAccountKeys(ADMIN_KEY);
    adminAddress = (
      await getSchnorrAccountContractAddress(keys.signingKey, keys.salt, keys.secret)
    ).toString();

    const limit = new AztecClient(config.nodeUrl, LIMIT_KEY, undefined, {
      maxAmountPerTx: MAX_PER_TX,
      dailyLimit: DAILY_LIMIT,
      admin: adminAddress,
      token,
      allowlistSeed: ALLOWLIST_SEED,
      allowlistRecipients: RECIPIENTS,
    });
    await limit.connect();
    account = limit.getAddress()!;
  }, 600_000);

  it("admin deploy: refuses without a claim, deploys with one, then no-ops", async () => {
    const refused = await runCli("admin", ["deploy"], { SPENDING_LIMIT_ADMIN_KEY: ADMIN_KEY });
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain(
      `SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM is required: npm run bridge-fee-juice -- --recipient ${adminAddress}`,
    );
    expect(refused.storesLeft).toEqual([]);

    const claim = await bridgeFeeJuiceClaim(config.nodeUrl, adminAddress, FEE_JUICE_AMOUNT, () =>
      mintOne(funderWallet, token, funderAddress),
    );
    const deployed = await runCli("admin", ["deploy"], {
      SPENDING_LIMIT_ADMIN_KEY: ADMIN_KEY,
      SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM: JSON.stringify(claim),
    });
    expect(deployed.code, deployed.output).toBe(0);
    expect(deployed.output).toContain("[admin] deployed");
    expect(deployed.storesCreated.some((name) => name.startsWith("wallet_data-"))).toBe(true);
    expect(deployed.storesCreated.some((name) => name.startsWith("pxe_data-"))).toBe(true);
    expect(deployed.storesLeft).toEqual([]);

    const node = createAztecNodeClient(config.nodeUrl);
    expect(await node.getContract(AztecAddress.fromStringUnsafe(adminAddress))).toBeDefined();
    // The claim credited the admin and the deploy fee came out of it.
    const balance = await readFeeJuiceBalance(config.nodeUrl, adminAddress);
    expect(balance > 0n && balance < FEE_JUICE_AMOUNT, String(balance)).toBe(true);

    const rerun = await runCli("admin", ["deploy"], { SPENDING_LIMIT_ADMIN_KEY: ADMIN_KEY });
    expect(rerun.code, rerun.output).toBe(0);
    expect(rerun.output).toContain("already deployed; nothing sent");
    expect(rerun.storesCreated.length).toBeGreaterThan(0);
    expect(rerun.storesLeft).toEqual([]);
    expect(await readFeeJuiceBalance(config.nodeUrl, adminAddress)).toBe(balance);
  }, 900_000);

  it("pause and unpause, with status exit bits", async () => {
    const clean = await status();
    expect(clean.code, clean.output).toBe(0);

    const paused = await runCli("admin", ["pause"], adminEnv());
    expect(paused.code, paused.output).toBe(0);
    expect(paused.storesLeft).toEqual([]);
    expect((await accountState()).paused).toBe(true);
    expect((await status()).code).toBe(2);
    expect((await status(["--expect-paused"])).code).toBe(0);

    const unpaused = await runCli("admin", ["unpause"], adminEnv());
    expect(unpaused.code, unpaused.output).toBe(0);
    expect((await accountState()).paused).toBe(false);
    expect((await status()).code).toBe(0);
  }, 900_000);

  it("propose-limits and cancel-limits, with status exit bits", async () => {
    const proposed = await runCli(
      "admin",
      ["propose-limits", "--max-per-tx", String(MAX_PER_TX * 2n), "--daily", String(DAILY_LIMIT * 2n)],
      adminEnv(),
    );
    expect(proposed.code, proposed.output).toBe(0);
    const pending = await accountState();
    expect(pending.maxAmountPerTx).toBe(MAX_PER_TX);
    expect(pending.pendingMaxAmount).toBe(MAX_PER_TX * 2n);
    expect(pending.pendingDailyLimit).toBe(DAILY_LIMIT * 2n);
    expect(pending.pendingChangeTime).toBeGreaterThan(0n);
    expect((await status()).code).toBe(4);

    const cancelled = await runCli("admin", ["cancel-limits"], adminEnv());
    expect(cancelled.code, cancelled.output).toBe(0);
    const cleared = await accountState();
    expect(cleared.pendingMaxAmount).toBe(0n);
    expect(cleared.pendingChangeTime).toBe(0n);
    expect((await status()).code).toBe(0);
  }, 900_000);

  it("pause and unpause proceed on a class mismatch; propose-limits refuses", async () => {
    const root = await mismatchedCopy();
    try {
      const paused = await runCli("admin", ["pause"], adminEnv(), root);
      expect(paused.code, paused.output).toBe(0);
      expect(paused.output).toContain("[admin] warning: contract class mismatch");
      expect((await accountState()).paused).toBe(true);
      expect((await status()).code).toBe(2);

      const proposed = await runCli(
        "admin",
        ["propose-limits", "--max-per-tx", String(MAX_PER_TX * 2n), "--daily", String(DAILY_LIMIT * 2n)],
        adminEnv(),
        root,
      );
      expect(proposed.code, proposed.output).toBe(1);
      expect(proposed.output).toContain("contract class mismatch");
      expect(proposed.output).not.toContain("[admin] tx:");
      expect((await accountState()).pendingChangeTime).toBe(0n);

      const unpaused = await runCli("admin", ["unpause"], adminEnv(), root);
      expect(unpaused.code, unpaused.output).toBe(0);
      expect(unpaused.output).toContain("[admin] warning: contract class mismatch");
      expect((await accountState()).paused).toBe(false);
      expect((await status()).code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 900_000);

  it("update-allowlist --add moves the root to the locally built tree", async () => {
    const before = await AllowlistTree.build(ALLOWLIST_SEED, RECIPIENTS);
    expect((await accountState()).allowlistRoot).toBe(before.root.toString());

    const run = await runCli(
      "update-allowlist",
      ["--add", ADDED.address, "--index", String(ADDED.index)],
      {
        ...adminEnv(),
        PXE_BRIDGE_ALLOWLIST_SEED: ALLOWLIST_SEED,
        PXE_BRIDGE_ALLOWLIST_RECIPIENTS: JSON.stringify(RECIPIENTS),
      },
    );
    expect(run.code, run.output).toBe(0);
    expect(run.storesLeft).toEqual([]);

    const next = [...RECIPIENTS, ADDED];
    const after = await AllowlistTree.build(ALLOWLIST_SEED, next);
    expect(after.root.toString()).not.toBe(before.root.toString());
    expect((await accountState()).allowlistRoot).toBe(after.root.toString());
    expect(run.output).toContain(JSON.stringify(next));

    const allowlistEnv = (set: AllowlistRecipient[]) => ({
      PXE_BRIDGE_ALLOWLIST_SEED: ALLOWLIST_SEED,
      PXE_BRIDGE_ALLOWLIST_RECIPIENTS: JSON.stringify(set),
    });
    expect((await status([], allowlistEnv(next))).code).toBe(0);
    expect((await status([], allowlistEnv(RECIPIENTS))).code).toBe(8);
  }, 900_000);
});
