import { describe, it, expect, beforeAll, vi } from "vitest";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { NO_FROM } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { ContractInitializationStatus } from "@aztec/aztec.js/wallet";
import { AztecClient, deriveAccountKeys } from "../../src/aztec-client.js";
import {
  feeWithHeadroom,
  fundFeeJuice,
  getTestConfig,
  mintOne,
  mintTo,
  requireTestToken,
  FUNDER_KEY,
} from "./helpers.js";

/**
 * Upgrade from v0.1.2, which deployed the Schnorr account initialized but
 * unpublished. With SponsoredFPC off and no claim, connect() must recover it:
 * the deploy path would throw SPONSORED_FPC_REFUSED_ERROR.
 */

const config = getTestConfig();

// Fresh key, so the account starts undeployed whichever suites ran first.
const UNPUBLISHED_KEY = "0x000000000000000000000000000000000000000000000000000000000000b1d0";

// Matches global-setup: what the bridge account is funded with for transfers.
const FEE_JUICE_AMOUNT = 1_000_000_000_000_000_000_000n;
const MINT_AMOUNT = 1_000_000n;

describe("account deployed unpublished by v0.1.2 (e2e)", () => {
  let funderWallet: EmbeddedWallet;
  let funderAddress: string;
  let accountAddress: string;

  beforeAll(async () => {
    const funder = new AztecClient(config.nodeUrl, FUNDER_KEY);
    await funder.connect();
    funderWallet = (funder as unknown as { wallet: EmbeddedWallet }).wallet;
    funderAddress = funder.getAddress()!;

    // As v0.1.2 deployed: self-paid via SponsoredFPC, publication flags left at
    // their defaults (skipped).
    const { secret, salt, signingKey } = await deriveAccountKeys(UNPUBLISHED_KEY);
    const manager = await funderWallet.createSchnorrAccount(secret, salt, signingKey);
    accountAddress = (await manager.getAccount()).getAddress().toString();
    await (await manager.getDeployMethod()).send({
      from: NO_FROM,
      fee: await feeWithHeadroom(funderWallet),
    });
  }, 600_000);

  it(
    "recovers the account without deploying and sends from it",
    async () => {
      const metadata = await funderWallet.getContractMetadata(
        AztecAddress.fromStringUnsafe(accountAddress),
      );
      expect(metadata.initializationStatus).toBe(ContractInitializationStatus.INITIALIZED);
      expect(metadata.isContractPublished).toBe(false);

      const client = new AztecClient(config.nodeUrl, UNPUBLISHED_KEY, undefined, undefined, {
        allowSponsoredFpc: false,
      });
      const log = vi.spyOn(console, "log");
      let lines: string[];
      try {
        await client.connect();
      } finally {
        // Read before mockRestore, which clears the recorded calls.
        lines = log.mock.calls.map((args) => args.join(" "));
        log.mockRestore();
      }
      expect(lines).toContain("[pxe-bridge] Account recovered (initialized, not published)");
      expect(lines).not.toContain("[pxe-bridge] Deploying solver account...");
      expect(client.getAddress()).toBe(accountAddress);

      // createNote pays from the account's own balance and debits its public
      // token balance, neither of which v0.1.2 needed a publication for.
      const token = requireTestToken();
      await mintTo(funderWallet, token, accountAddress, MINT_AMOUNT, funderAddress);
      await fundFeeJuice(
        config.nodeUrl,
        funderWallet,
        funderAddress,
        accountAddress,
        FEE_JUICE_AMOUNT,
        () => mintOne(funderWallet, token, funderAddress),
      );

      const result = await client.createNote({
        recipient: accountAddress,
        token,
        amount: "1000",
        chainId: 1,
      });
      expect(result.l2TxHash).toBeTruthy();
      expect(result.noteHashes.length).toBeGreaterThan(0);
    },
    600_000,
  );
});
