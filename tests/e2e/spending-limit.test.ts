import { describe, it, expect, beforeAll } from "vitest";
import { AztecClient } from "../../src/aztec-client.js";
import type { SpendingLimitConfig } from "../../src/spending-limit-account.js";
import { getTestConfig, deployTestToken, sponsoredFee } from "./helpers.js";

/**
 * The first e2e coverage of the on-chain spending-limit account.
 *
 * Every NM-1019 finding was remediated in Noir and verified only by `nargo
 * test`, which runs in Brillig and says nothing about the transpiled AVM
 * bytecode that actually executes check_spending_public. These tests are what
 * make the on-chain claims checkable.
 *
 * Two of them are load-bearing for the audit response and are marked so:
 *
 *   PHASE ORDERING -- an over-limit transfer must revert AND leave no note.
 *   If end_setup() ever moves below execute_calls the transfer lands in the
 *   non-revertible phase, every limit silently becomes advisory, and all 44
 *   Noir tests still pass. Nothing but this test can catch that.
 *
 *   L2 REVOCATION -- an immediate removal must stop further transfers to that
 *   recipient. NOT YET COVERED: that a removal invalidates a transaction which
 *   was already PROVEN. That needs prove-then-remove-then-send ordering and is
 *   the only evidence that will ever exist for the stronger half of the L2
 *   claim, so it must be written before that half is published.
 */

const config = getTestConfig();

// Distinct from the bridge key so the two accounts do not collide.
const FUNDER_KEY = "0x000000000000000000000000000000000000000000000000000000000000cafe";

const MAX_PER_TX = 1_000_000_000_000_000_000_000n; // 1000 tokens at 18 decimals
const DAILY_LIMIT = 5_000_000_000_000_000_000_000n; // 5000 tokens
const MINT_AMOUNT = 100_000_000_000_000_000_000_000n; // 100k tokens

// Any well-formed address works: the allowlist only ever compares equality.
const SEED_RECIPIENT = "0x" + "11".repeat(32);
const UNLISTED_RECIPIENT = "0x" + "22".repeat(32);


describe("spending limit account (e2e)", () => {
  let client: AztecClient;
  let accountAddress: string;
  let tokenAddress: string;
  let deployFailure: unknown;
  let funderWallet: unknown;
  let adminAddress: string;

  beforeAll(async () => {
    // A plain Schnorr client owns and mints the token. Keeping it separate
    // from the limit account matters: the limit account can only ever call
    // transfer_to_private on the pinned token, so it cannot mint to itself.
    const funder = new AztecClient(config.nodeUrl, FUNDER_KEY);
    await funder.connect();

    funderWallet = (funder as unknown as { wallet: unknown }).wallet;
    // The funder is the admin, so the admin paths are actually reachable. A
    // dummy address would make every admin function untestable.
    adminAddress = funder.getAddress()!;
    tokenAddress = await deployTestToken(funderWallet, adminAddress);

    const spendingLimitConfig: SpendingLimitConfig = {
      maxAmountPerTx: MAX_PER_TX,
      dailyLimit: DAILY_LIMIT,
      admin: adminAddress,
      token: tokenAddress,
      seedRecipient: SEED_RECIPIENT,
      // A one-entry allowlist can only satisfy a floor of 1.
      minAnonymitySet: 1,
    };

    client = new AztecClient(
      config.nodeUrl,
      config.secretKey,
      config.feeJuiceClaim,
      spendingLimitConfig,
    );

    // Deployment is the Info finding's subject. Capture rather than throw so
    // the failure is reported once, with its message, instead of as an opaque
    // hook error on every test.
    try {
      await client.connect();
      accountAddress = client.getAddress()!;
      await mintTo(funderWallet, tokenAddress, accountAddress, MINT_AMOUNT, adminAddress);
    } catch (err) {
      deployFailure = err;
    }
  }, 600_000);

  it("deploys the spending limit account", () => {
    if (deployFailure) {
      throw new Error(
        `spending-limit account failed to deploy: ${(deployFailure as Error).message}`,
      );
    }
    expect(accountAddress).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("transfers within the per-tx limit", async (ctx) => {
    if (deployFailure) return ctx.skip();
    const res = await client.createNote({
      chainId: 1,
      token: tokenAddress,
      recipient: SEED_RECIPIENT,
      amount: (MAX_PER_TX / 2n).toString(),
    });
    expect(res.l2TxHash).toBeTruthy();
    expect(res.noteCommitment).toBeTruthy();
  });

  // PHASE ORDERING. Reverting is necessary but not sufficient: the transfer
  // must not have been committed. If this passes only the "rejects" half,
  // end_setup() has moved below execute_calls and every limit is advisory.
  it("rejects a transfer above the per-tx limit and commits no note", async (ctx) => {
    if (deployFailure) return ctx.skip();
    const before = await balanceOf(client, tokenAddress, accountAddress);

    await expect(
      client.createNote({
        chainId: 1,
        token: tokenAddress,
        recipient: SEED_RECIPIENT,
        amount: (MAX_PER_TX + 1n).toString(),
      }),
    ).rejects.toThrow();

    const after = await balanceOf(client, tokenAddress, accountAddress);
    expect(after).toBe(before);
  });

  it("rejects a recipient that is not allowlisted", async (ctx) => {
    if (deployFailure) return ctx.skip();
    await expect(
      client.createNote({
        chainId: 1,
        token: tokenAddress,
        recipient: UNLISTED_RECIPIENT,
        amount: "1000",
      }),
    ).rejects.toThrow();
  });

  it("rejects a transfer that would exceed the daily window", async (ctx) => {
    if (deployFailure) return ctx.skip();
    // The window is 25 hourly buckets summed, so repeated max-size transfers
    // accumulate until the daily limit rejects one. DAILY_LIMIT / MAX_PER_TX
    // is 5, and one transfer has already landed above.
    let rejected = false;
    for (let i = 0; i < 8; i++) {
      try {
        await client.createNote({
          chainId: 1,
          token: tokenAddress,
          recipient: SEED_RECIPIENT,
          amount: MAX_PER_TX.toString(),
        });
      } catch {
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
  }, 600_000);

  // L2 REVOCATION. remove_recipient is untimelocked and must bite immediately.
  it("stops transfers to a recipient the admin removes", async (ctx) => {
    if (deployFailure) return ctx.skip();
    await removeRecipient(funderWallet, client, accountAddress, SEED_RECIPIENT, adminAddress);

    await expect(
      client.createNote({
        chainId: 1,
        token: tokenAddress,
        recipient: SEED_RECIPIENT,
        amount: "1000",
      }),
    ).rejects.toThrow();
  }, 600_000);
});

async function removeRecipient(
  wallet: unknown,
  client: AztecClient,
  account: string,
  recipient: string,
  admin: string,
): Promise<void> {
  const { Contract } = await import("@aztec/aztec.js/contracts");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const slc = (client as unknown as {
    spendingLimitContract: { getContractArtifact: () => Promise<unknown> };
  }).spendingLimitContract;
  const artifact = await slc.getContractArtifact();
  const c = await (
    Contract as unknown as {
      at: (a: unknown, art: unknown, w: unknown) => Promise<{
        methods: Record<
        string,
        (...a: unknown[]) => { send: (o: { from: unknown; fee: unknown }) => Promise<unknown> }
      >;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(account), artifact, wallet);
  await c.methods["remove_recipient"]!(AztecAddress.fromStringUnsafe(recipient)).send({
    from: AztecAddress.fromStringUnsafe(admin),
    fee: { paymentMethod: await sponsoredFee(wallet) },
  });
}

async function mintTo(
  wallet: unknown,
  token: string,
  to: string,
  amount: bigint,
  minter: string,
): Promise<void> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const contract = await (
    TokenContract as unknown as {
      at: (a: unknown, w: unknown) => Promise<{
        methods: Record<
        string,
        (...a: unknown[]) => { send: (o: { from: unknown; fee: unknown }) => Promise<unknown> }
      >;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(token), wallet);
  await contract.methods["mint_to_private"]!(
    AztecAddress.fromStringUnsafe(to),
    amount,
  ).send({
    from: AztecAddress.fromStringUnsafe(minter),
    fee: { paymentMethod: await sponsoredFee(wallet) },
  });
}

async function balanceOf(
  client: AztecClient,
  token: string,
  owner: string,
): Promise<bigint> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const wallet = (client as unknown as { wallet: unknown }).wallet;
  const contract = await (
    TokenContract as unknown as {
      at: (a: unknown, w: unknown) => Promise<{
        methods: Record<string, (...a: unknown[]) => { simulate: () => Promise<unknown> }>;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(token), wallet);
  const bal = await contract.methods["balance_of_private"]!(
    AztecAddress.fromStringUnsafe(owner),
  ).simulate();
  return typeof bal === "bigint" ? bal : BigInt(String(bal));
}
