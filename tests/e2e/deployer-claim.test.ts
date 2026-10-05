import { describe, it, expect, beforeAll } from "vitest";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import {
  ALLOW_SPONSORED_FPC_ENV,
  AztecClient,
  SPONSORED_FPC_REFUSED_ERROR,
  deriveAccountKeys,
  deriveDeployerKeys,
  feeJuiceMessageHash,
} from "../../src/aztec-client.js";
import {
  SpendingLimitAccountContract,
  type SpendingLimitConfig,
} from "../../src/spending-limit-account.js";
import type { BridgedFeeJuiceClaim } from "../../src/types.js";
import {
  bridgeClaim,
  deployTestToken,
  getTestConfig,
  mintOne,
  FUNDER_KEY,
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
