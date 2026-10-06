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

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FeeJuiceContract } from "@aztec/noir-contracts.js/FeeJuice";
import type { FeePaymentMethod } from "@aztec/aztec.js/fee";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { BridgedFeeJuiceClaim, FeeJuiceClaim } from "./types.js";

/** The wallet slice needed to send a claim. Matches what `Contract.at` takes. */
export type ClaimingWallet = Parameters<typeof FeeJuiceContract.at>[1];

/** Rounds of waiting for the L1 to L2 message before giving up. */
const DEFAULT_WAIT_ATTEMPTS = 60;

/** Gap between those rounds when the caller has no cheaper way to drive one. */
const DEFAULT_WAIT_INTERVAL_MS = 5_000;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const FIELD_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const L1_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** u128 on chain, in `_increase_public_balance` and in the message hash. */
const MAX_CLAIM_AMOUNT = 1n << 128n;

/**
 * Floor on the deposit's gas-limit buffer, as in the SDK's portal manager: the
 * Inbox insert costs up to ~40k gas more when the leaf completes a subtree,
 * which a point-in-time estimate misses. A larger operator override wins.
 */
const INBOX_DEPOSIT_GAS_LIMIT_BUFFER_PERCENTAGE = 100;

/** Blocks per eth_getLogs call in recovery, under hosted RPCs' range caps. */
const RECOVERY_LOG_RANGE = 2_000n;

/**
 * A deposit as it stands before the L1 write: everything needed to find it on
 * L1 and rebuild its claim if the run dies before the receipt is read.
 * `l1FromBlock` is read before any L1 write, so the deposit lands at or after
 * it. `l1Sender` is the account that sends it, whose nonces tell a recovery
 * miss apart: still pending, or dropped.
 */
const PendingFeeJuiceDepositSchema = z.object({
  recipient: z.string().regex(ADDRESS_PATTERN),
  claimAmount: z.string().regex(/^[1-9]\d*$/),
  claimSecret: z.string().regex(FIELD_PATTERN),
  secretHash: z.string().regex(FIELD_PATTERN),
  l1FromBlock: z.string().regex(/^\d+$/),
  l1Sender: z.string().regex(L1_ADDRESS_PATTERN),
  // Added by recordBridgedClaim once the deposit has landed. Either both or
  // neither: a file with one is not a record either writer produced.
  messageLeafIndex: z.string().regex(/^\d+$/).optional(),
  messageHash: z.string().regex(FIELD_PATTERN).optional(),
}).refine((d) => (d.messageLeafIndex === undefined) === (d.messageHash === undefined), {
  message: "messageLeafIndex and messageHash go together",
  path: ["messageHash"],
});
export type PendingFeeJuiceDeposit = z.infer<typeof PendingFeeJuiceDepositSchema>;

/** File a script records `deposit` in: `dir`, named by the secret hash. */
export function pendingDepositPath(secretHash: string, dir: string = process.cwd()): string {
  return join(dir, `fee-juice-deposit-${secretHash.toLowerCase()}.json`);
}

/**
 * Writes `deposit` to `pendingDepositPath`: owner-only, flushed, never over an
 * existing file. Synchronous, for `onSecret`, so it completes before any L1
 * write and a signal handler cannot run until it has. Stdout alone is lost
 * with the terminal, and with it the secret a broadcast deposit needs.
 */
export function writePendingDeposit(deposit: PendingFeeJuiceDeposit, dir?: string): string {
  const path = pendingDepositPath(deposit.secretHash, dir);
  writeDepositFile(path, deposit);
  return path;
}

function writeDepositFile(path: string, deposit: PendingFeeJuiceDeposit): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(deposit, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Adds the landed deposit's claim to the file at `path`, which keeps it until
 * the claim is safe: synced (bridge-fee-juice) or sent (top-up-fee-juice).
 * Printing the claim is not enough, since a terminal is lost as easily as a
 * run. Written beside the file and renamed over it, so a crash leaves the old
 * record or the new one, never neither.
 */
export function recordBridgedClaim(path: string, claim: BridgedFeeJuiceClaim): void {
  const found = findPendingDeposit(path);
  if (!found) throw new Error(`Deposit file ${path} is missing`);
  const { deposit } = found;
  if (deposit.claimSecret !== claim.claimSecret || deposit.claimAmount !== claim.claimAmount) {
    throw new Error(`Deposit file ${path} records a different deposit than the claim`);
  }
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeDepositFile(tmp, { ...deposit, messageLeafIndex: claim.messageLeafIndex, messageHash: claim.messageHash });
  renameSync(tmp, path);
}

/** The claim a deposit file records once its deposit landed; undefined before. */
export function bridgedClaimOf(deposit: PendingFeeJuiceDeposit): BridgedFeeJuiceClaim | undefined {
  if (deposit.messageLeafIndex === undefined || deposit.messageHash === undefined) return undefined;
  return {
    claimAmount: deposit.claimAmount,
    claimSecret: deposit.claimSecret,
    messageLeafIndex: deposit.messageLeafIndex,
    messageHash: deposit.messageHash,
  };
}

/**
 * The deposit a `--recover` / `FEE_JUICE_RECOVER` value names: the path of a
 * file `writePendingDeposit` wrote, or a secret hash whose file is in `dir`.
 * Undefined for a hash with no file there, which leaves the secret to the env.
 */
export function findPendingDeposit(
  value: string,
  dir?: string,
): { path: string; deposit: PendingFeeJuiceDeposit } | undefined {
  const byHash = FIELD_PATTERN.test(value);
  const path = byHash ? pendingDepositPath(value, dir) : value;
  if (byHash && !existsSync(path)) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read deposit file ${path}: ${(err as Error).message}`);
  }
  const parsed = PendingFeeJuiceDepositSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Deposit file ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  if (byHash && parsed.data.secretHash.toLowerCase() !== value.toLowerCase()) {
    throw new Error(`Deposit file ${path} holds secret hash ${parsed.data.secretHash}, not ${value}`);
  }
  return { path, deposit: parsed.data };
}

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
   * Mint the bridged amount from the L1 faucet first. Sandbox only: the faucet
   * handler exists only on test deployments and mints one fixed amount, so the
   * SDK throws unless `amount` equals it. Off by default, which bridges from
   * the Fee Juice ERC20 balance `l1PrivateKey` already holds -- the only thing
   * a real network offers.
   */
  mint?: boolean;
  /**
   * Called with the claim secret before any L1 write. Until the deposit
   * receipt is read the secret exists nowhere else, so a run that dies after
   * broadcasting is recoverable only from what this records
   * (`recoverFeeJuiceClaim`).
   */
  onSecret?: (deposit: PendingFeeJuiceDeposit) => void;
  /**
   * Called once the L1 deposit has gone through, before the wait. The deposit
   * cannot be undone, and a wait that times out throws without returning the
   * claim, so this is where a caller records it.
   */
  onClaim?: (claim: BridgedFeeJuiceClaim) => void;
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

export interface RecoverFeeJuiceClaimOptions {
  nodeUrl: string;
  l1RpcUrl: string;
  /** Defaults to the L1 chain id the node reports. */
  l1ChainId?: number;
  recipient: string;
  amount: bigint;
  claimSecret: string;
  secretHash: string;
  /** First L1 block to scan, `l1FromBlock` as `onSecret` recorded it. */
  fromBlock: bigint;
  /**
   * `l1Sender` as `onSecret` recorded it. On a miss its nonces decide between
   * "still pending" and "dropped"; without it a miss cannot say which.
   */
  l1Sender?: string;
  log?: (message: string) => void;
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
 * behalf. Returns the claim it consumed. A failure after the L1 write reaches
 * the caller only through `onSecret` and `onClaim`.
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

/**
 * Bridges fee juice from L1 to `recipient`, waits for the message, and returns
 * the unclaimed claim. `onSecret` receives the claim secret before the L1
 * write, `onClaim` the claim before the wait.
 *
 * The deposit is sent here rather than through the SDK's
 * `L1FeeJuicePortalManager.bridgeTokensPublic`, which generates the secret
 * internally and returns it only with the receipt: a timeout, signal or crash
 * after broadcast lost it, and with it the deposit.
 */
export async function bridgeFeeJuice(opts: BridgeFeeJuiceOptions): Promise<FeeJuiceClaim> {
  assertAztecAddress("recipient", opts.recipient);
  assertBridgeAmount(opts.amount);

  const log = opts.log ?? (() => {});

  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  const { L1TokenManager, generateClaimSecret } = await import("@aztec/aztec.js/ethereum");
  const { createExtendedL1Client } = await import("@aztec/ethereum/client");
  const { createEthereumChain } = await import("@aztec/ethereum/chain");
  const { createL1TxUtils, getL1TxUtilsConfigEnvVars } = await import("@aztec/ethereum/l1-tx-utils");
  const { extractEvent } = await import("@aztec/ethereum/utils");
  const { FeeJuicePortalAbi } = await import("@aztec/l1-artifacts/FeeJuicePortalAbi");
  const { createLogger } = await import("@aztec/aztec.js/log");
  const { encodeFunctionData } = await import("viem");

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
  const logger = createLogger("pxe-bridge:fee-juice");

  const { feeJuiceAddress, feeJuicePortalAddress, feeAssetHandlerAddress } = (
    await node.getNodeInfo()
  ).l1ContractAddresses;
  if (feeJuiceAddress.isZero() || feeJuicePortalAddress.isZero()) {
    throw new Error("Fee Juice portal or token not deployed on L1");
  }
  const handler =
    feeAssetHandlerAddress && !feeAssetHandlerAddress.isZero() ? feeAssetHandlerAddress : undefined;
  const tokenManager = new L1TokenManager(feeJuiceAddress, handler, l1Client, logger);
  const portal = feeJuicePortalAddress.toString();

  if (opts.mint) {
    const mintAmount = await tokenManager.getMintAmount();
    if (opts.amount !== mintAmount) {
      throw new Error(`mint requires amount ${mintAmount}, the faucet's fixed mint, got ${opts.amount}`);
    }
  } else {
    // Checked here, before the approve, so a short balance fails with its cause
    // rather than as an L1 revert inside the portal deposit.
    const balance = await tokenManager.getL1TokenBalance(l1Client.account.address);
    if (balance < opts.amount) {
      throw new Error(
        `L1 account ${l1Client.account.address} holds ${balance} Fee Juice, ` +
          `needs ${opts.amount} to bridge`,
      );
    }
  }

  const [claimSecret, secretHash] = await generateClaimSecret();
  const pending: PendingFeeJuiceDeposit = {
    recipient: opts.recipient,
    claimAmount: opts.amount.toString(),
    claimSecret: claimSecret.toString(),
    secretHash: secretHash.toString(),
    l1FromBlock: (await l1Client.getBlockNumber()).toString(),
    l1Sender: l1Client.account.address,
  };
  opts.onSecret?.(pending);

  if (opts.mint) await tokenManager.mint(l1Client.account.address);

  log(`Bridging ${opts.amount} fee juice to ${opts.recipient}`);
  await tokenManager.approve(opts.amount, portal, "FeeJuice Portal");

  const args = [opts.recipient as `0x${string}`, opts.amount, pending.secretHash as `0x${string}`] as const;
  // Surfaces a revert reason before anything is broadcast.
  await l1Client.simulateContract({
    address: portal,
    abi: FeeJuicePortalAbi,
    functionName: "depositToAztecPublic",
    args,
    account: l1Client.account,
  });
  const txConfig = getL1TxUtilsConfigEnvVars();
  const { receipt } = await createL1TxUtils(l1Client, { logger }, txConfig).sendAndMonitorTransaction(
    {
      to: portal,
      abi: FeeJuicePortalAbi,
      data: encodeFunctionData({ abi: FeeJuicePortalAbi, functionName: "depositToAztecPublic", args }),
    },
    {
      gasLimitBufferPercentage: Math.max(
        txConfig.gasLimitBufferPercentage ?? 0,
        INBOX_DEPOSIT_GAS_LIMIT_BUFFER_PERCENTAGE,
      ),
    },
  );
  const event = extractEvent(
    receipt.logs,
    portal,
    FeeJuicePortalAbi,
    "DepositToAztecPublic",
    (e) => isDepositOf(e.args, pending),
    logger,
  );

  const bridged: BridgedFeeJuiceClaim = {
    claimAmount: pending.claimAmount,
    claimSecret: pending.claimSecret,
    messageLeafIndex: event.args.index.toString(),
    messageHash: event.args.key,
  };
  opts.onClaim?.(bridged);

  // The message is only spendable once the sequencer has pulled it off L1 and
  // built it into the tree, which needs L2 blocks. Claiming earlier fails with
  // "No L1 to L2 message found for message hash".
  log("Waiting for the L1 to L2 message");
  await waitForL1ToL2Message(node, bridged.messageHash, opts);

  return {
    claimAmount: bridged.claimAmount,
    claimSecret: bridged.claimSecret,
    messageLeafIndex: bridged.messageLeafIndex,
  };
}

/**
 * Whether a decoded `DepositToAztecPublic` is `deposit`. Hex compared without
 * case: the event decodes bytes32 lowercase, an operator-supplied recipient
 * need not be, and a false miss in recovery invites a second deposit.
 */
export function isDepositOf(
  args: { to?: string | undefined; amount?: bigint | undefined; secretHash?: string | undefined },
  deposit: Pick<PendingFeeJuiceDeposit, "recipient" | "claimAmount" | "secretHash">,
): boolean {
  return (
    args.to?.toLowerCase() === deposit.recipient.toLowerCase() &&
    args.amount === BigInt(deposit.claimAmount) &&
    args.secretHash?.toLowerCase() === deposit.secretHash.toLowerCase()
  );
}

/**
 * Rebuilds the claim for a `bridgeFeeJuice` deposit whose receipt never reached
 * the caller, from what `onSecret` recorded.
 *
 * Scans the portal's `DepositToAztecPublic` events to `recipient` from
 * `fromBlock`. `to` is the only indexed field, so the secret hash and amount
 * are matched here. Throws when nothing matches. With `l1Sender`, the error
 * says whether a transaction from it is still pending at this RPC, which can
 * land after a fresh bridge and deposit twice, or none is and bridging anew
 * is safe.
 */
export async function recoverFeeJuiceClaim(opts: RecoverFeeJuiceClaimOptions): Promise<BridgedFeeJuiceClaim> {
  assertAztecAddress("recipient", opts.recipient);
  assertBridgeAmount(opts.amount);
  if (!FIELD_PATTERN.test(opts.claimSecret)) {
    throw new Error("claim secret must be 32-byte hex");
  }
  if (!FIELD_PATTERN.test(opts.secretHash)) {
    throw new Error(`secret hash must be 32-byte hex, got ${JSON.stringify(opts.secretHash)}`);
  }
  if (opts.l1Sender !== undefined && !L1_ADDRESS_PATTERN.test(opts.l1Sender)) {
    throw new Error(`L1 sender must be a 20-byte hex address, got ${JSON.stringify(opts.l1Sender)}`);
  }

  const log = opts.log ?? (() => {});

  const { Fr } = await import("@aztec/aztec.js/fields");
  const { computeSecretHash } = await import("@aztec/stdlib/hash");

  // Checked before any lookup: a secret that does not produce this hash can
  // claim nothing the scan finds, and the scan would report "not mined".
  const computed = (await computeSecretHash(Fr.fromString(opts.claimSecret))).toString();
  if (computed.toLowerCase() !== opts.secretHash.toLowerCase()) {
    throw new Error(`claim secret hashes to ${computed}, not ${opts.secretHash}`);
  }

  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  const { getPublicClient } = await import("@aztec/ethereum/client");
  const { FeeJuicePortalAbi } = await import("@aztec/l1-artifacts/FeeJuicePortalAbi");

  const info = await createAztecNodeClient(opts.nodeUrl).getNodeInfo();
  const client = getPublicClient({
    l1RpcUrls: [opts.l1RpcUrl],
    l1ChainId: opts.l1ChainId ?? info.l1ChainId,
  });
  const portal = info.l1ContractAddresses.feeJuicePortalAddress.toString();
  const deposit = {
    recipient: opts.recipient,
    claimAmount: opts.amount.toString(),
    secretHash: opts.secretHash,
  };

  const scan = async (fromBlock: bigint, toBlock: bigint): Promise<BridgedFeeJuiceClaim | undefined> => {
    log(`Scanning L1 blocks ${fromBlock}..${toBlock} for the deposit`);
    for (let from = fromBlock; from <= toBlock; from += RECOVERY_LOG_RANGE) {
      const to = from + RECOVERY_LOG_RANGE - 1n < toBlock ? from + RECOVERY_LOG_RANGE - 1n : toBlock;
      const events = await client.getContractEvents({
        address: portal,
        abi: FeeJuicePortalAbi,
        eventName: "DepositToAztecPublic",
        args: { to: opts.recipient.toLowerCase() as `0x${string}` },
        fromBlock: from,
        toBlock: to,
      });
      const match = events.find((e) => isDepositOf(e.args, deposit));
      if (match?.args.index !== undefined && match.args.key !== undefined) {
        return {
          claimAmount: deposit.claimAmount,
          claimSecret: opts.claimSecret,
          messageLeafIndex: match.args.index.toString(),
          messageHash: match.args.key,
        };
      }
    }
    return undefined;
  };

  const missed = `No DepositToAztecPublic of ${opts.amount} to ${opts.recipient} with secret hash ${opts.secretHash}`;
  let latest = await client.getBlockNumber();
  const found = await scan(opts.fromBlock, latest);
  if (found) return found;

  if (opts.l1Sender === undefined) {
    throw new Error(
      `${missed} in L1 blocks ${opts.fromBlock}..${latest}. The deposit is not mined: ` +
        "never sent, or still pending. A pending one can still land, so recover again before " +
        "bridging anew.",
    );
  }

  const sender = opts.l1Sender as `0x${string}`;
  const [mined, pending] = await Promise.all([
    client.getTransactionCount({ address: sender, blockTag: "latest" }),
    client.getTransactionCount({ address: sender, blockTag: "pending" }),
  ]);
  // A deposit mined since the scan began counts in `mined` but lies past the
  // blocks scanned. Blocks up to a head read after the nonces cover it.
  const head = await client.getBlockNumber();
  const late = head > latest ? await scan(latest + 1n, head) : undefined;
  if (late) return late;
  latest = head;

  if (pending > mined) {
    throw new Error(
      `${missed} in L1 blocks ${opts.fromBlock}..${latest}, and ${pending - mined} transaction(s) ` +
        `from ${sender} are pending at this RPC. The deposit may be among them: recover again ` +
        "once they are mined. Bridging anew now can deposit twice.",
    );
  }
  throw new Error(
    `${missed} in L1 blocks ${opts.fromBlock}..${latest}, and no transaction from ${sender} is ` +
      "pending at this RPC: the deposit was never sent, or was dropped or replaced. Safe to " +
      "bridge anew.",
  );
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

/**
 * Resolves once `messageHash` is in the L1 to L2 message tree, i.e. once a
 * claim built from it can be consumed. Throws after `attempts` rounds.
 */
export async function waitForL1ToL2Message(
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
