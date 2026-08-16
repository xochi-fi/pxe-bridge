import { describe, it, expect, beforeAll } from "vitest";
import { AztecClient } from "../../src/aztec-client.js";
import type { SpendingLimitConfig } from "../../src/spending-limit-account.js";
import {
  getTestConfig,
  deployTestToken,
  sponsoredFee,
  fundFeeJuice,
  mintOne,
} from "./helpers.js";

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

// Covers the deployment claim plus the transfers below, which the daily-window
// test repeats until a limit rejects one.
const FEE_JUICE_AMOUNT = 1_000_000_000_000_000_000_000n;

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
      // Must happen after deployment: the account pays for its own transfers
      // out of a pre-existing fee juice balance and has no way to acquire one
      // itself. See fundFeeJuice.
      await fundFeeJuice(
        config.nodeUrl,
        funderWallet,
        adminAddress,
        accountAddress,
        FEE_JUICE_AMOUNT,
        () => mintOne(funderWallet, tokenAddress, adminAddress),
      );
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

  // L2 REVOCATION, the strong half: a removal must reach a transaction that is
  // ALREADY PROVEN. A private proof commits to the allowlist as it stood when
  // the proof was made, so nothing inside it can notice a later removal. Only
  // check_spending_public re-derives the list at inclusion and rebinds the hint
  // to it (invariant 4 on the entrypoint). That check alone is the immediacy
  // claim, and this is the only test that reaches it: every other rejection in
  // this file happens in private, before a proof exists.
  //
  // Two transfers are proven together, against the same allowlist and the same
  // anchor state, and submitted either side of the removal. The node reports a
  // bare "reverted" with no reason, so the reason is established by the pair
  // rather than by the receipt: identical transactions, identical proving
  // conditions, and the only difference between the one that lands and the one
  // that does not is the removal.
  //
  // Amounts are small on purpose. The daily-window test above left the window
  // near its cap, and a rejection for volume would prove nothing about
  // revocation.
  //
  // This test performs the removal that the next one then observes.
  it("invalidates a transfer proven before the recipient was removed", async (ctx) => {
    if (deployFailure) return ctx.skip();

    const control = await proveTransfer(client, tokenAddress, SEED_RECIPIENT, 1000n);
    const revoked = await proveTransfer(client, tokenAddress, SEED_RECIPIENT, 1000n);

    // With nothing revoked, this shape lands. Also rules out the negative
    // result below being proveTransfer building a broken transaction.
    const before = await balanceOf(client, tokenAddress, accountAddress);
    expect(await control.submit()).toBe("success");
    expect(await balanceOf(client, tokenAddress, accountAddress)).toBe(before - 1000n);

    await removeRecipient(funderWallet, client, accountAddress, SEED_RECIPIENT, adminAddress);

    // "reverted", not a refusal at admission, is the result that carries the
    // claim: the proof was valid, the node accepted the transaction and put it
    // in a block, and the public phase killed it there. Pinned rather than
    // loosened to "not success" so that a check migrating out of
    // check_spending_public -- into private, where it could not see a later
    // removal -- shows up here instead of passing quietly.
    const afterControl = await balanceOf(client, tokenAddress, accountAddress);
    expect(await revoked.submit()).toBe("reverted");
    expect(await balanceOf(client, tokenAddress, accountAddress)).toBe(afterControl);
  }, 600_000);

  // L2 REVOCATION, the weak half: once removed, a transfer built from scratch
  // never gets as far as proving, because is_allowlisted rejects it in private.
  // The removal happened in the test above.
  it("stops transfers to a recipient the admin removes", async (ctx) => {
    if (deployFailure) return ctx.skip();

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

/** A transfer whose proof exists but which has not been submitted. */
interface ProvenTransfer {
  txHash: string;
  /**
   * Submits it and waits, reporting how the network settled it: "success",
   * "reverted", "dropped", or a refusal at admission. Reported rather than
   * thrown because which of those happens is the substance of the revocation
   * claim, not an incidental detail.
   */
  submit: () => Promise<string>;
}

/** The slice of BaseWallet needed to split proving from submission. */
interface WalletInternals {
  pxe: {
    proveTx: (
      request: unknown,
      opts: unknown,
    ) => Promise<{ toTx: () => Promise<{ getTxHash: () => { toString: () => string } }> }>;
  };
  aztecNode: {
    sendTx: (tx: unknown) => Promise<void>;
    getTxReceipt: (
      txHash: unknown,
    ) => Promise<{ status: string; executionResult?: string; error?: string }>;
  };
  completeFeeOptions: (opts: unknown) => Promise<unknown>;
  createTxExecutionRequestFromPayloadAndFee: (
    payload: unknown,
    from: unknown,
    feeOptions: unknown,
  ) => Promise<unknown>;
}

/**
 * Builds and PROVES a transfer without submitting it.
 *
 * The interaction API has no prove/send split -- send() does both in one call
 * -- so this repeats the three steps BaseWallet.sendTx takes between them:
 * complete the fee options, build the tx request, prove it. Holding a proven
 * transaction across an admin action is the only way to show that revocation
 * binds at inclusion rather than at proving time.
 */
async function proveTransfer(
  client: AztecClient,
  token: string,
  recipient: string,
  amount: bigint,
): Promise<ProvenTransfer> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");

  const inner = client as unknown as {
    wallet: WalletInternals;
    solverAddress: unknown;
    spendingLimitContract: {
      setDeclaredSpending: (amount: bigint, recipient: string, hint: string[]) => void;
    };
    readAllowlist: () => Promise<string[]>;
  };
  const wallet = inner.wallet;
  const from = inner.solverAddress;

  // The binding createNote performs before it sends. The entrypoint signs the
  // declaration, so it has to be set before the payload is built, and the hint
  // is read against the allowlist as it stands now -- which is the state this
  // test is about to invalidate.
  const hint = await inner.readAllowlist.call(client);
  inner.spendingLimitContract.setDeclaredSpending(amount, recipient, hint);

  const contract = await (
    TokenContract as unknown as {
      at: (a: unknown, w: unknown) => Promise<{
        methods: Record<
          string,
          (...a: unknown[]) => { request: (o: { from: unknown }) => Promise<{ feePayer: unknown }> }
        >;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(token), wallet);

  const payload = await contract.methods["transfer_to_private"]!(
    AztecAddress.fromStringUnsafe(recipient),
    amount,
  ).request({ from });

  const feeOptions = await wallet.completeFeeOptions({ from, feePayer: payload.feePayer });
  const txRequest = await wallet.createTxExecutionRequestFromPayloadAndFee(
    payload,
    from,
    feeOptions,
  );
  // scopesFrom(from, [], undefined) is [from]; senderForTagsFrom(from, undefined) is from.
  const provingResult = await wallet.pxe.proveTx(txRequest, {
    scopes: [from],
    senderForTags: from,
  });
  const tx = await provingResult.toTx();
  const txHash = tx.getTxHash();

  return {
    txHash: txHash.toString(),
    submit: async () => {
      try {
        await wallet.aztecNode.sendTx(tx);
      } catch (err) {
        return `refused at admission: ${(err as Error).message}`;
      }
      return waitForExecution(wallet, txHash);
    },
  };
}

/** Polls until the node reports how `txHash` executed. */
async function waitForExecution(
  wallet: WalletInternals,
  txHash: unknown,
  timeoutMs = 180_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await wallet.aztecNode.getTxReceipt(txHash);
    if (receipt.executionResult !== undefined) {
      // The reason distinguishes "the guard rejected this" from "it reverted
      // for some unrelated reason", which is the whole value of the assertion.
      return receipt.error ? `${receipt.executionResult}: ${receipt.error}` : receipt.executionResult;
    }
    if (receipt.status === "dropped") {
      return "dropped";
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return "not mined within the timeout";
}

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
  // transfer_to_private moves the sender's PUBLIC balance into a private note
  // for the recipient, so the account has to be funded publicly. Minting to
  // private leaves the public balance at zero and the transfer fails inside the
  // token with "attempt to subtract with overflow".
  await contract.methods["mint_to_public"]!(
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
        methods: Record<string, (...a: unknown[]) => { simulate: (o?: unknown) => Promise<unknown> }>;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(token), wallet);
  // The public balance is the one transfer_to_private debits, so it is the one
  // that shows whether a rejected transfer nonetheless committed.
  //
  // `from` scopes the execution. Without it PXE throws and its own error
  // formatter then crashes on undefined args, reporting "Cannot read properties
  // of undefined (reading 'toString')" instead of the real cause.
  const bal = await contract.methods["balance_of_public"]!(
    AztecAddress.fromStringUnsafe(owner),
  ).simulate({ from: AztecAddress.fromStringUnsafe(owner) });
  const value = (bal as { result?: unknown })?.result ?? bal;
  return typeof value === "bigint" ? value : BigInt(String(value));
}
