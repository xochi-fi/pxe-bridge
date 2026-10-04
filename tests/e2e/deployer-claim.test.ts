import { describe, it, expect, beforeAll } from "vitest";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import {
  ALLOW_SPONSORED_FPC_ENV,
  AztecClient,
  deriveDeployerKeys,
} from "../../src/aztec-client.js";
import type { SpendingLimitConfig } from "../../src/spending-limit-account.js";
import type { FeeJuiceClaim } from "../../src/types.js";
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

// Fresh key, so both the deployer and the limit account start undeployed
// whichever other suites ran first.
const DEPLOYER_PATH_KEY = "0x000000000000000000000000000000000000000000000000000000000000feed";

// Covers the deployer's self-deploy and the limit account's deploy, which
// publishes its class and instance.
const DEPLOYER_FEE_JUICE = 1_000_000_000_000_000_000_000n;

describe("spending limit account deployed from a funded deployer (e2e)", () => {
  let funderWallet: unknown;
  let adminAddress: string;
  let tokenAddress: string;
  let deployerAddress: string;
  let claim: FeeJuiceClaim;

  beforeAll(async () => {
    const funder = new AztecClient(config.nodeUrl, FUNDER_KEY);
    await funder.connect();
    funderWallet = (funder as unknown as { wallet: unknown }).wallet;
    adminAddress = funder.getAddress()!;
    tokenAddress = await deployTestToken(funderWallet, adminAddress);

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

  it(
    "deploys both accounts from the deployer claim without SponsoredFPC",
    async () => {
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      const { AztecAddress } = await import("@aztec/aztec.js/addresses");
      const { getFeeJuiceBalance } = await import("@aztec/aztec.js/utils");
      const node = createAztecNodeClient(config.nodeUrl);

      const spendingLimitConfig: SpendingLimitConfig = {
        maxAmountPerTx: 1_000n,
        dailyLimit: 10_000n,
        admin: adminAddress,
        token: tokenAddress,
        allowlistSeed: "0x" + "09".repeat(32),
        allowlistRecipients: [{ address: "0x" + "11".repeat(32), index: 512 }],
      };

      // Read at construction, so restoring right after scopes the gate to this
      // client and leaves every other suite's sandbox fallback alone.
      const previous = process.env[ALLOW_SPONSORED_FPC_ENV];
      process.env[ALLOW_SPONSORED_FPC_ENV] = "false";
      let client: AztecClient;
      try {
        client = new AztecClient(
          config.nodeUrl,
          DEPLOYER_PATH_KEY,
          undefined,
          spendingLimitConfig,
          claim,
        );
      } finally {
        if (previous === undefined) delete process.env[ALLOW_SPONSORED_FPC_ENV];
        else process.env[ALLOW_SPONSORED_FPC_ENV] = previous;
      }

      await client.connect();

      const accountAddress = AztecAddress.fromStringUnsafe(client.getAddress()!);
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
});
