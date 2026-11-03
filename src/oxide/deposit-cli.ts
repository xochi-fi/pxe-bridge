#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Wallet } from "@aztec-labs/aztec.js/wallet";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { parseUnits, type Hex } from "viem";
import { AztecClient, WALLET_DATA_DIRECTORY_ENV } from "../aztec-client.js";
import { resolveSecretKey } from "../secrets.js";
import {
  loadOxideTokenArtifact,
  registerOxideToken,
  storeOxideDeposit,
} from "./backend.js";
import { OxideDepositJournal } from "./deposit-journal.js";
import {
  storeVerifiedOxideDeposit,
  type OxideDepositPxe,
} from "./deposit-store.js";
import {
  OXIDE_DEPOSIT_SENDER,
  prepareOxideDeposit,
  verifyOxideDeposit,
  type VerifiedOxideDeposit,
} from "./deposit.js";
import { viemOxideDepositChain } from "./deposit-viem.js";
import { OxideJournal } from "./journal.js";
import { OXIDE_V6_MAINNET } from "./pins.js";

const USAGE = `usage:
  npm run oxide-deposit -- prepare --amount-dai <decimal> --salt-fd <fd>
  npm run oxide-deposit -- store --tx-hash <0x...> --salt-fd <fd> [--initialize-journal]

prepare prints DAI approve and OxidePortal.deposit calldata; it never signs or broadcasts.
store accepts only a finalized Ethereum receipt and never accepts a private key argument.`;

type Command =
  | { kind: "prepare"; amount: bigint; saltFd: number }
  | { kind: "store"; txHash: Hex; saltFd: number; initializeJournal: boolean };

function parseArgs(args: readonly string[]): Command {
  const [kind, ...rest] = args;
  if (kind !== "prepare" && kind !== "store") throw new Error(USAGE);
  let amount: bigint | undefined;
  let txHash: Hex | undefined;
  let saltFd: number | undefined;
  let initializeJournal = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--initialize-journal") {
      if (kind !== "store" || initializeJournal) throw new Error(USAGE);
      initializeJournal = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new Error(USAGE);
    if (arg === "--amount-dai" && kind === "prepare" && amount === undefined) {
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value))
        throw new Error(
          "--amount-dai must be a decimal with at most 18 places",
        );
      amount = parseUnits(value, 18);
    } else if (
      arg === "--tx-hash" &&
      kind === "store" &&
      txHash === undefined
    ) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(value))
        throw new Error("--tx-hash must be 32-byte hex");
      txHash = value.toLowerCase() as Hex;
    } else if (arg === "--salt-fd" && saltFd === undefined) {
      if (!/^[3-9]\d*$/.test(value))
        throw new Error("--salt-fd must name an already-open descriptor >= 3");
      saltFd = Number(value);
      if (!Number.isSafeInteger(saltFd))
        throw new Error("--salt-fd is too large");
    } else {
      throw new Error(USAGE);
    }
    i += 1;
  }
  if (saltFd === undefined)
    throw new Error(
      "--salt-fd is required; the shared salt is never accepted on argv or env",
    );
  if (kind === "prepare") {
    if (amount === undefined || txHash !== undefined || initializeJournal)
      throw new Error(USAGE);
    return { kind, amount, saltFd };
  }
  if (txHash === undefined || amount !== undefined) throw new Error(USAGE);
  return { kind, txHash, saltFd, initializeJournal };
}

function readSalt(fd: number): Fr {
  const raw = readFileSync(fd);
  const field = Buffer.alloc(32);
  try {
    let start = 0;
    let end = raw.length;
    while (start < end && isSpace(raw[start]!)) start += 1;
    while (end > start && isSpace(raw[end - 1]!)) end -= 1;
    if (
      end - start === 66 &&
      raw[start] === 0x30 &&
      (raw[start + 1] === 0x78 || raw[start + 1] === 0x58)
    ) {
      start += 2;
    }
    if (end - start !== 64)
      throw new Error(
        "salt FD must contain one 32-byte hexadecimal field element",
      );
    for (let i = 0; i < 32; i += 1) {
      const high = hexNibble(raw[start + i * 2]!);
      const low = hexNibble(raw[start + i * 2 + 1]!);
      if (high < 0 || low < 0)
        throw new Error(
          "salt FD must contain one 32-byte hexadecimal field element",
        );
      field[i] = high * 16 + low;
    }
    return Fr.fromBuffer(field);
  } finally {
    raw.fill(0);
    field.fill(0);
  }
}

function isSpace(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}

function hexNibble(value: number): number {
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return -1;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  const salt = readSalt(command.saltFd);
  if (command.kind === "prepare") {
    console.log(
      JSON.stringify(await prepareOxideDeposit(command.amount, salt), null, 2),
    );
    return;
  }

  const l1RpcUrl = requiredEnv("PXE_BRIDGE_OXIDE_L1_RPC_URL");
  const depositJournalPath = requiredEnv("PXE_BRIDGE_OXIDE_DEPOSIT_JOURNAL");
  const depositHwmInput = requiredEnv("PXE_BRIDGE_OXIDE_DEPOSIT_HWM");
  if (!isAbsolute(depositJournalPath) || !isAbsolute(depositHwmInput)) {
    throw new Error(
      "PXE_BRIDGE_OXIDE_DEPOSIT_JOURNAL and PXE_BRIDGE_OXIDE_DEPOSIT_HWM must be absolute paths",
    );
  }
  const depositHwmPath = join(
    realpathSync(dirname(depositHwmInput)),
    basename(depositHwmInput),
  );
  const sendJournalPath = requiredEnv("PXE_BRIDGE_OXIDE_JOURNAL");
  const nodeUrl = requiredEnv("AZTEC_NODE_URL");
  const artifactPath = requiredEnv("PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT");
  const walletDataDirectoryInput = requiredEnv(WALLET_DATA_DIRECTORY_ENV);
  if (!isAbsolute(walletDataDirectoryInput)) {
    throw new Error(`${WALLET_DATA_DIRECTORY_ENV} must be an absolute path`);
  }
  const walletDataDirectory = realpathSync(walletDataDirectoryInput);
  const accountAddress = requiredEnv(
    "PXE_BRIDGE_ACCOUNT_ADDRESS",
  ).toLowerCase();
  if (accountAddress !== OXIDE_DEPOSIT_SENDER) {
    throw new Error(
      `PXE_BRIDGE_ACCOUNT_ADDRESS must be the approved Oxide sender ${OXIDE_DEPOSIT_SENDER}`,
    );
  }
  if (process.env["PXE_BRIDGE_SECRET_KEY"] !== undefined) {
    throw new Error(
      "PXE_BRIDGE_SECRET_KEY is refused; store uses only PXE_BRIDGE_SECRET_ARN",
    );
  }
  requiredEnv("PXE_BRIDGE_SECRET_ARN");

  const verified = await verifyOxideDeposit(
    viemOxideDepositChain(l1RpcUrl),
    command.txHash,
    salt,
  );
  const sendJournalIdentity = {
    account: OXIDE_DEPOSIT_SENDER,
    token: OXIDE_V6_MAINNET.bridge.l2Token,
    deployment: `${OXIDE_V6_MAINNET.deploymentId}:${OXIDE_V6_MAINNET.gitSha}`,
  };
  const sendJournal = OxideJournal.open(sendJournalPath, {
    identity: sendJournalIdentity,
  });
  let depositJournal: OxideDepositJournal | undefined;
  try {
    const health = sendJournal.health();
    if (!health.writable)
      throw new Error(
        `Oxide send journal is not writable: ${health.reason}: ${health.detail}`,
      );
    const sendJournalMeta = sendJournal.meta();
    depositJournal = OxideDepositJournal.open(depositJournalPath, {
      allowCreate: command.initializeJournal,
      hwmPath: depositHwmPath,
      identity: {
        walletDataDirectory,
        sendJournalId: sendJournalMeta.journalId,
        ...sendJournalIdentity,
      },
    });
    const { key, source } = await resolveSecretKey();
    console.error(`[oxide-deposit] bridge account key loaded from ${source}`);
    const client = new AztecClient(
      nodeUrl,
      key,
      undefined,
      undefined,
      undefined,
      {
        expectedAccountAddress: OXIDE_DEPOSIT_SENDER,
        requireExistingAccount: true,
        allowSponsoredFpc: false,
        dataDirectory: walletDataDirectory,
      },
    );
    await client.connect();
    const { wallet: embedded, account, node } = client.oxideContext();
    if (account.toString().toLowerCase() !== OXIDE_DEPOSIT_SENDER) {
      throw new Error(
        `derived account is not the approved Oxide sender ${OXIDE_DEPOSIT_SENDER}`,
      );
    }
    const wallet = embedded as unknown as Wallet;
    const artifact = await loadOxideTokenArtifact(artifactPath);
    const token = await registerOxideToken(wallet, node, artifact);
    const pxe: OxideDepositPxe = {
      messageReady: async (messageKey, inboxIndex) => {
        const witness = await node.getL1ToL2MessageMembershipWitness(
          "latest",
          new Fr(BigInt(messageKey)),
        );
        return witness !== undefined && witness[0] === inboxIndex;
      },
      storeDeposit: (deposit: VerifiedOxideDeposit) =>
        storeOxideDeposit(token, {
          inboxIndex: deposit.inboxIndex,
          amount: deposit.amount,
          recipient: account,
          sharedSecretSalt: salt,
        }),
      sendJournalMeta: () => sendJournal.meta(),
    };
    const result = await storeVerifiedOxideDeposit(
      depositJournal,
      pxe,
      verified,
    );
    console.log(
      JSON.stringify({
        result,
        txHash: verified.txHash,
        eventId: verified.eventId,
        inboxIndex: verified.inboxIndex.toString(),
        amount: verified.amount.toString(),
      }),
    );
  } finally {
    depositJournal?.close();
    sendJournal.close();
  }
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`[oxide-deposit] ${message.split("\n", 1)[0]}`);
  process.exitCode = 1;
});
