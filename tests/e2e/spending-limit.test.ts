import { describe, it, expect, beforeAll } from "vitest";
import { AztecClient } from "../../src/aztec-client.js";
import type { SpendingLimitConfig } from "../../src/spending-limit-account.js";
import {
  getTestConfig,
  deployTestToken,
  feeWithHeadroom,
  fundFeeJuice,
  mintOne,
  mintTo,
  FUNDER_KEY,
} from "./helpers.js";

/**
 * The first e2e coverage of the on-chain spending-limit account.
 *
 * Every NM-1019 finding was remediated in Noir and verified only by `nargo
 * test`, which runs in Brillig and says nothing about the transpiled AVM
 * bytecode that actually executes check_spending_public. These tests are what
 * make the on-chain claims checkable.
 *
 * Three of them are load-bearing for the audit response and are marked so:
 *
 *   PHASE ORDERING -- an over-limit transfer must revert AND leave no note.
 *   If end_setup() ever moves below execute_calls the transfer lands in the
 *   non-revertible phase, every limit silently becomes advisory, and all 54
 *   Noir tests still pass. Nothing but this test can catch that.
 *
 *   L2 REVOCATION -- an immediate removal must stop further transfers to that
 *   recipient, and must also invalidate a transaction that was already PROVEN.
 *   The second half is the stronger claim and needs prove-then-remove-then-send
 *   ordering; it is the only evidence that will ever exist for that half.
 *
 *   ADMIN AUTH -- a non-admin must not be able to apply a pending proposal.
 *   The check is a public assert on msg_sender, so it exists only on-chain and
 *   no Noir test can reach it.
 */

const config = getTestConfig();

// A third account that is neither the admin nor the bridge. Needed because
// every other wallet in this file is privileged: the funder IS the admin, and
// the limit account can only ever call transfer_to_private on the pinned token.
//
// Chosen because its salt overflows. AztecClient derives the account salt as a
// sha256 digest, and only ~19% of digests are below the BN254 Fr modulus; this
// key is one of the ~81% that are not. It connects only because the derivation
// reduces rather than rejecting, so it is also the only end-to-end coverage of
// that reduction. The two keys above happen to land in range and would pass
// either way.
const OUTSIDER_KEY = "0x000000000000000000000000000000000000000000000000000000000000d00d";

const MAX_PER_TX = 1_000_000_000_000_000_000_000n; // 1000 tokens at 18 decimals
const DAILY_LIMIT = 5_000_000_000_000_000_000_000n; // 5000 tokens
const MINT_AMOUNT = 100_000_000_000_000_000_000_000n; // 100k tokens

// Covers the deployment claim plus the transfers below, which the daily-window
// test repeats until a limit rejects one.
const FEE_JUICE_AMOUNT = 1_000_000_000_000_000_000_000n;

// Any well-formed address works: the tree only ever commits to it.
const SEED_RECIPIENT = "0x" + "11".repeat(32);
const UNLISTED_RECIPIENT = "0x" + "22".repeat(32);

// The secret every leaf salt derives from, and the position the one recipient
// occupies. The index is deliberately not 0: filling left to right makes the
// first touch of a position visibly an addition.
const ALLOWLIST_SEED = "0x" + "07".repeat(32);
const SEED_RECIPIENT_INDEX = 137;


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
      allowlistSeed: ALLOWLIST_SEED,
      allowlistRecipients: [{ address: SEED_RECIPIENT, index: SEED_RECIPIENT_INDEX }],
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

  // Rejected before a proof exists, and now before a witness exists: the tree
  // has no leaf for this address, so there is nothing to build a path from.
  // Pinned to the message rather than left as a bare throw, so a failure for
  // some unrelated reason does not pass as allowlist enforcement.
  it("rejects a recipient that is not allowlisted", async (ctx) => {
    if (deployFailure) return ctx.skip();
    await expect(
      client.createNote({
        chainId: 1,
        token: tokenAddress,
        recipient: UNLISTED_RECIPIENT,
        amount: "1000",
      }),
    ).rejects.toThrow("is not in the allowlist");
  });

  // TOKEN PIN. check_spending_public asserts the matched call's target equals
  // permitted_token, which is fixed at construction with no setter. Nothing
  // covered that assert: the Noir test only checks the private guard REPORTS a
  // target, and the comparison itself is a public read that no Noir test can
  // reach.
  //
  // The second token is minted to the account first, and deliberately so. An
  // unfunded token would fail inside transfer_to_private on the balance, in
  // private, and would have proven nothing about the pin. With a balance, the
  // private half has no reason to object and the only thing left to stop it is
  // the public comparison.
  //
  // Placed before the daily-window and revocation tests: after them the
  // allowlist is empty and the window near its cap, either of which would
  // reject this for the wrong reason.
  it("rejects a transfer of a token that is not the pinned one", async (ctx) => {
    if (deployFailure) return ctx.skip();

    const otherToken = await deployTestToken(funderWallet, adminAddress);
    await mintTo(funderWallet, otherToken, accountAddress, MINT_AMOUNT, adminAddress);
    expect(await balanceOf(client, otherToken, accountAddress)).toBe(MINT_AMOUNT);

    await expect(
      client.createNote({
        chainId: 1,
        token: otherToken,
        recipient: SEED_RECIPIENT,
        amount: "1000",
      }),
    ).rejects.toThrow();

    // Funded, allowlisted recipient, amount well under both limits, and still
    // nothing moved. The pin is the only remaining explanation.
    expect(await balanceOf(client, otherToken, accountAddress)).toBe(MINT_AMOUNT);
  }, 600_000);

  // AUTHWIT KILL-SWITCH. A valid third-party authwit would let a token contract
  // move funds without routing through entrypoint, so check_spending_public --
  // per-tx cap, daily window, allowlist, token pin -- would never run. The
  // account answers every authwit request as invalid.
  //
  // Both halves matter. verify_private_authwit returning 0 instead of the
  // IS_VALID magic value is what actually rejects; lookup_validity returning
  // false is what stops an off-chain caller being told to submit a transaction
  // that is guaranteed to revert. The stock implementation gets the second one
  // wrong.
  //
  // Simulated from the FUNDER, not from the limit account. A private view is
  // reached through the caller's own entrypoint, and this account's entrypoint
  // runs assert_declared_matches_transfer on everything, so asking it to make
  // any non-transfer call reverts on "Transfer does not match declared
  // spending". That is the single-call guard working, but it means the account
  // cannot be used to read its own views. It also matches how the function is
  // reached in production: a consumer contract calls it, never this account.
  it("refuses every third-party authwit", async (ctx) => {
    if (deployFailure) return ctx.skip();

    const innerHash = "0x" + "07".repeat(32);

    const validity = await simulateAccount(
      client,
      funderWallet,
      adminAddress,
      "verify_private_authwit",
      [innerHash],
    );
    expect(BigInt(String(validity))).toBe(0n);

    const lookup = await simulateAccount(client, funderWallet, adminAddress, "lookup_validity", [
      UNLISTED_RECIPIENT,
      innerHash,
    ]);
    expect(lookup).toBe(false);
  }, 600_000);

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

  // L2 REVOCATION, the strong half: a revocation must reach a transaction that
  // is ALREADY PROVEN. A private proof commits to the root as it stood when the
  // proof was made, so nothing inside it can notice a later change. Only
  // check_spending_public compares the proven root against storage at inclusion
  // (invariant 5 on the entrypoint). That check alone is the immediacy claim,
  // and this is the only test that reaches it: every other rejection in this
  // file happens before a proof exists.
  //
  // Two transfers are proven together, against the same root and the same
  // anchor state, and submitted either side of the revocation. The node reports
  // a bare "reverted" with no reason, so the reason is established by the pair
  // rather than by the receipt: identical transactions, identical proving
  // conditions, and the only difference between the one that lands and the one
  // that does not is the revocation.
  //
  // Amounts are small on purpose. The daily-window test above left the window
  // near its cap, and a rejection for volume would prove nothing about
  // revocation.
  //
  // This test performs the removal that the next one then observes.
  it("invalidates a transfer proven before the recipient was revoked", async (ctx) => {
    if (deployFailure) return ctx.skip();

    const control = await proveTransfer(client, tokenAddress, SEED_RECIPIENT, 1000n);
    const revoked = await proveTransfer(client, tokenAddress, SEED_RECIPIENT, 1000n);

    // With nothing revoked, this shape lands. Also rules out the negative
    // result below being proveTransfer building a broken transaction.
    const before = await balanceOf(client, tokenAddress, accountAddress);
    expect(await control.submit()).toBe("success");
    expect(await balanceOf(client, tokenAddress, accountAddress)).toBe(before - 1000n);

    await revokeRecipient(funderWallet, client, accountAddress, SEED_RECIPIENT, adminAddress);

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

  // L2 REVOCATION, the weak half: once revoked, a transfer built from scratch
  // never gets as far as proving. The revocation happened in the test above.
  //
  // The rejection now comes from a different place, and the difference is worth
  // recording. Under the array the bridge re-read the allowlist before every
  // send, so a removal simply disappeared from the hint and is_allowlisted
  // rejected the recipient in private. There is no set on chain to re-read any
  // more, so the bridge instead compares the root it can build against the root
  // the account stores, and an admin change it has not been told about shows up
  // as drift rather than as an unlisted recipient.
  //
  // That is the honest failure. The bridge cannot know whether the recipient
  // was revoked, whether someone else was added, or whether its configuration
  // is for a different account, and saying "not allowlisted" would be claiming
  // knowledge it does not have. It fails closed either way: no transfer can be
  // built until the operator reconciles.
  it("stops transfers once the admin revokes the recipient", async (ctx) => {
    if (deployFailure) return ctx.skip();

    await expect(
      client.createNote({
        chainId: 1,
        token: tokenAddress,
        recipient: SEED_RECIPIENT,
        amount: "1000",
      }),
    ).rejects.toThrow("Allowlist root mismatch");
  }, 600_000);

  // ADMIN AUTH. apply_limits originally had no caller check at all, so anyone
  // could apply an abandoned proposal at a moment of their choosing. Not filed
  // by Nethermind; found and fixed in 97b0ba8. The check is a public assert on
  // msg_sender, which only exists on-chain, so no Noir test can reach it.
  //
  // The timelock is 24h and warping the sandbox clock that far would disturb
  // every other test sharing this node, so both calls below revert. What
  // separates them is where: the outsider is stopped by the caller check, the
  // admin gets past it and is stopped by the timelock, which is the assertion
  // immediately after. That difference is the evidence the caller check exists
  // and runs first.
  //
  // The last assertion does not depend on revert reasons at all. cancel_limits
  // requires a pending proposal, so its succeeding proves the proposal is still
  // armed and therefore that neither failed call applied it.
  it("rejects apply_limits from a non-admin", async (ctx) => {
    if (deployFailure) return ctx.skip();

    // Deployed here rather than in beforeAll. An extra account deployment ahead
    // of the limit account's own raises the sandbox base fee, and the limit
    // account then fails its deployment against a max fee estimated when fees
    // were lower ("maxFeesPerGas.feePerL2Gas must be greater than or equal to
    // gasFees.feePerL2Gas"). Nothing above this line should see fee conditions
    // it did not see before this test existed.
    const outsiderClient = new AztecClient(config.nodeUrl, OUTSIDER_KEY);
    await outsiderClient.connect();
    const outsiderWallet = (outsiderClient as unknown as { wallet: unknown }).wallet;
    const outsiderAddress = outsiderClient.getAddress()!;

    // Valid under assert_limits_valid, and far enough from the live values that
    // applying them would be a material change rather than a no-op.
    expect(
      await callAccount(client, accountAddress, funderWallet, adminAddress, "propose_limits", [
        MAX_PER_TX * 2n,
        DAILY_LIMIT * 2n,
      ]),
    ).toBe("success");

    const outsider = await callAccount(
      client,
      accountAddress,
      outsiderWallet,
      outsiderAddress,
      "apply_limits",
      [],
    );
    const admin = await callAccount(
      client,
      accountAddress,
      funderWallet,
      adminAddress,
      "apply_limits",
      [],
    );

    expect(outsider).toMatch(/Not admin/);
    expect(admin).toMatch(/Timelock not expired/);

    expect(
      await callAccount(client, accountAddress, funderWallet, adminAddress, "cancel_limits", []),
    ).toBe("success");
  }, 600_000);
});

/**
 * Simulates a view or utility function on the spending-limit account.
 *
 * `from` scopes the execution. Without it PXE throws, and its own error
 * formatter then crashes on undefined args, masking the cause. simulate()
 * resolves to { result, offchainEffects, offchainMessages }, so the return
 * value is under `result`.
 */
async function simulateAccount(
  client: AztecClient,
  wallet: unknown,
  caller: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const { Contract } = await import("@aztec/aztec.js/contracts");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const slc = (client as unknown as {
    spendingLimitContract: { getContractArtifact: () => Promise<unknown> };
  }).spendingLimitContract;

  const c = await (
    Contract as unknown as {
      at: (a: unknown, art: unknown, w: unknown) => Promise<{
        methods: Record<
          string,
          (...a: unknown[]) => {
            simulate: (o: { from: unknown; fee?: unknown }) => Promise<unknown>;
          }
        >;
      }>;
    }
  ).at(
    AztecAddress.fromStringUnsafe(client.getAddress()!),
    await slc.getContractArtifact(),
    wallet,
  );

  // Headroom on a simulation too. A view pays nothing, but the node validates
  // maxFeesPerGas against the live base fee before it runs anything, so a
  // default point prediction made before an earlier deploy moved the fee fails
  // here exactly as a send does.
  const out = await c.methods[method]!(...args).simulate({
    from: AztecAddress.fromStringUnsafe(caller),
    fee: await feeWithHeadroom(wallet),
  });
  return (out as { result?: unknown })?.result ?? out;
}

/**
 * Calls `method` on the spending-limit account as `caller` and reports how the
 * network settled it: "success", or the revert reason.
 *
 * Reported rather than thrown because a rejection is the expected result for
 * most of these calls and the reason is the substance of the claim. A public
 * assert can surface either as a throw from the simulation send() runs before
 * proving, or as a reverted receipt if it reaches a block. Which of the two
 * happens is a property of the SDK, not of the contract, so both are collapsed
 * into the same string.
 */
async function callAccount(
  client: AztecClient,
  account: string,
  wallet: unknown,
  caller: string,
  method: string,
  args: unknown[],
): Promise<string> {
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
          (...a: unknown[]) => {
            send: (o: { from: unknown; fee: unknown; wait: unknown }) => Promise<{
              receipt: { status: string; executionResult?: string; error?: string };
            }>;
          }
        >;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(account), artifact, wallet);

  try {
    const { receipt } = await c.methods[method]!(...args).send({
      from: AztecAddress.fromStringUnsafe(caller),
      fee: await feeWithHeadroom(wallet),
      // Without this a revert throws, which would discard the reason that
      // distinguishes the caller check from the timelock.
      wait: { dontThrowOnRevert: true, timeout: 180 },
    });
    if (receipt.error) return `${receipt.executionResult}: ${receipt.error}`;
    return receipt.executionResult ?? receipt.status;
  } catch (err) {
    return (err as Error).message;
  }
}

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
      allowlistTree: () => Promise<import("../../src/allowlist-tree.js").AllowlistTree>;
    };
  };
  const wallet = inner.wallet;
  const from = inner.solverAddress;

  // Nothing is pushed in before the send any more. The entrypoint derives the
  // declared amount, the recipient AND the membership witness from the payload
  // it signs. All this needs is for the tree to exist, so the witness lookup
  // resolves against the allowlist as it stands now, which is the state this
  // test is about to invalidate.
  await inner.spendingLimitContract.allowlistTree();

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

/**
 * Revoke a recipient by replacing its leaf with a freshly salted empty.
 *
 * There is no remove_recipient any more. Addition, removal and substitution are
 * one call, because the contract cannot tell them apart: a leaf is a
 * commitment, so h(0, salt) and h(recipient, salt) are the same shape. The
 * admin supplies the old leaf and a path, the contract verifies both against
 * the current root and recomputes.
 *
 * The replacement salt is arbitrary here. In production it comes from the
 * operator's seed so the tree stays reconstructible; this test only needs the
 * root to move.
 */
async function revokeRecipient(
  wallet: unknown,
  client: AztecClient,
  account: string,
  recipient: string,
  admin: string,
): Promise<void> {
  const { Contract } = await import("@aztec/aztec.js/contracts");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const { Fr } = await import("@aztec/foundation/curves/bn254");
  const { allowlistLeaf } = await import("../../src/allowlist-tree.js");

  const slc = (client as unknown as {
    spendingLimitContract: {
      getContractArtifact: () => Promise<unknown>;
      allowlistTree: () => Promise<
        import("../../src/allowlist-tree.js").AllowlistTree
      >;
    };
  }).spendingLimitContract;

  const tree = await slc.allowlistTree();
  const witness = tree.witnessFor(recipient);
  if (witness === undefined) {
    throw new Error(`cannot revoke ${recipient}: it is not in the configured allowlist`);
  }
  const oldLeaf = await allowlistLeaf(Fr.fromString(recipient), witness.leafSalt);
  // A distinct salt, so the new empty is not recognisable as one. A literal
  // zero leaf is rejected by the contract for exactly that reason.
  const newLeaf = await allowlistLeaf(Fr.ZERO, new Fr(0x9abcn));

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
  await c.methods["update_recipient"]!(
    witness.leafIndex,
    oldLeaf,
    newLeaf,
    witness.siblingPath,
  ).send({
    from: AztecAddress.fromStringUnsafe(admin),
    fee: await feeWithHeadroom(wallet),
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
  ).simulate({
    from: AztecAddress.fromStringUnsafe(owner),
    fee: await feeWithHeadroom(wallet),
  });
  const value = (bal as { result?: unknown })?.result ?? bal;
  return typeof value === "bigint" ? value : BigInt(String(value));
}
