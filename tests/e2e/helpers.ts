import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BridgedFeeJuiceClaim,
  BroadcastGate,
  FeeJuiceClaim,
  PreparedTransaction,
} from "../../src/types.js";
import { FeeJuiceClaimSchema } from "../../src/types.js";
import {
  bridgeFeeJuice,
  topUpFeeJuice,
  type ClaimingWallet,
  type PendingFeeJuiceDeposit,
} from "../../src/fee-juice.js";
import { headroomGasSettings } from "../../src/aztec-client.js";
import { payoutEvidence } from "../../src/partial-note.js";
import { MAX_NOTE_HASHES_PER_TX } from "@aztec-labs/constants";
import { FunctionSelector } from "@aztec-labs/aztec.js/abi";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { L1TokenManager } from "@aztec-labs/aztec.js/ethereum";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { createLogger } from "@aztec-labs/aztec.js/log";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { Tx, TxHash } from "@aztec-labs/aztec.js/tx";
import { createExtendedL1Client } from "@aztec-labs/ethereum/client";
import { TokenContract } from "@aztec-labs/noir-contracts.js/Token";
import { BlockHash } from "@aztec-labs/stdlib/block";

export interface E2EConfig {
  nodeUrl: string;
  secretKey: string;
  bridgePort: number;
  feeJuiceClaim?: FeeJuiceClaim;
}

// Test-only key well under BN254 Fr modulus -- never use with real funds
const DEFAULT_SECRET_KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";

/**
 * The account that mints tokens and pays for other accounts' fee juice.
 *
 * Distinct from the bridge key so the two accounts do not collide, and shared
 * between global-setup and the spending-limit suite so the second one to
 * connect recovers the account rather than deploying a second funder.
 */
export const FUNDER_KEY = "0x000000000000000000000000000000000000000000000000000000000000cafe";

/** One resolution for the node URL, shared by getTestConfig and the fee helper. */
export function resolveNodeUrl(): string {
  return process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
}

/**
 * A fresh wallet data directory for one AztecClient.
 *
 * Every client in the suite runs in one process (singleFork), and two
 * EmbeddedWallets on one LMDB directory break each other once either is
 * garbage-collected (`mdb_txn_begin: 22`, xochi-fi/xochi#513). AztecClient
 * refuses a second client on a directory it already holds, so each client here
 * gets its own, under the OS temp directory rather than the checkout.
 */
export function walletDataDirectory(label: string): { dataDirectory: string } {
  return { dataDirectory: mkdtempSync(join(tmpdir(), `pxe-bridge-e2e-${label}-`)) };
}

/**
 * Registers the published contract at `address` with `wallet`, so it can
 * simulate and decode calls to it.
 *
 * A wallet's PXE knows only what was registered with it, and `Contract.at`
 * registers nothing. While every client shared one store, whichever wallet
 * deployed a contract had registered it for all of them; with a directory per
 * wallet each one that calls a contract it did not deploy has to register it.
 */
export async function registerPublished(
  wallet: unknown,
  address: string,
  artifact: unknown,
): Promise<void> {
  const { createAztecNodeClient } = await import("@aztec-labs/aztec.js/node");
  const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses");
  const instance = await createAztecNodeClient(resolveNodeUrl()).getContract(
    AztecAddress.fromStringUnsafe(address),
  );
  if (!instance) throw new Error(`${address} is not published on the node`);
  await (wallet as {
    registerContract: (i: unknown, a: unknown) => Promise<unknown>;
  }).registerContract(instance, artifact);
}

export function getTestConfig(): E2EConfig {
  let feeJuiceClaim: FeeJuiceClaim | undefined;
  const raw = process.env["FEE_JUICE_CLAIM"];
  if (raw) {
    const parsed = FeeJuiceClaimSchema.safeParse(JSON.parse(raw));
    if (parsed.success) feeJuiceClaim = parsed.data;
  }

  return {
    nodeUrl: resolveNodeUrl(),
    secretKey: process.env["PXE_BRIDGE_SECRET_KEY"] ?? DEFAULT_SECRET_KEY,
    bridgePort: 0, // let OS pick
    // Spread rather than assign: exactOptionalPropertyTypes distinguishes an
    // absent key from one set to undefined, and E2EConfig declares it optional.
    ...(feeJuiceClaim ? { feeJuiceClaim } : {}),
  };
}

/**
 * The token global-setup provisioned, or a failure explaining why there is not
 * one.
 *
 * Throwing rather than skipping is the point. Both note suites used to guard on
 * `it.skipIf(!process.env.E2E_TOKEN_ADDRESS)` against a variable that was set
 * nowhere in the repo, so the default createNote path never executed and CI
 * stayed green over it for the whole life of the branch. A skip is invisible in
 * a passing run; a throw is not.
 */
export function requireTestToken(): string {
  const token = process.env["E2E_TOKEN_ADDRESS"];
  if (token) return token;

  const reason = process.env["E2E_TOKEN_SETUP_ERROR"];
  throw new Error(
    reason
      ? `global-setup could not provision a test token: ${reason}`
      : "E2E_TOKEN_ADDRESS is unset and global-setup recorded no failure, so " +
        "provisioning did not run or did not reach this process",
  );
}

/**
 * A broadcast gate for driving AztecClient directly: records every prepared
 * transaction it is shown, then permits the broadcast, or throws `refuse`.
 */
export function recordingGate(refuse?: Error): BroadcastGate & { seen: PreparedTransaction[] } {
  const seen: PreparedTransaction[] = [];
  return {
    seen,
    async beforeBroadcast(tx) {
      seen.push(tx);
      if (refuse) throw refuse;
    },
    beforeSend() {},
  };
}

export async function waitForNode(url: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  const statusUrl = url.replace(/\/$/, "") + "/status";

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(statusUrl);
      if (res.ok) return;
    } catch {
      // node not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Aztec node at ${url} did not become ready within ${timeoutMs}ms`);
}

/**
 * The `fee` option every e2e send should use: sponsored payment plus the same
 * predicted-fee headroom the deploy path applies.
 *
 * Sends here took the SDK's default gas settings, which are a point prediction.
 * `rejects apply_limits from a non-admin` deploys an account of its own and
 * then sends against an estimate made before that deployment moved the base
 * fee, so it failed validation with "maxFeesPerGas.feePerL2Gas must be greater
 * than or equal to gasFees.feePerL2Gas". Intermittent, and the last open flake
 * on the branch. The deploy path already solved this; the sends never got it.
 *
 * Sends only. Simulations want `gasWithHeadroom` instead.
 */
export async function feeWithHeadroom(wallet: unknown): Promise<{
  paymentMethod: import("@aztec-labs/aztec.js/fee").FeePaymentMethod;
  gasSettings: Awaited<ReturnType<typeof headroomGasSettings>>;
}> {
  return {
    paymentMethod: await sponsoredFee(wallet),
    gasSettings: await headroomGasSettings(resolveNodeUrl()),
  };
}

/**
 * The `fee` option every e2e simulate() should use: the same headroom, and no
 * payment method.
 *
 * Simulations need the headroom for the reason sends do. The node validates
 * maxFeesPerGas against the live base fee before it executes anything, so a
 * default point prediction made before an earlier deploy moved the fee fails a
 * view exactly as it fails a send. `balanceOf` went down that way at 45909093
 * against 73600000 on 2026-09-02, after 20 of the suite's 21 tests had passed.
 *
 * What they must not take is the payment method. It contributes a call of its
 * own, BaseWallet merges it into the same payload the interaction builds, and
 * the simulated batch then returns values for a call set the caller is not
 * expecting: five of these tests failed with "Not enough return values" when
 * `feeWithHeadroom` was used here. On the spending-limit account it is worse
 * than confusing, since the entrypoint admits exactly one call and a second one
 * is what `PREEXISTING_FEE_JUICE` exists to avoid.
 */
export async function gasWithHeadroom(): Promise<{
  gasSettings: Awaited<ReturnType<typeof headroomGasSettings>>;
}> {
  return { gasSettings: await headroomGasSettings(resolveNodeUrl()) };
}

/**
 * SponsoredFPC payment method, so a test account with no fee juice can still
 * send transactions. The bridge uses the same mechanism for its own account
 * deployment; without it every send() fails with "Not enough balance for fee
 * payer to pay for transaction".
 */
export async function sponsoredFee(
  wallet: unknown,
): Promise<import("@aztec-labs/aztec.js/fee").FeePaymentMethod> {
  const { SponsoredFPCContract } = await import("@aztec-labs/noir-contracts.js/SponsoredFPC");
  const { SponsoredFeePaymentMethod } = await import("@aztec-labs/aztec.js/fee/testing");
  const { getContractInstanceFromInstantiationParams } = await import("@aztec-labs/stdlib/contract");
  const { Fr } = await import("@aztec-labs/aztec.js/fields");

  const instance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await (wallet as {
    registerContract: (i: unknown, a: unknown) => Promise<unknown>;
  }).registerContract(instance, SponsoredFPCContract.artifact);
  return new SponsoredFeePaymentMethod(instance.address);
}

// Anvil's first default account. docker-compose starts anvil with the stock
// mnemonic, so this key is funded on L1 and is test-only by construction.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const L1_RPC = process.env["L1_RPC_URL"] ?? "http://localhost:8545";

// An idle sandbox may not build a block on its own, so every wait here drives
// one instead of sleeping. Twelve is plenty for a healthy node and keeps a
// broken one failing in minutes rather than in the beforeAll timeout.
const SANDBOX_WAIT_ATTEMPTS = 12;

/**
 * Drives real L2 transactions until every block already proposed at entry is
 * visible through the sandbox's finalized tip. Each callback transaction
 * advances Anvil and gives the sequencer/archiver a completed request
 * boundary; no wall-clock sleep or proven/latest substitution is involved.
 */
export async function advanceFinalizedTip(
  nodeUrl: string,
  onBlockNeeded: () => Promise<void>,
  attempts = SANDBOX_WAIT_ATTEMPTS,
): Promise<void> {
  const node = createAztecNodeClient(nodeUrl);
  let [tips, worldState] = await Promise.all([
    node.getChainTips(),
    node.getWorldStateSyncStatus(),
  ]);
  const minimumBlock = Number(tips.proposed.number);
  if (minimumBlock === 0) {
    throw new Error("cannot advance finalized L2 history before the sandbox has proposed a block");
  }
  for (let attempt = 0; attempt <= attempts; attempt++) {
    if (
      Number(tips.finalized.block.number) >= minimumBlock &&
      Number(worldState.finalizedBlockNumber) >= minimumBlock &&
      worldState.treesAreSynched
    ) {
      return;
    }
    if (attempt === attempts) break;
    await onBlockNeeded();
    [tips, worldState] = await Promise.all([
      node.getChainTips(),
      node.getWorldStateSyncStatus(),
    ]);
  }
  throw new Error(
    `finalized L2 tip did not reach ${minimumBlock} after ${attempts} driven blocks: ` +
      `proposed=${tips.proposed.number}, proven=${tips.proven.block.number}, ` +
      `finalized=${tips.finalized.block.number}, ` +
      `worldFinalized=${worldState.finalizedBlockNumber}, treesSynced=${worldState.treesAreSynched}`,
  );
}

/**
 * The sandbox advances its L1 clock by one Aztec slot for each driven block,
 * which can outrun host wall time during a proof-heavy test. Chain integration
 * tests anchor their injected trusted clock to the exact finalized block;
 * readiness unit tests separately enforce the 300-second production skew cap.
 */
export async function finalizedTimestampMs(nodeUrl: string): Promise<number> {
  const node = createAztecNodeClient(nodeUrl);
  const tip = (await node.getChainTips()).finalized.block;
  const block = await node.getBlockData({
    number: tip.number,
    hash: BlockHash.fromString(tip.hash),
  });
  if (!block) {
    throw new Error(`finalized block ${tip.number}/${tip.hash} is unavailable`);
  }
  return Number(block.header.globalVariables.timestamp) * 1_000;
}

/**
 * Gives `recipient` a fee juice balance, bridging from L1 and then claiming on
 * its behalf from `wallet`.
 *
 * The mechanism and the reason it has to work this way live in
 * `src/fee-juice.ts`, which the bridge's own top-up script also uses. What is
 * specific here is the sandbox: Anvil's key funds the L1 side by minting from
 * the faucet, blocks are driven rather than waited for, and the payer pays via
 * SponsoredFPC because a sandbox account has no fee juice until somebody
 * bridges it some.
 */
export async function fundFeeJuice(
  nodeUrl: string,
  wallet: unknown,
  payer: string,
  recipient: string,
  amount: bigint,
  onBlockNeeded: () => Promise<void>,
): Promise<void> {
  await topUpFeeJuice({
    nodeUrl,
    l1RpcUrl: L1_RPC,
    l1PrivateKey: ANVIL_KEY,
    recipient,
    amount,
    mint: true,
    onBlockNeeded,
    attempts: SANDBOX_WAIT_ATTEMPTS,
    wallet: wallet as ClaimingWallet,
    payer,
    paymentMethod: await sponsoredFee(wallet),
  });
}

/**
 * Bridges fee juice from L1 to `recipient` and returns the claim unconsumed,
 * for an account that pays its own deployment with it.
 */
export async function bridgeFeeJuiceClaim(
  nodeUrl: string,
  recipient: string,
  amount: bigint,
  onBlockNeeded: () => Promise<void>,
): Promise<FeeJuiceClaim> {
  return bridgeFeeJuice({
    nodeUrl,
    l1RpcUrl: L1_RPC,
    l1PrivateKey: ANVIL_KEY,
    recipient,
    amount,
    mint: true,
    onBlockNeeded,
    attempts: SANDBOX_WAIT_ATTEMPTS,
  });
}

/**
 * Bridges fee juice from L1 to `recipient` and returns the claim UNCONSUMED,
 * synced into the L2 tree so it is spendable. What `npm run bridge-fee-juice`
 * hands an operator, for a test that passes it to the bridge rather than
 * claiming it here. `messageHash` is the leaf the L1 Inbox reported.
 */
export async function bridgeClaim(
  nodeUrl: string,
  recipient: string,
  amount: bigint,
  onBlockNeeded: () => Promise<void>,
): Promise<BridgedFeeJuiceClaim> {
  let bridged: BridgedFeeJuiceClaim | undefined;
  await bridgeFeeJuice({
    nodeUrl,
    l1RpcUrl: L1_RPC,
    l1PrivateKey: ANVIL_KEY,
    recipient,
    amount,
    mint: true,
    onBlockNeeded,
    attempts: SANDBOX_WAIT_ATTEMPTS,
    onClaim: (claim) => {
      bridged = claim;
    },
  });
  if (!bridged) throw new Error("bridgeFeeJuice returned without reporting its claim");
  return bridged;
}

/**
 * Credits `recipient` with 1 wei of fee juice. The faucet mints one fixed
 * amount, so it mints to the L1 key first and the bridge then takes 1 wei of
 * that balance.
 */
export async function fundFeeJuiceDust(
  nodeUrl: string,
  wallet: unknown,
  payer: string,
  recipient: string,
  onBlockNeeded: () => Promise<void>,
): Promise<void> {
  const { feeJuiceAddress, feeAssetHandlerAddress } = (
    await createAztecNodeClient(nodeUrl).getNodeInfo()
  ).l1ContractAddresses;
  const l1Client = createExtendedL1Client([L1_RPC], ANVIL_KEY);
  await new L1TokenManager(
    feeJuiceAddress,
    feeAssetHandlerAddress,
    l1Client,
    createLogger("e2e:fee-juice"),
  ).mint(l1Client.account.address);
  await topUpFeeJuice({
    nodeUrl,
    l1RpcUrl: L1_RPC,
    l1PrivateKey: ANVIL_KEY,
    recipient,
    amount: 1n,
    onBlockNeeded,
    attempts: SANDBOX_WAIT_ATTEMPTS,
    wallet: wallet as ClaimingWallet,
    payer,
    paymentMethod: await sponsoredFee(wallet),
  });
}

/**
 * Bridges fee juice to `recipient` and returns only what `onSecret` recorded:
 * a run that died after broadcasting, before the receipt was read.
 */
export async function bridgeLosingReceipt(
  nodeUrl: string,
  recipient: string,
  amount: bigint,
  onBlockNeeded: () => Promise<void>,
): Promise<PendingFeeJuiceDeposit> {
  let pending: PendingFeeJuiceDeposit | undefined;
  await bridgeFeeJuice({
    nodeUrl,
    l1RpcUrl: L1_RPC,
    l1PrivateKey: ANVIL_KEY,
    recipient,
    amount,
    mint: true,
    onBlockNeeded,
    attempts: SANDBOX_WAIT_ATTEMPTS,
    onSecret: (deposit) => {
      pending = deposit;
    },
  });
  if (!pending) throw new Error("bridgeFeeJuice returned without reporting its secret");
  return pending;
}

/**
 * Sends one cheap transaction, so the sequencer builds an L2 block. Mints are
 * the cheapest thing the funder is already able to do.
 */
export async function mintOne(
  wallet: unknown,
  token: string,
  minter: string,
): Promise<void> {
  const { TokenContract } = await import("@aztec-labs/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses");
  const minterAddress = AztecAddress.fromStringUnsafe(minter);
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

  await contract.methods["mint_to_public"]!(minterAddress, 1n).send({
    from: minterAddress,
    fee: await feeWithHeadroom(wallet),
  });
}

/**
 * Mints `amount` of `token` into `to`'s PUBLIC balance.
 *
 * Public and not private, deliberately. transfer_to_private moves the sender's
 * public balance into a private note for the recipient, so the sending account
 * has to be funded publicly. Minting to private leaves the public balance at
 * zero and the transfer fails inside the token with "attempt to subtract with
 * overflow".
 */
export async function mintTo(
  wallet: unknown,
  token: string,
  to: string,
  amount: bigint,
  minter: string,
): Promise<void> {
  const { TokenContract } = await import("@aztec-labs/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses");
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

  await contract.methods["mint_to_public"]!(
    AztecAddress.fromStringUnsafe(to),
    amount,
  ).send({
    from: AztecAddress.fromStringUnsafe(minter),
    fee: await feeWithHeadroom(wallet),
  });
}

/**
 * Deploys an 18-decimal test token with `admin` as its minter.
 *
 * The SDK (since v5.1.0) requires an explicit `from` on send(), and send() resolves to
 * { contract, instance, receipt } after waiting -- not to the contract itself.
 * Both mismatches went unnoticed while this helper had no caller, which is what
 * E2E_TOKEN_ADDRESS being set nowhere used to mean.
 */
export async function deployTestToken(wallet: unknown, admin: string): Promise<string> {
  const { TokenContract } = await import("@aztec-labs/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses");
  const adminAddress = AztecAddress.fromStringUnsafe(admin);

  const { contract } = await (
    TokenContract as unknown as {
      deploy: (
        wallet: unknown,
        admin: unknown,
        name: string,
        symbol: string,
        decimals: number,
      ) => {
        send: (o: { from: unknown; fee: unknown }) => Promise<{
          contract: { address: { toString: () => string } };
        }>;
      };
    }
  )
    .deploy(wallet, adminAddress, "TestToken", "TST", 18)
    .send({ from: adminAddress, fee: await feeWithHeadroom(wallet) });

  return contract.address.toString();
}

/** What a mined payout shows, recomputed from its terms and randomness alone. */
export interface PayoutProof {
  /** C, read from the proven bytes' `_finalize_transfer_to_private_unsafe` call. */
  commitmentFromBytes: string | undefined;
  /** P2([recipient, randomness], DOM_SEP__PARTIAL_NOTE_COMMITMENT). */
  partialCommitment: string;
  /** i < 64 for which the recomputed unique note hash is in the effect, if any. */
  noteHashIndex: number | undefined;
  uniqueNoteHash: string | undefined;
  noteHashes: string[];
  siloedValidityNullifier: string;
  nullifiers: string[];
  completionLogTag: string;
  /** The token's public log tagged with the completion tag, after the tag. */
  completionLogFields: string[] | undefined;
}

/**
 * Recomputes the payout of `amount` of `token` to `recipient` from the
 * partial-note randomness (the relation Riddler checks) and reads the mined
 * transaction's own effect from the node to compare. With `txBytes`, also
 * reads C from the proven transaction the bridge journaled.
 */
export async function proveMinedPayout(
  nodeUrl: string,
  input: {
    txHash: string;
    token: string;
    recipient: string;
    payoutAccount: string;
    amount: bigint;
    partialNoteRandomness: string;
    txBytes?: Buffer;
  },
): Promise<PayoutProof> {
  const token = AztecAddress.fromStringUnsafe(input.token);
  const evidence = await payoutEvidence({
    token,
    recipient: AztecAddress.fromStringUnsafe(input.recipient),
    payoutAccount: AztecAddress.fromStringUnsafe(input.payoutAccount),
    amount: input.amount,
    randomness: Fr.fromString(input.partialNoteRandomness),
  });

  let commitmentFromBytes: string | undefined;
  if (input.txBytes) {
    const finalize = TokenContract.artifact.nonDispatchPublicFunctions.find(
      (f) => f.name === "_finalize_transfer_to_private_unsafe",
    )!;
    const selector = await FunctionSelector.fromNameAndParameters(finalize.name, finalize.parameters);
    const calls = Tx.fromBuffer(input.txBytes)
      .getPublicCallRequestsWithCalldata()
      .filter((c) => c.request.contractAddress.equals(token) && c.functionSelector.equals(selector));
    commitmentFromBytes = calls.length === 1 ? calls[0]!.args[2]?.toString() : undefined;
  }

  const receipt = await createAztecNodeClient(nodeUrl).getTxReceipt(TxHash.fromString(input.txHash), {
    includeTxEffect: true,
  });
  const effect = receipt.txEffect;
  if (!effect) throw new Error(`no tx effect for ${input.txHash}`);
  const noteHashes = effect.noteHashes.map((h) => h.toString());
  const nullifiers = effect.nullifiers.map((n) => n.toString());
  let noteHashIndex: number | undefined;
  let uniqueNoteHash: string | undefined;
  for (let i = 0; i < MAX_NOTE_HASHES_PER_TX && nullifiers[0] !== undefined; i += 1) {
    const candidate = (await evidence.uniqueNoteHash(Fr.fromString(nullifiers[0]), i)).toString();
    if (noteHashes.includes(candidate)) {
      noteHashIndex = i;
      uniqueNoteHash = candidate;
      break;
    }
  }
  const completionLog = effect.publicLogs.find(
    (log) => log.contractAddress.equals(token) && log.fields[0]?.equals(evidence.completionLogTag),
  );
  return {
    commitmentFromBytes,
    partialCommitment: evidence.partialCommitment.toString(),
    noteHashIndex,
    uniqueNoteHash,
    noteHashes,
    siloedValidityNullifier: evidence.siloedValidityNullifier.toString(),
    nullifiers,
    completionLogTag: evidence.completionLogTag.toString(),
    completionLogFields: completionLog?.fields.slice(1).map((f) => f.toBigInt().toString()),
  };
}
