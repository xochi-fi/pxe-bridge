#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr as AztecFr } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import type { Wallet } from "@aztec-labs/aztec.js/wallet";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { AztecAddress as StdlibAztecAddress } from "@aztec-labs/stdlib/aztec-address";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  http,
  keccak256,
  type Hex,
  type Transaction,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { AztecClient } from "../src/aztec-client.js";
import {
  isExactAlreadyStoredError,
  planOxideFunding,
  runOxideFunding,
  type FundingApprovalEvidence,
  type FundingDepositEvidence,
  type FundingIdentity,
  type FundingIdentityInput,
  type OxideFundingDependencies,
  type SignedFundingTransaction,
} from "../src/oxide/funding.js";
import { loadOxideTokenArtifact, registerOxideToken, storeOxideDeposit } from "../src/oxide/backend.js";
import { OXIDE_PORTAL_DEPOSIT_ABI, OXIDE_UNDERLYING_ABI } from "../src/oxide/portal-deposit.js";
import { computeRecipientCommitment } from "../src/oxide/vendor/oxide-lib-tee/recipient_commitment.js";

const USAGE =
  "Usage: fund-oxide --state <path> --chain-id <decimal> --portal <0x address> " +
  "--token <0x address> --recipient <0x field> --sender <0x address> --amount <base units> " +
  "[--dry-run] [--poll-attempts N] [--poll-interval-ms N] [--tx-timeout-ms N]";
const L1_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

interface CliValues {
  state: string;
  "chain-id": string;
  portal: string;
  token: string;
  recipient: string;
  sender: string;
  amount: string;
  "dry-run": boolean;
  "poll-attempts": string | undefined;
  "poll-interval-ms": string | undefined;
  "tx-timeout-ms": string | undefined;
  "l1-rpc-url": string | undefined;
  "aztec-node-url": string | undefined;
  "token-artifact": string | undefined;
  "wallet-data-dir": string | undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required. ${USAGE}`);
  return value;
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!POSITIVE_INTEGER.test(raw)) fail(`--${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`--${name} is too large`);
  return value;
}

function parseCli(): CliValues {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      options: {
        state: { type: "string" },
        "chain-id": { type: "string" },
        portal: { type: "string" },
        token: { type: "string" },
        recipient: { type: "string" },
        sender: { type: "string" },
        amount: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "poll-attempts": { type: "string" },
        "poll-interval-ms": { type: "string" },
        "tx-timeout-ms": { type: "string" },
        "l1-rpc-url": { type: "string" },
        "aztec-node-url": { type: "string" },
        "token-artifact": { type: "string" },
        "wallet-data-dir": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (cause) {
    throw new Error(USAGE, { cause });
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  return {
    state: required(values, "state"),
    "chain-id": required(values, "chain-id"),
    portal: required(values, "portal"),
    token: required(values, "token"),
    recipient: required(values, "recipient"),
    sender: required(values, "sender"),
    amount: required(values, "amount"),
    "dry-run": values["dry-run"] === true,
    "poll-attempts": typeof values["poll-attempts"] === "string" ? values["poll-attempts"] : undefined,
    "poll-interval-ms": typeof values["poll-interval-ms"] === "string" ? values["poll-interval-ms"] : undefined,
    "tx-timeout-ms": typeof values["tx-timeout-ms"] === "string" ? values["tx-timeout-ms"] : undefined,
    "l1-rpc-url": typeof values["l1-rpc-url"] === "string" ? values["l1-rpc-url"] : undefined,
    "aztec-node-url": typeof values["aztec-node-url"] === "string" ? values["aztec-node-url"] : undefined,
    "token-artifact": typeof values["token-artifact"] === "string" ? values["token-artifact"] : undefined,
    "wallet-data-dir": typeof values["wallet-data-dir"] === "string" ? values["wallet-data-dir"] : undefined,
  };
}

function identityFrom(values: CliValues): FundingIdentityInput {
  return {
    chainId: values["chain-id"],
    portal: values.portal,
    token: values.token,
    sender: values.sender,
    recipient: values.recipient,
    amount: values.amount,
  };
}

async function commitment(sharedSecretSalt: string, recipient: string): Promise<string> {
  return (await computeRecipientCommitment(Fr.fromHexString(sharedSecretSalt), StdlibAztecAddress.fromStringUnsafe(recipient))).toString();
}

function namedError(error: unknown, name: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.name === name) return true;
    current = current.cause;
  }
  return false;
}

function requireHexKey(name: string, value: string | undefined): Hex {
  if (!value || !L1_KEY.test(value)) fail(`${name} must be a 32-byte hex key`);
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

function requireUrl(name: string, value: string | undefined): string {
  if (!value) fail(`${name} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`${name} must be an http(s) URL`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(`${name} must be an http(s) URL`);
  return value;
}

async function createDependencies(
  values: CliValues,
  identity: FundingIdentityInput,
  expectedRecipient: string,
): Promise<OxideFundingDependencies> {
  const l1PrivateKey = requireHexKey("L1_PRIVATE_KEY", process.env["L1_PRIVATE_KEY"]);
  const bridgeSecretKey = requireHexKey("PXE_BRIDGE_SECRET_KEY", process.env["PXE_BRIDGE_SECRET_KEY"]);
  delete process.env["L1_PRIVATE_KEY"];
  delete process.env["PXE_BRIDGE_SECRET_KEY"];

  const account = privateKeyToAccount(l1PrivateKey);
  if (account.address.toLowerCase() !== identity.sender.toLowerCase()) {
    fail("L1_PRIVATE_KEY does not derive the required --sender");
  }
  const l1RpcUrl = requireUrl("--l1-rpc-url or PXE_BRIDGE_OXIDE_L1_RPC_URL", values["l1-rpc-url"] ?? process.env["PXE_BRIDGE_OXIDE_L1_RPC_URL"]);
  const aztecNodeUrl = requireUrl("--aztec-node-url or AZTEC_NODE_URL", values["aztec-node-url"] ?? process.env["AZTEC_NODE_URL"]);
  const tokenArtifact = values["token-artifact"] ?? process.env["PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT"];
  if (!tokenArtifact) fail("--token-artifact or PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT is required");
  const pollIntervalMs = positiveNumber("poll-interval-ms", values["poll-interval-ms"], 5_000);
  const txTimeoutMs = positiveNumber("tx-timeout-ms", values["tx-timeout-ms"], 120_000);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(l1RpcUrl) });
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(l1RpcUrl) });
  const portal = identity.portal as Hex;
  const token = identity.token as Hex;
  const sender = identity.sender as Hex;

  const signCall = async (to: Hex, data: Hex): Promise<SignedFundingTransaction> => {
    const request = await walletClient.prepareTransactionRequest({ account, chain: mainnet, to, data, value: 0n });
    const rawTransaction = await walletClient.signTransaction(request);
    return { hash: keccak256(rawTransaction), rawTransaction };
  };

  const transactionOrNull = async (hash: Hex): Promise<Transaction | null> => {
    try {
      return await publicClient.getTransaction({ hash });
    } catch (error) {
      if (namedError(error, "TransactionNotFoundError")) return null;
      throw error;
    }
  };

  const confirmRawTransaction = async (transaction: SignedFundingTransaction): Promise<{ tx: Transaction; receipt: TransactionReceipt }> => {
    const hash = transaction.hash as Hex;
    let known = await transactionOrNull(hash);
    if (known === null) {
      try {
        const sentHash = await publicClient.sendRawTransaction({ serializedTransaction: transaction.rawTransaction as Hex });
        if (sentHash.toLowerCase() !== hash.toLowerCase()) throw new Error("RPC returned another hash for recorded transaction");
      } catch (cause) {
        known = await transactionOrNull(hash);
        if (known === null) throw new Error(`Recorded transaction ${hash} could not be broadcast`, { cause });
      }
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: txTimeoutMs });
    if (receipt.status !== "success") throw new Error(`Recorded transaction ${hash} reverted`);
    const tx = known ?? await publicClient.getTransaction({ hash });
    return { tx, receipt };
  };

  const approvalEvidence = async (transaction: SignedFundingTransaction): Promise<FundingApprovalEvidence> => {
    const { tx } = await confirmRawTransaction(transaction);
    if (!tx.to) throw new Error("Approval transaction has no destination");
    const decoded = decodeFunctionData({ abi: OXIDE_UNDERLYING_ABI, data: tx.input });
    if (decoded.functionName !== "approve") throw new Error("Recorded approval transaction does not call approve");
    const [spender, amount] = decoded.args;
    return { transactionHash: tx.hash, from: tx.from, to: tx.to, spender, amount };
  };

  const depositEvidence = async (transaction: SignedFundingTransaction): Promise<FundingDepositEvidence> => {
    const { tx, receipt } = await confirmRawTransaction(transaction);
    if (!tx.to) throw new Error("Deposit transaction has no destination");
    const decoded = decodeFunctionData({ abi: OXIDE_PORTAL_DEPOSIT_ABI, data: tx.input });
    if (decoded.functionName !== "deposit") throw new Error("Recorded deposit transaction does not call deposit");
    const [recipientCommitment, requestedAmount] = decoded.args;
    const events = receipt.logs.flatMap((log) => {
      if (log.address.toLowerCase() !== portal.toLowerCase()) return [];
      try {
        const decodedLog = decodeEventLog({
          abi: OXIDE_PORTAL_DEPOSIT_ABI,
          eventName: "Deposit",
          topics: log.topics,
          data: log.data,
        });
        return [decodedLog.args];
      } catch (error) {
        if (namedError(error, "DecodeLogTopicsMismatch") || namedError(error, "AbiEventSignatureNotFoundError")) return [];
        throw error;
      }
    });
    if (events.length !== 1) throw new Error(`Deposit receipt has ${events.length} Oxide Deposit events, expected exactly one`);
    const event = events[0]!;
    return {
      transactionHash: tx.hash,
      from: tx.from,
      to: tx.to,
      recipientCommitment,
      requestedAmount,
      event: {
        recipientCommitment: event.recipientCommitment,
        creditedAmount: event.amount,
        key: event.key,
        index: event.index,
      },
    };
  };

  return {
    randomSalt: () => Fr.random().toString(),
    computeRecipientCommitment: commitment,
    deploymentFacts: async () => {
      const [chainId, underlying, l2Token, rollupVersion, txAmountCap, available, senderBalance, frozen] = await Promise.all([
        publicClient.getChainId().then(BigInt),
        publicClient.readContract({ address: portal, abi: OXIDE_PORTAL_DEPOSIT_ABI, functionName: "UNDERLYING" }),
        publicClient.readContract({ address: portal, abi: OXIDE_PORTAL_DEPOSIT_ABI, functionName: "L2_TOKEN" }),
        publicClient.readContract({ address: portal, abi: OXIDE_PORTAL_DEPOSIT_ABI, functionName: "ROLLUP_VERSION" }),
        publicClient.readContract({ address: portal, abi: OXIDE_PORTAL_DEPOSIT_ABI, functionName: "TX_AMOUNT_CAP" }),
        publicClient.readContract({ address: portal, abi: OXIDE_PORTAL_DEPOSIT_ABI, functionName: "getCurrentAvailable" }),
        publicClient.readContract({ address: token, abi: OXIDE_UNDERLYING_ABI, functionName: "balanceOf", args: [sender] }),
        publicClient.readContract({ address: portal, abi: OXIDE_PORTAL_DEPOSIT_ABI, functionName: "$frozen" }),
      ]);
      return { chainId, portal, token: underlying, l2Token, rollupVersion, txAmountCap, available, senderBalance, frozen };
    },
    prepareApproval: (fundingIdentity) => signCall(
      fundingIdentity.token as Hex,
      encodeFunctionData({
        abi: OXIDE_UNDERLYING_ABI,
        functionName: "approve",
        args: [fundingIdentity.portal as Hex, BigInt(fundingIdentity.amount)],
      }),
    ),
    confirmApproval: approvalEvidence,
    prepareDeposit: (fundingIdentity, recipientCommitment) => signCall(
      fundingIdentity.portal as Hex,
      encodeFunctionData({
        abi: OXIDE_PORTAL_DEPOSIT_ABI,
        functionName: "deposit",
        args: [recipientCommitment as Hex, BigInt(fundingIdentity.amount)],
      }),
    ),
    confirmDeposit: depositEvidence,
    messageReady: async (key) => {
      const witness = await createAztecNodeClient(aztecNodeUrl).getL1ToL2MessageMembershipWitness("latest", AztecFr.fromString(key));
      return witness !== undefined;
    },
    waitBeforeNextPoll: () => delay(pollIntervalMs),
    storeDeposit: async (deposit) => {
      const client = new AztecClient(aztecNodeUrl, bridgeSecretKey, undefined, undefined, undefined, {
        expectedAccountAddress: expectedRecipient,
        requireExistingAccount: true,
        allowSponsoredFpc: false,
        ...(values["wallet-data-dir"] ? { dataDirectory: values["wallet-data-dir"] } : {}),
      });
      await client.connect();
      const context = client.oxideContext();
      const artifact = await loadOxideTokenArtifact(tokenArtifact);
      const oxideToken = await registerOxideToken(context.wallet as unknown as Wallet, context.node, artifact);
      await storeOxideDeposit(oxideToken, {
        inboxIndex: deposit.inboxIndex,
        amount: deposit.amount,
        recipient: AztecAddress.fromStringUnsafe(deposit.recipient),
        sharedSecretSalt: AztecFr.fromString(deposit.sharedSecretSalt),
      });
    },
    isAlreadyStored: isExactAlreadyStoredError,
  };
}

async function main(): Promise<void> {
  const values = parseCli();
  const expectedRecipient = process.env["PXE_BRIDGE_ACCOUNT_ADDRESS"];
  if (!expectedRecipient) fail("PXE_BRIDGE_ACCOUNT_ADDRESS is required to pin --recipient");
  const identity = identityFrom(values);
  const pollAttempts = positiveNumber("poll-attempts", values["poll-attempts"], 1);

  if (values["dry-run"]) {
    const plan = await planOxideFunding(
      { statePath: values.state, identity, expectedRecipient },
      commitment,
    );
    console.log("Plan only: no state, approval, deposit, store, or network write was made.");
    console.log(`State: ${values.state} (${plan.phase})`);
    console.log(`Pinned route: chain ${plan.identity.chainId}, token ${plan.identity.token}, portal ${plan.identity.portal}`);
    console.log(`Pinned identities: L1 sender ${plan.identity.sender}, Aztec recipient ${plan.identity.recipient}`);
    console.log(`Amount: ${plan.identity.amount} base units`);
    console.log("Resume phases: prepared -> approved -> deposited -> message_ready -> stored");
    return;
  }

  const dependencies = await createDependencies(values, identity, expectedRecipient);
  const outcome = await runOxideFunding(
    { statePath: values.state, identity, expectedRecipient, pollAttempts, log: console.log },
    dependencies,
  );
  if (outcome.kind === "waiting") {
    console.log(`Message not ready. Rerun this exact command with state ${values.state}; never start a second deposit.`);
  } else {
    console.log(`Funding complete. Preserve ${values.state} as the durable deposit receipt.`);
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
