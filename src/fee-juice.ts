/**
 * Fee juice for an account that cannot claim for itself.
 *
 * The spending-limit account's entrypoint admits exactly one call and requires
 * it to be `transfer_to_private` on the pinned token, which rules out every way
 * an Aztec account normally acquires fee juice:
 *
 *   - `FeeJuice.claim` is not that call, so the account cannot claim directly.
 *   - `FeeJuicePaymentMethodWithClaim` and `SponsoredFeePaymentMethod` each
 *     contribute a call of their own, and the SDK merges it into the SAME
 *     AppPayload the entrypoint receives (`mergeExecutionPayloads`), so it
 *     arrives alongside the transfer and the guard rejects the transaction.
 *
 * `PREEXISTING_FEE_JUICE` is therefore the only fee branch this account can
 * use, and somebody else has to put a balance there. `claim(to, ...)` names its
 * beneficiary in an argument rather than taking `msg_sender`, so a third party
 * can consume the L1 to L2 message and credit the account. That is the whole
 * mechanism this module exists to drive.
 *
 * Every top-up starts on L1. FeeJuice has three functions -- `claim`,
 * `claim_and_end_setup`, `public_dispatch` -- and no transfer, so an existing
 * L2 balance cannot be moved between accounts.
 */

import { FeeJuiceContract } from "@aztec/noir-contracts.js/FeeJuice";
import type { FeePaymentMethod } from "@aztec/aztec.js/fee";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { FeeJuiceClaim } from "./types.js";

/** The wallet slice needed to send a claim. Matches what `Contract.at` takes. */
export type ClaimingWallet = Parameters<typeof FeeJuiceContract.at>[1];

/** Rounds of waiting for the L1 to L2 message before giving up. */
const DEFAULT_WAIT_ATTEMPTS = 60;

/** Gap between those rounds when the caller has no cheaper way to drive one. */
const DEFAULT_WAIT_INTERVAL_MS = 5_000;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** u128 on chain, in `_increase_public_balance` and in the message hash. */
const MAX_CLAIM_AMOUNT = 1n << 128n;

export interface BridgeFeeJuiceOptions {
  /** Aztec node the recipient lives on. */
  nodeUrl: string;
  l1RpcUrl: string;
  /** L1 key holding the Fee Juice ERC20 the portal will take. */
  l1PrivateKey: string;
  /**
   * L1 chain id. Left unset the SDK assumes Anvil, which is what
   * `docker-compose.yml` runs; against any other L1 viem refuses the write with
   * a chain mismatch rather than sending it to the wrong network.
   */
  l1ChainId?: number;
  /** L2 account to credit. */
  recipient: string;
  amount: bigint;
  /**
   * Run once per waiting round while the message is not yet in the tree. An
   * idle sandbox builds no blocks on its own, so the e2e suite passes a cheap
   * transaction; against a live sequencer the default sleep is enough.
   */
  onBlockNeeded?: () => Promise<void>;
  attempts?: number;
  log?: (message: string) => void;
}

export interface ClaimFeeJuiceOptions {
  wallet: ClaimingWallet;
  /** Account that sends the claim. Pays the fee unless `paymentMethod` is set. */
  payer: string;
  /** Account the claim credits. Must be the one the message names. */
  recipient: string;
  claim: FeeJuiceClaim;
  /**
   * Fee payment for the claim transaction itself. Omit so the payer pays from
   * its own fee juice balance, which is the only thing a real network offers.
   */
  paymentMethod?: FeePaymentMethod;
  log?: (message: string) => void;
}

export interface TopUpFeeJuiceOptions extends BridgeFeeJuiceOptions {
  wallet: ClaimingWallet;
  payer: string;
  paymentMethod?: FeePaymentMethod;
}

/**
 * A 32-byte hex Aztec address, checked rather than assumed.
 *
 * `AztecAddress.fromStringUnsafe` takes whatever it is given, the bridged
 * message commits to the recipient it was built with, and FeeJuice has no
 * transfer. Juice bridged to a mistyped address is therefore recoverable by
 * nobody, which is why this runs before the L1 write rather than after it.
 */
export function assertAztecAddress(name: string, value: string): void {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new Error(`${name} must be a 32-byte hex Aztec address, got ${JSON.stringify(value)}`);
  }
}

/**
 * Bounds the bridged amount.
 *
 * Zero costs an L1 transaction and credits nothing. Above u128 the portal and
 * the contract disagree about the value, and the disagreement surfaces as a
 * message hash that no claim can match.
 */
export function assertBridgeAmount(amount: bigint): void {
  if (amount <= 0n) {
    throw new Error(`amount must be positive, got ${amount}`);
  }
  if (amount >= MAX_CLAIM_AMOUNT) {
    throw new Error(`amount must be below 2^128, got ${amount}`);
  }
}

/**
 * The full path: bridge from L1, wait for the message, claim on the recipient's
 * behalf. Returns the claim it consumed, so a failure after the L1 write leaves
 * the operator something to retry the second half with.
 */
export async function topUpFeeJuice(opts: TopUpFeeJuiceOptions): Promise<FeeJuiceClaim> {
  assertAztecAddress("payer", opts.payer);

  const claim = await bridgeFeeJuice(opts);

  await claimFeeJuiceFor({
    wallet: opts.wallet,
    payer: opts.payer,
    recipient: opts.recipient,
    claim,
    ...(opts.paymentMethod ? { paymentMethod: opts.paymentMethod } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });

  return claim;
}

/** Bridges fee juice from L1 to `recipient` and returns the unclaimed claim. */
export async function bridgeFeeJuice(opts: BridgeFeeJuiceOptions): Promise<FeeJuiceClaim> {
  assertAztecAddress("recipient", opts.recipient);
  assertBridgeAmount(opts.amount);

  const log = opts.log ?? (() => {});

  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  const { L1FeeJuicePortalManager } = await import("@aztec/aztec.js/ethereum");
  const { createExtendedL1Client } = await import("@aztec/ethereum/client");
  const { createEthereumChain } = await import("@aztec/ethereum/chain");
  const { createLogger } = await import("@aztec/aztec.js/log");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");

  const node = createAztecNodeClient(opts.nodeUrl);
  // Undefined falls through to the SDK's own Anvil default, so the sandbox
  // needs no chain id and a real L1 cannot be reached without one.
  const chain =
    opts.l1ChainId === undefined
      ? undefined
      : createEthereumChain([opts.l1RpcUrl], opts.l1ChainId).chainInfo;
  const l1Client = createExtendedL1Client(
    [opts.l1RpcUrl],
    opts.l1PrivateKey as `0x${string}`,
    chain,
  );

  const manager = await L1FeeJuicePortalManager.new(
    node as Parameters<typeof L1FeeJuicePortalManager.new>[0],
    l1Client,
    createLogger("pxe-bridge:fee-juice"),
  );

  log(`Bridging ${opts.amount} fee juice to ${opts.recipient}`);
  const claim = await manager.bridgeTokensPublic(
    AztecAddress.fromStringUnsafe(opts.recipient),
    opts.amount,
    true,
  );

  // The message is only spendable once the sequencer has pulled it off L1 and
  // built it into the tree, which needs L2 blocks. Claiming earlier fails with
  // "No L1 to L2 message found for message hash".
  log("Waiting for the L1 to L2 message");
  await waitForL1ToL2Message(node, claim.messageHash, opts);

  return {
    claimAmount: claim.claimAmount.toString(),
    claimSecret: claim.claimSecret.toString(),
    messageLeafIndex: claim.messageLeafIndex.toString(),
  };
}

/**
 * Consumes `claim` and credits `recipient`, sent from `payer`.
 *
 * `payer` and `recipient` are deliberately independent: this is the only way an
 * account whose entrypoint refuses to make the call can end up with a balance.
 * The message commits to the recipient, so naming any other account here fails
 * the lookup rather than crediting the wrong one.
 */
export async function claimFeeJuiceFor(opts: ClaimFeeJuiceOptions): Promise<void> {
  assertAztecAddress("payer", opts.payer);
  assertAztecAddress("recipient", opts.recipient);

  const log = opts.log ?? (() => {});

  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const { ProtocolContractAddress } = await import("@aztec/protocol-contracts");
  const { Fr } = await import("@aztec/aztec.js/fields");

  const feeJuice = await FeeJuiceContract.at(ProtocolContractAddress.FeeJuice, opts.wallet);

  log(`Claiming ${opts.claim.claimAmount} for ${opts.recipient} from ${opts.payer}`);
  await feeJuice.methods
    .claim(
      AztecAddress.fromStringUnsafe(opts.recipient),
      BigInt(opts.claim.claimAmount),
      Fr.fromString(opts.claim.claimSecret),
      new Fr(BigInt(opts.claim.messageLeafIndex)),
    )
    .send({
      from: AztecAddress.fromStringUnsafe(opts.payer),
      // No payment method means PREEXISTING_FEE_JUICE, i.e. the payer's own
      // balance. `claim`, not `claim_and_end_setup`: the juice being claimed is
      // the recipient's and cannot pay for this transaction.
      ...(opts.paymentMethod ? { fee: { paymentMethod: opts.paymentMethod } } : {}),
    });
}

async function waitForL1ToL2Message(
  node: Pick<AztecNode, "getL1ToL2MessageMembershipWitness">,
  messageHash: string,
  opts: Pick<BridgeFeeJuiceOptions, "onBlockNeeded" | "attempts">,
): Promise<void> {
  const { Fr } = await import("@aztec/aztec.js/fields");
  const message = Fr.fromString(messageHash);
  const attempts = opts.attempts ?? DEFAULT_WAIT_ATTEMPTS;
  const advance =
    opts.onBlockNeeded ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_WAIT_INTERVAL_MS)));

  for (let i = 0; i < attempts; i++) {
    const witness = await node.getL1ToL2MessageMembershipWitness("latest", message);
    if (witness !== undefined) return;
    await advance();
  }

  throw new Error(`L1 to L2 message ${messageHash} was not synced after ${attempts} rounds`);
}
