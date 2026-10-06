import { describe, it, expect, beforeAll, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { NO_FROM } from "@aztec/aztec.js/account";
import { generateClaimSecret } from "@aztec/aztec.js/ethereum";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { ContractInitializationStatus } from "@aztec/aztec.js/wallet";
import { createPublicClient, http } from "viem";
import {
  ALLOW_SPONSORED_FPC_ENV,
  AztecClient,
  DEPLOYER_FEE_JUICE_CLAIM_ENV,
  SPONSORED_FPC_REFUSED_ERROR,
  deriveAccountKeys,
  deriveDeployerKeys,
  feeJuiceMessageHash,
} from "../../src/aztec-client.js";
import {
  SpendingLimitAccountContract,
  type SpendingLimitConfig,
} from "../../src/spending-limit-account.js";
import {
  claimFeeJuiceFor,
  recoverFeeJuiceClaim,
  writePendingDeposit,
  type ClaimingWallet,
} from "../../src/fee-juice.js";
import type { BridgedFeeJuiceClaim } from "../../src/types.js";
import {
  bridgeClaim,
  bridgeLosingReceipt,
  deployTestToken,
  feeWithHeadroom,
  fundFeeJuiceDust,
  getTestConfig,
  mintOne,
  requireTestToken,
  sponsoredFee,
  FUNDER_KEY,
  L1_RPC,
} from "./helpers.js";

/**
 * The production deploy path for the spending-limit account (#30): no
 * SponsoredFPC, a claim bridged to the deployer, and the deployer's balance
 * paying for both deploys.
 *
 * SponsoredFPC is switched off for the client under test, so its fallback
 * throws if reached. Getting the account on chain is therefore the proof that
 * neither deploy touched it, and the deployer's balance is the proof of who
 * paid.
 */

const config = getTestConfig();

// Fresh keys, so each deployer and limit account starts undeployed whichever
// other suites ran first.
const DEPLOYER_PATH_KEY = "0x000000000000000000000000000000000000000000000000000000000000feed";
const REFUSED_PATH_KEY = "0x000000000000000000000000000000000000000000000000000000000000fade";
const FUNDED_PATH_KEY = "0x000000000000000000000000000000000000000000000000000000000000face";
const SPENT_CLAIM_KEY = "0x000000000000000000000000000000000000000000000000000000000000deaf";
const DUST_KEY = "0x000000000000000000000000000000000000000000000000000000000000d057";

// Anvil's first default account, the L1 sender in tests/e2e/helpers.ts.
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const BRIDGE_SCRIPT = fileURLToPath(new URL("../../scripts/bridge-fee-juice.ts", import.meta.url));
const execFileAsync = promisify(execFile);

// Pinned by the L1 faucet: bridgeClaim mints, and a mint must equal the
// faucet's fixed amount.
const DEPLOYER_FEE_JUICE = 1_000_000_000_000_000_000_000n;

/** Constructs the client with SponsoredFPC switched off, scoped to it alone. */
function withoutSponsoredFpc(make: () => AztecClient): AztecClient {
  // Read at construction, so restoring right after scopes the gate to this
  // client and leaves every other suite's sandbox fallback alone.
  const previous = process.env[ALLOW_SPONSORED_FPC_ENV];
  process.env[ALLOW_SPONSORED_FPC_ENV] = "false";
  try {
    return make();
  } finally {
    if (previous === undefined) delete process.env[ALLOW_SPONSORED_FPC_ENV];
    else process.env[ALLOW_SPONSORED_FPC_ENV] = previous;
  }
}

/** Address the bridge derives for the limit account under `key`, without deploying. */
async function limitAccountAddress(
  wallet: unknown,
  key: string,
  limits: SpendingLimitConfig,
): Promise<string> {
  const { AccountManager } = await import("@aztec/aztec.js/wallet");
  const { secret, salt, signingKey } = await deriveAccountKeys(key);
  const manager = await AccountManager.create(
    wallet as Parameters<typeof AccountManager.create>[0],
    secret,
    new SpendingLimitAccountContract(signingKey, limits),
    { salt },
  );
  return manager.getInstance().address.toString();
}

/** Runs connect() and returns the lines it logged. */
async function connectLogged(client: AztecClient): Promise<string[]> {
  const log = vi.spyOn(console, "log");
  try {
    await client.connect();
    return log.mock.calls.map((args) => args.join(" "));
  } finally {
    log.mockRestore();
  }
}

async function connectFunder(): Promise<{ wallet: EmbeddedWallet; address: string }> {
  const funder = new AztecClient(config.nodeUrl, FUNDER_KEY);
  await funder.connect();
  return {
    wallet: (funder as unknown as { wallet: EmbeddedWallet }).wallet,
    address: funder.getAddress()!,
  };
}

/** Limits on global-setup's token, whose admin is the funder. */
function limitsOn(admin: string): SpendingLimitConfig {
  return {
    maxAmountPerTx: 1_000n,
    dailyLimit: 10_000n,
    admin,
    token: requireTestToken(),
    allowlistSeed: "0x" + "09".repeat(32),
    allowlistRecipients: [{ address: "0x" + "11".repeat(32), index: 512 }],
  };
}

/** Registers the deployer `key` derives with `wallet`, without deploying it. */
async function registerDeployer(
  wallet: EmbeddedWallet,
  key: string,
): Promise<{ address: AztecAddress; deploy: () => Promise<unknown> }> {
  const { secret, salt, signingKey } = await deriveDeployerKeys(key);
  const manager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  return {
    address: (await manager.getAccount()).getAddress(),
    deploy: async () =>
      (await manager.getDeployMethod()).send({ from: NO_FROM, fee: await feeWithHeadroom(wallet) }),
  };
}

async function isInitialized(wallet: EmbeddedWallet, address: AztecAddress): Promise<boolean> {
  const { initializationStatus } = await wallet.getContractMetadata(address);
  return initializationStatus === ContractInitializationStatus.INITIALIZED;
}

describe("spending limit account deployed from a funded deployer (e2e)", () => {
  let funderWallet: unknown;
  let adminAddress: string;
  let tokenAddress: string;
  let deployerAddress: string;
  let claim: BridgedFeeJuiceClaim;
  let limits: SpendingLimitConfig;

  beforeAll(async () => {
    const funder = new AztecClient(config.nodeUrl, FUNDER_KEY);
    await funder.connect();
    funderWallet = (funder as unknown as { wallet: unknown }).wallet;
    adminAddress = funder.getAddress()!;
    tokenAddress = await deployTestToken(funderWallet, adminAddress);
    limits = {
      maxAmountPerTx: 1_000n,
      dailyLimit: 10_000n,
      admin: adminAddress,
      token: tokenAddress,
      allowlistSeed: "0x" + "09".repeat(32),
      allowlistRecipients: [{ address: "0x" + "11".repeat(32), index: 512 }],
    };

    // The same derivation the operator script uses to print the address it
    // bridges to.
    const { secret, salt, signingKey } = await deriveDeployerKeys(DEPLOYER_PATH_KEY);
    const manager = await (funderWallet as EmbeddedWallet).createSchnorrAccount(
      secret,
      salt,
      signingKey,
    );
    deployerAddress = (await manager.getAccount()).getAddress().toString();

    claim = await bridgeClaim(config.nodeUrl, deployerAddress, DEPLOYER_FEE_JUICE, () =>
      mintOne(funderWallet, tokenAddress, adminAddress),
    );
  }, 600_000);

  it("rebuilds the message hash the L1 Inbox reported for the deployer claim", async () => {
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    const info = await createAztecNodeClient(config.nodeUrl).getNodeInfo();
    expect(
      await feeJuiceMessageHash(deployerAddress, claim, info.l1ChainId, info.rollupVersion),
    ).toBe(claim.messageHash);
  });

  it(
    "deploys both accounts from the deployer claim without SponsoredFPC",
    async () => {
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { ContractInitializationStatus } = await import("@aztec/aztec.js/wallet");
      const { getFeeJuiceBalance } = await import("@aztec/aztec.js/utils");
      const node = createAztecNodeClient(config.nodeUrl);

      // Precondition: a deployer or account left by an earlier run would take
      // a different fee path and prove nothing about this one.
      const { initializationStatus } = await (funderWallet as EmbeddedWallet).getContractMetadata(
        AztecAddress.fromStringUnsafe(deployerAddress),
      );
      expect(initializationStatus).toBe(ContractInitializationStatus.UNINITIALIZED);
      const expectedAccount = AztecAddress.fromStringUnsafe(
        await limitAccountAddress(funderWallet, DEPLOYER_PATH_KEY, limits),
      );
      expect(await node.getContract(expectedAccount)).toBeUndefined();

      const client = withoutSponsoredFpc(
        () => new AztecClient(config.nodeUrl, DEPLOYER_PATH_KEY, undefined, limits, claim),
      );
      await client.connect();

      const accountAddress = AztecAddress.fromStringUnsafe(client.getAddress()!);
      expect(accountAddress.equals(expectedAccount)).toBe(true);
      expect(await node.getContract(accountAddress)).toBeDefined();

      // Both deploys came out of the claim: the balance is what the claim
      // credited less two fees, and nothing else ever credited this address.
      const remaining = await getFeeJuiceBalance(
        AztecAddress.fromStringUnsafe(deployerAddress),
        node,
      );
      expect(remaining).toBeGreaterThan(0n);
      expect(remaining).toBeLessThan(BigInt(claim.claimAmount));
    },
    600_000,
  );

  // Runs after the test above, which initialized the deployer and spent the
  // claim. Same key and claim, different limits: a new account address behind
  // an initialized deployer, so connect() finds the claim spent and the deploy
  // pays from the deployer's remaining balance. The claim path would hit the
  // spent claim's nullifier and SponsoredFPC is off, so a deployed account
  // means the preexisting path ran.
  it(
    "deploys another account from the deployer's balance once the claim is spent",
    async () => {
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { ContractInitializationStatus } = await import("@aztec/aztec.js/wallet");
      const { getFeeJuiceBalance } = await import("@aztec/aztec.js/utils");
      const node = createAztecNodeClient(config.nodeUrl);
      const deployer = AztecAddress.fromStringUnsafe(deployerAddress);

      const { initializationStatus } = await (funderWallet as EmbeddedWallet).getContractMetadata(
        deployer,
      );
      expect(initializationStatus).toBe(ContractInitializationStatus.INITIALIZED);
      const relimited: SpendingLimitConfig = { ...limits, maxAmountPerTx: 2_000n };
      const expectedAccount = AztecAddress.fromStringUnsafe(
        await limitAccountAddress(funderWallet, DEPLOYER_PATH_KEY, relimited),
      );
      expect(await node.getContract(expectedAccount)).toBeUndefined();
      const before = await getFeeJuiceBalance(deployer, node);

      const client = withoutSponsoredFpc(
        () => new AztecClient(config.nodeUrl, DEPLOYER_PATH_KEY, undefined, relimited, claim),
      );
      await client.connect();

      const accountAddress = AztecAddress.fromStringUnsafe(client.getAddress()!);
      expect(accountAddress.equals(expectedAccount)).toBe(true);
      expect(await node.getContract(accountAddress)).toBeDefined();
      expect(await getFeeJuiceBalance(deployer, node)).toBeLessThan(before);
    },
    600_000,
  );

  it(
    "refuses to deploy without a deployer claim when SponsoredFPC is off",
    async () => {
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const node = createAztecNodeClient(config.nodeUrl);

      const client = withoutSponsoredFpc(
        () => new AztecClient(config.nodeUrl, REFUSED_PATH_KEY, undefined, limits),
      );
      await expect(client.connect()).rejects.toThrow(SPONSORED_FPC_REFUSED_ERROR);

      const account = AztecAddress.fromStringUnsafe(
        await limitAccountAddress(funderWallet, REFUSED_PATH_KEY, limits),
      );
      expect(await node.getContract(account)).toBeUndefined();
    },
    600_000,
  );
});

// No deployer claim configured: the deployer is initialized and funded by a
// top-up, the claim for which is recovered from its secret alone.
describe("deployer funded by a top-up, no claim configured (e2e)", () => {
  let funderWallet: EmbeddedWallet;
  let funderAddress: string;
  let limits: SpendingLimitConfig;
  let deployer: AztecAddress;

  beforeAll(async () => {
    ({ wallet: funderWallet, address: funderAddress } = await connectFunder());
    limits = limitsOn(funderAddress);
    // Initialized with no balance, as a deployer that paid via SponsoredFPC.
    const registered = await registerDeployer(funderWallet, FUNDED_PATH_KEY);
    deployer = registered.address;
    await registered.deploy();
  }, 600_000);

  it(
    "recovers a claim from its secret and claims it for the deployer",
    async () => {
      const node = createAztecNodeClient(config.nodeUrl);
      expect(await getFeeJuiceBalance(deployer, node)).toBe(0n);

      const token = requireTestToken();
      const deposit = await bridgeLosingReceipt(
        config.nodeUrl,
        deployer.toString(),
        DEPLOYER_FEE_JUICE,
        () => mintOne(funderWallet, token, funderAddress),
      );

      const recovered = await recoverFeeJuiceClaim({
        nodeUrl: config.nodeUrl,
        l1RpcUrl: L1_RPC,
        recipient: deposit.recipient,
        amount: BigInt(deposit.claimAmount),
        claimSecret: deposit.claimSecret,
        secretHash: deposit.secretHash,
        fromBlock: BigInt(deposit.l1FromBlock),
        l1Sender: deposit.l1Sender,
      });
      const info = await node.getNodeInfo();
      expect(recovered.messageHash).toBe(
        await feeJuiceMessageHash(deployer.toString(), recovered, info.l1ChainId, info.rollupVersion),
      );

      // The operator path: the script recovers from the file it writes before
      // the deposit, prints the same claim, then deletes the file.
      const dir = mkdtempSync(join(tmpdir(), "pxe-bridge-recover-"));
      try {
        const file = writePendingDeposit(deposit, dir);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          AZTEC_NODE_URL: config.nodeUrl,
          L1_RPC_URL: L1_RPC,
        };
        for (const name of [
          "PXE_BRIDGE_SECRET_KEY",
          "FEE_JUICE_RECIPIENT",
          "BRIDGE_AMOUNT",
          "FEE_JUICE_CLAIM_SECRET",
          "FEE_JUICE_RECOVER_FROM_BLOCK",
        ]) {
          delete env[name];
        }
        const { stdout } = await execFileAsync(
          TSX,
          [BRIDGE_SCRIPT, "--deployer", "--recipient", deposit.recipient, "--recover", file],
          { env, cwd: dir },
        );
        const printed = new RegExp(`^${DEPLOYER_FEE_JUICE_CLAIM_ENV}='(.*)'$`, "m").exec(stdout);
        expect(printed, stdout).not.toBeNull();
        expect(JSON.parse(printed![1]!)).toEqual({
          claimAmount: recovered.claimAmount,
          claimSecret: recovered.claimSecret,
          messageLeafIndex: recovered.messageLeafIndex,
        });
        expect(existsSync(file)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      await claimFeeJuiceFor({
        wallet: funderWallet as unknown as ClaimingWallet,
        payer: funderAddress,
        recipient: deployer.toString(),
        claim: recovered,
        paymentMethod: await sponsoredFee(funderWallet),
      });
      expect(await getFeeJuiceBalance(deployer, node)).toBe(DEPLOYER_FEE_JUICE);
    },
    600_000,
  );

  // A deposit that was never mined, with nothing pending from its sender.
  it(
    "reports a missing deposit with nothing pending as safe to bridge anew",
    async () => {
      const [secret, secretHash] = await generateClaimSecret();
      const fromBlock = await createPublicClient({ transport: http(L1_RPC) }).getBlockNumber();
      await expect(
        recoverFeeJuiceClaim({
          nodeUrl: config.nodeUrl,
          l1RpcUrl: L1_RPC,
          recipient: deployer.toString(),
          amount: DEPLOYER_FEE_JUICE,
          claimSecret: secret.toString(),
          secretHash: secretHash.toString(),
          fromBlock,
          l1Sender: ANVIL_ADDRESS,
        }),
      ).rejects.toThrow(/no transaction from .* is pending at this RPC.*Safe to bridge anew/);
    },
    120_000,
  );

  // Runs after the top-up above.
  it(
    "deploys the account from the deployer's balance without SponsoredFPC",
    async () => {
      const node = createAztecNodeClient(config.nodeUrl);
      expect(await isInitialized(funderWallet, deployer)).toBe(true);
      const before = await getFeeJuiceBalance(deployer, node);
      expect(before).toBeGreaterThan(0n);
      const expectedAccount = await limitAccountAddress(funderWallet, FUNDED_PATH_KEY, limits);
      expect(await node.getContract(AztecAddress.fromStringUnsafe(expectedAccount))).toBeUndefined();

      const client = new AztecClient(config.nodeUrl, FUNDED_PATH_KEY, undefined, limits, undefined, {
        allowSponsoredFpc: false,
      });
      const lines = await connectLogged(client);

      expect(client.getAddress()).toBe(expectedAccount);
      expect(lines).toContain(
        `[pxe-bridge] Paying deployment of ${expectedAccount} from the deployer's fee juice balance`,
      );
      expect(lines).not.toContain(`[pxe-bridge] Deploying deployer account ${deployer.toString()}...`);
      expect(await node.getContract(AztecAddress.fromStringUnsafe(expectedAccount))).toBeDefined();
      expect(await getFeeJuiceBalance(deployer, node)).toBeLessThan(before);
    },
    600_000,
  );
});

// The configured claim was consumed for the deployer by another payer before
// the deployer was initialized: the balance it credited pays both deploys.
describe("uninitialized deployer whose claim is already spent (e2e)", () => {
  let funderWallet: EmbeddedWallet;
  let limits: SpendingLimitConfig;
  let deployer: AztecAddress;
  let claim: BridgedFeeJuiceClaim;

  beforeAll(async () => {
    let funderAddress: string;
    ({ wallet: funderWallet, address: funderAddress } = await connectFunder());
    limits = limitsOn(funderAddress);
    deployer = (await registerDeployer(funderWallet, SPENT_CLAIM_KEY)).address;

    const token = requireTestToken();
    claim = await bridgeClaim(config.nodeUrl, deployer.toString(), DEPLOYER_FEE_JUICE, () =>
      mintOne(funderWallet, token, funderAddress),
    );
    await claimFeeJuiceFor({
      wallet: funderWallet as unknown as ClaimingWallet,
      payer: funderAddress,
      recipient: deployer.toString(),
      claim,
      paymentMethod: await sponsoredFee(funderWallet),
    });
  }, 600_000);

  it(
    "self-deploys the deployer from its balance, then the account",
    async () => {
      const node = createAztecNodeClient(config.nodeUrl);
      expect(await isInitialized(funderWallet, deployer)).toBe(false);
      expect(await getFeeJuiceBalance(deployer, node)).toBe(DEPLOYER_FEE_JUICE);
      const expectedAccount = await limitAccountAddress(funderWallet, SPENT_CLAIM_KEY, limits);

      const client = new AztecClient(config.nodeUrl, SPENT_CLAIM_KEY, undefined, limits, claim, {
        allowSponsoredFpc: false,
      });
      const lines = await connectLogged(client);

      expect(lines).toContain(
        `[pxe-bridge] ${DEPLOYER_FEE_JUICE_CLAIM_ENV} is spent; paying the deployer's deployment ` +
          `from its fee juice balance (${DEPLOYER_FEE_JUICE})`,
      );
      expect(lines).toContain(
        `[pxe-bridge] Paying deployment of ${expectedAccount} from the deployer's fee juice balance`,
      );
      expect(await isInitialized(funderWallet, deployer)).toBe(true);
      expect(client.getAddress()).toBe(expectedAccount);
      expect(await node.getContract(AztecAddress.fromStringUnsafe(expectedAccount))).toBeDefined();
      expect(await getFeeJuiceBalance(deployer, node)).toBeLessThan(DEPLOYER_FEE_JUICE);
    },
    600_000,
  );
});

// Anyone can deposit fee juice to the deployer. Where SponsoredFPC is
// permitted, a dust balance must not take the deploy off it.
describe("deployer holding dust, SponsoredFPC permitted (e2e)", () => {
  let funderWallet: EmbeddedWallet;
  let limits: SpendingLimitConfig;
  let deployer: AztecAddress;

  beforeAll(async () => {
    let funderAddress: string;
    ({ wallet: funderWallet, address: funderAddress } = await connectFunder());
    limits = limitsOn(funderAddress);
    const registered = await registerDeployer(funderWallet, DUST_KEY);
    deployer = registered.address;
    await registered.deploy();
    const token = requireTestToken();
    await fundFeeJuiceDust(config.nodeUrl, funderWallet, funderAddress, deployer.toString(), () =>
      mintOne(funderWallet, token, funderAddress),
    );
  }, 600_000);

  it(
    "deploys the account via SponsoredFPC and leaves the dust",
    async () => {
      const node = createAztecNodeClient(config.nodeUrl);
      expect(await isInitialized(funderWallet, deployer)).toBe(true);
      expect(await getFeeJuiceBalance(deployer, node)).toBe(1n);
      const expectedAccount = await limitAccountAddress(funderWallet, DUST_KEY, limits);

      const client = new AztecClient(config.nodeUrl, DUST_KEY, undefined, limits, undefined, {
        allowSponsoredFpc: true,
      });
      const lines = await connectLogged(client);

      expect(
        lines.some((l) => l.startsWith("[pxe-bridge] Deployer fee juice balance 1 is below a deployment's fee limit")),
        lines.join("\n"),
      ).toBe(true);
      expect(client.getAddress()).toBe(expectedAccount);
      expect(await node.getContract(AztecAddress.fromStringUnsafe(expectedAccount))).toBeDefined();
      expect(await getFeeJuiceBalance(deployer, node)).toBe(1n);
    },
    600_000,
  );
});
