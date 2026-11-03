import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OxideDepositJournal } from "../src/oxide/deposit-journal.js";
import {
  storeVerifiedOxideDeposit,
  type OxideDepositPxe,
} from "../src/oxide/deposit-store.js";
import {
  OXIDE_DEPOSIT_CHAIN_ID,
  OXIDE_DEPOSIT_DAI,
  OXIDE_DEPOSIT_OXDAI,
  OXIDE_DEPOSIT_PER_TX_CAP,
  OXIDE_DEPOSIT_NOTE_MAX,
  OXIDE_DEPOSIT_PORTAL,
  OXIDE_DEPOSIT_ROLLUP_VERSION,
  OXIDE_DEPOSIT_SENDER,
  OXIDE_PORTAL_ABI,
  oxideRecipientCommitment,
  prepareOxideDeposit,
  oxideDepositMessageKey,
  verifyOxideDeposit,
  type OxideDepositBlock,
  type OxideDepositChain,
  type OxideDepositReceipt,
  type OxideDepositLog,
  type OxideDepositTransaction,
  type OxidePortalState,
  type VerifiedOxideDeposit,
} from "../src/oxide/deposit.js";

const SALT = new Fr(0x1234n);
const TX_HASH = `0x${"aa".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"bb".repeat(32)}` as Hex;
const AMOUNT = 25n * 10n ** 18n;
const INBOX_INDEX = 73n;
const OTHER_PORTAL = getAddress("0x1111111111111111111111111111111111111111");
const tempDirs: string[] = [];

const TEST_JOURNAL_IDENTITY = {
  walletDataDirectory: "/test/oxide-wallet",
  sendJournalId: "send-journal",
  account: OXIDE_DEPOSIT_SENDER,
  token: OXIDE_DEPOSIT_OXDAI,
  deployment: "oxide-mainnet-v6:test",
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0))
    rmSync(path, { recursive: true, force: true });
});

interface FixtureState {
  chainId: number;
  receipt: OxideDepositReceipt;
  transaction: OxideDepositTransaction;
  finalized: OxideDepositBlock;
  canonical: OxideDepositBlock;
  portal: OxidePortalState;
}

async function receiptFixture(
  amount = AMOUNT,
  salt = SALT,
): Promise<{ chain: OxideDepositChain; state: FixtureState }> {
  const commitment = await oxideRecipientCommitment(salt);
  const messageKey = oxideDepositMessageKey(commitment, amount, INBOX_INDEX);
  const log = depositLog(commitment, amount, messageKey);
  const state: FixtureState = {
    chainId: OXIDE_DEPOSIT_CHAIN_ID,
    receipt: {
      status: "success",
      transactionHash: TX_HASH,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      to: OXIDE_DEPOSIT_PORTAL,
      logs: [log],
    },
    transaction: {
      hash: TX_HASH,
      to: OXIDE_DEPOSIT_PORTAL,
      input: encodeFunctionData({
        abi: OXIDE_PORTAL_ABI,
        functionName: "deposit",
        args: [commitment, amount],
      }),
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
    },
    finalized: {
      number: 101n,
      hash: `0x${"cc".repeat(32)}`,
      timestamp: 1_800_000_100n,
    },
    canonical: { number: 100n, hash: BLOCK_HASH, timestamp: 1_800_000_000n },
    portal: {
      underlying: OXIDE_DEPOSIT_DAI,
      l2Token: OXIDE_DEPOSIT_OXDAI,
      rollupVersion: OXIDE_DEPOSIT_ROLLUP_VERSION,
      txAmountCap: OXIDE_DEPOSIT_NOTE_MAX,
      depositMessageIndex: INBOX_INDEX + 1n,
    },
  };
  return {
    state,
    chain: {
      chainId: async () => state.chainId,
      receipt: async () => state.receipt,
      transaction: async () => state.transaction,
      finalizedBlock: async () => state.finalized,
      block: async () => state.canonical,
      portalState: async () => state.portal,
    },
  };
}

function depositLog(
  commitment: Hex,
  amount: bigint,
  messageKey: Hex,
  logIndex = 4,
  address: Address = OXIDE_DEPOSIT_PORTAL,
): OxideDepositLog {
  return {
    address,
    topics: encodeEventTopics({
      abi: OXIDE_PORTAL_ABI,
      eventName: "Deposit",
      args: { recipientCommitment: commitment },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      parseAbiParameters("uint256 amount, bytes32 key, uint256 index"),
      [amount, messageKey, INBOX_INDEX],
    ),
    logIndex,
  };
}

function tempJournal(): OxideDepositJournal {
  const directory = mkdtempSync(join(tmpdir(), "oxide-deposit-test-"));
  tempDirs.push(directory);
  const journalDirectory = join(directory, "journal");
  const hwmDirectory = join(directory, "hwm");
  mkdirSync(journalDirectory, { mode: 0o700 });
  mkdirSync(hwmDirectory, { mode: 0o700 });
  return openTestJournal(join(journalDirectory, "deposits.sqlite"), true);
}

function openTestJournal(
  path: string,
  allowCreate = false,
): OxideDepositJournal {
  const root = join(path, "..", "..");
  return OxideDepositJournal.open(path, {
    allowCreate,
    hwmPath: join(root, "hwm", "deposits.hwm"),
    identity: TEST_JOURNAL_IDENTITY,
    now: () => 123_000,
  });
}

function fakePxe(): OxideDepositPxe & { calls: number } {
  return {
    calls: 0,
    messageReady: async () => true,
    storeDeposit: async function () {
      this.calls += 1;
    },
    sendJournalMeta: () => ({ journalId: "send-journal", generation: 7 }),
  };
}

async function verifiedFixture(): Promise<VerifiedOxideDeposit> {
  const { chain } = await receiptFixture();
  return verifyOxideDeposit(chain, TX_HASH, SALT);
}

describe("oxide-deposit CLI", () => {
  it("reads the salt from a file descriptor and never prints it", () => {
    const directory = mkdtempSync(join(tmpdir(), "oxide-deposit-cli-"));
    tempDirs.push(directory);
    const saltPath = join(directory, "salt");
    const salt = `0x${"00".repeat(31)}01`;
    writeFileSync(saltPath, salt, { mode: 0o600 });
    const fd = openSync(saltPath, "r");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/oxide/deposit-cli.ts",
        "prepare",
        "--amount-dai",
        "25",
        "--salt-fd",
        "3",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", fd],
      },
    );
    closeSync(fd);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(salt);
    expect(JSON.parse(result.stdout)).toMatchObject({
      chainId: 1,
      amount: AMOUNT.toString(),
      sender: OXIDE_DEPOSIT_SENDER,
    });
  }, 60_000);

  it("refuses a raw bridge private key before any L1 request", () => {
    const directory = mkdtempSync(join(tmpdir(), "oxide-deposit-cli-"));
    tempDirs.push(directory);
    for (const child of ["wallet", "journal", "hwm"]) {
      mkdirSync(join(directory, child), { mode: 0o700 });
    }
    const saltPath = join(directory, "salt");
    writeFileSync(saltPath, `0x${"00".repeat(31)}01`, { mode: 0o600 });
    const fd = openSync(saltPath, "r");
    const rawKey = "11".repeat(32);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/oxide/deposit-cli.ts",
        "store",
        "--tx-hash",
        TX_HASH,
        "--salt-fd",
        "3",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", fd],
        env: {
          ...process.env,
          AZTEC_NODE_URL: "http://127.0.0.1:1",
          PXE_BRIDGE_ACCOUNT_ADDRESS: OXIDE_DEPOSIT_SENDER,
          PXE_BRIDGE_OXIDE_DEPOSIT_HWM: join(directory, "hwm", "deposit.hwm"),
          PXE_BRIDGE_OXIDE_DEPOSIT_JOURNAL: join(
            directory,
            "journal",
            "deposit.sqlite",
          ),
          PXE_BRIDGE_OXIDE_JOURNAL: join(directory, "journal", "send.sqlite"),
          PXE_BRIDGE_OXIDE_L1_RPC_URL: "http://127.0.0.1:1",
          PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT: join(directory, "artifact.json"),
          PXE_BRIDGE_SECRET_ARN:
            "arn:aws:secretsmanager:us-east-1:000000000000:secret:test",
          PXE_BRIDGE_SECRET_KEY: rawKey,
          PXE_BRIDGE_WALLET_DATA_DIRECTORY: join(directory, "wallet"),
        },
      },
    );
    closeSync(fd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PXE_BRIDGE_SECRET_KEY is refused");
    expect(result.stderr).not.toContain(rawKey);
  }, 60_000);
});

describe("Oxide deposit receipt verification", () => {
  it("prepares canonical external approval and deposit calldata without the salt", async () => {
    const plan = await prepareOxideDeposit(AMOUNT, SALT);
    expect(plan.portal).toBe(OXIDE_DEPOSIT_PORTAL);
    expect(plan.underlying).toBe(OXIDE_DEPOSIT_DAI);
    expect(plan.sender).not.toContain(SALT.toString());
    expect(JSON.stringify(plan)).not.toContain(SALT.toString());
    expect(plan.amount).toBe(AMOUNT.toString());
  });

  it("refuses the wrong chain", async () => {
    const { chain, state } = await receiptFixture();
    state.chainId = 8453;
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "wrong L1 chain",
    );
  });

  it("refuses RPC evidence returned for another transaction hash", async () => {
    const { chain, state } = await receiptFixture();
    state.receipt = {
      ...state.receipt,
      transactionHash: `0x${"12".repeat(32)}`,
    };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "different hash",
    );
  });

  it("refuses the wrong portal", async () => {
    const { chain, state } = await receiptFixture();
    state.receipt = { ...state.receipt, to: OTHER_PORTAL };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "wrong receipt portal",
    );
  });

  it("refuses noncanonical trailing calldata", async () => {
    const { chain, state } = await receiptFixture();
    state.transaction = {
      ...state.transaction,
      input: `${state.transaction.input}00` as Hex,
    };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "canonical OxidePortal.deposit encoding",
    );
  });

  it("refuses a commitment for a different private sender salt", async () => {
    const { chain } = await receiptFixture(AMOUNT, new Fr(0x9876n));
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "approved Oxide sender",
    );
  });

  it.each([
    [
      "underlying",
      getAddress("0x2222222222222222222222222222222222222222"),
      "wrong portal underlying token",
    ],
    ["l2Token", `0x${"33".repeat(32)}` as Hex, "wrong portal L2 token"],
  ] as const)(
    "refuses the wrong %s token identity",
    async (field, value, message) => {
      const { chain, state } = await receiptFixture();
      state.portal = { ...state.portal, [field]: value };
      await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
        message,
      );
    },
  );

  it("refuses a failed receipt", async () => {
    const { chain, state } = await receiptFixture();
    state.receipt = { ...state.receipt, status: "reverted" };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "reverted",
    );
  });

  it("refuses an unfinalized receipt", async () => {
    const { chain, state } = await receiptFixture();
    state.finalized = { ...state.finalized, number: 99n };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "not finalized",
    );
  });

  it("refuses an ambiguous noncanonical receipt", async () => {
    const { chain, state } = await receiptFixture();
    state.canonical = { ...state.canonical, hash: `0x${"dd".repeat(32)}` };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "ambiguous",
    );
  });

  it("refuses multiple Deposit events", async () => {
    const { chain, state } = await receiptFixture();
    state.receipt = {
      ...state.receipt,
      logs: [...state.receipt.logs, { ...state.receipt.logs[0]!, logIndex: 5 }],
    };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "expected one Deposit event",
    );
  });

  it("refuses a message-key alias for the same inbox index", async () => {
    const { chain, state } = await receiptFixture();
    const commitment = await oxideRecipientCommitment(SALT);
    const alias = `0x${"45".repeat(32)}` as Hex;
    state.receipt = {
      ...state.receipt,
      logs: [depositLog(commitment, AMOUNT, alias)],
    };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "canonical L1-to-L2 message",
    );
  });

  it("refuses an event inbox index that is not the portal's index", async () => {
    const { chain, state } = await receiptFixture();
    state.portal = { ...state.portal, depositMessageIndex: INBOX_INDEX + 2n };
    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "inbox index",
    );
  });

  it("accepts the pinned 5,166 DAI portal cap for a 25 DAI deposit", async () => {
    const { chain } = await receiptFixture();

    await expect(
      verifyOxideDeposit(chain, TX_HASH, SALT),
    ).resolves.toMatchObject({
      amount: AMOUNT,
    });
  });

  it.each([
    ["the operating deposit cap", OXIDE_DEPOSIT_PER_TX_CAP],
    ["one unit above the pinned note maximum", OXIDE_DEPOSIT_NOTE_MAX + 1n],
  ])("refuses a portal cap at %s", async (_case, txAmountCap) => {
    const { chain, state } = await receiptFixture();
    state.portal = { ...state.portal, txAmountCap };

    await expect(verifyOxideDeposit(chain, TX_HASH, SALT)).rejects.toThrow(
      "wrong portal transaction cap",
    );
  });

  it("accepts a deposit at the 1,000 DAI operating cap", async () => {
    const { chain } = await receiptFixture(OXIDE_DEPOSIT_PER_TX_CAP);

    await expect(
      prepareOxideDeposit(OXIDE_DEPOSIT_PER_TX_CAP, SALT),
    ).resolves.toMatchObject({ amount: OXIDE_DEPOSIT_PER_TX_CAP.toString() });
    await expect(
      verifyOxideDeposit(chain, TX_HASH, SALT),
    ).resolves.toMatchObject({
      amount: OXIDE_DEPOSIT_PER_TX_CAP,
    });
  });

  it("refuses a deposit above 1,000 DAI before accepting portal state", async () => {
    const over = OXIDE_DEPOSIT_PER_TX_CAP + 1n;
    const { chain } = await receiptFixture(over);
    const portalState = vi.fn(chain.portalState);

    await expect(
      verifyOxideDeposit({ ...chain, portalState }, TX_HASH, SALT),
    ).rejects.toThrow("per-transaction cap");
    expect(portalState).not.toHaveBeenCalled();
    await expect(prepareOxideDeposit(over, SALT)).rejects.toThrow(
      "per-transaction cap",
    );
  });
});

describe("Oxide deposit store journal", () => {
  it("does not invoke PXE twice for a duplicate", async () => {
    const journal = tempJournal();
    const deposit = await verifiedFixture();
    const pxe = fakePxe();
    expect(await storeVerifiedOxideDeposit(journal, pxe, deposit)).toBe(
      "stored",
    );
    expect(await storeVerifiedOxideDeposit(journal, pxe, deposit)).toBe(
      "already_stored",
    );
    expect(pxe.calls).toBe(1);
    journal.close();
  });

  it("retries safely after a crash before the submitting marker", async () => {
    const journal = tempJournal();
    const deposit = await verifiedFixture();
    const pxe = fakePxe();
    await expect(
      storeVerifiedOxideDeposit(journal, pxe, deposit, {
        afterVerified: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(journal.get(deposit.txHash)?.state).toBe("verified");
    expect(await storeVerifiedOxideDeposit(journal, pxe, deposit)).toBe(
      "stored",
    );
    expect(pxe.calls).toBe(1);
    journal.close();
  });

  it("fails closed after a crash between the marker and PXE submission", async () => {
    const journal = tempJournal();
    const deposit = await verifiedFixture();
    const pxe = fakePxe();
    await expect(
      storeVerifiedOxideDeposit(journal, pxe, deposit, {
        afterSubmittingMarked: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    const path = journal.path;
    journal.close();
    const replayJournal = openTestJournal(path);
    const replayPxe = fakePxe();
    await expect(
      storeVerifiedOxideDeposit(replayJournal, replayPxe, deposit),
    ).rejects.toThrow("prevents a second store");
    expect(pxe.calls).toBe(0);
    expect(replayPxe.calls).toBe(0);
    replayJournal.close();
  });

  it("fails closed after a crash after PXE submission without submitting twice", async () => {
    const journal = tempJournal();
    const deposit = await verifiedFixture();
    const pxe = fakePxe();
    await expect(
      storeVerifiedOxideDeposit(journal, pxe, deposit, {
        afterPxeSubmission: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(journal.get(deposit.txHash)?.state).toBe("submitting");
    const path = journal.path;
    journal.close();
    const replayJournal = openTestJournal(path);
    const replayPxe = fakePxe();
    await expect(
      storeVerifiedOxideDeposit(replayJournal, replayPxe, deposit),
    ).rejects.toThrow("prevents a second store");
    expect(pxe.calls).toBe(1);
    expect(replayPxe.calls).toBe(0);
    replayJournal.close();
  });

  it("fails closed when an ambiguous submission cannot be reconciled", async () => {
    const journal = tempJournal();
    const deposit = await verifiedFixture();
    const pxe = fakePxe();
    pxe.storeDeposit = async function () {
      this.calls += 1;
      throw new Error("connection lost");
    };
    await expect(
      storeVerifiedOxideDeposit(journal, pxe, deposit),
    ).rejects.toThrow("outcome is ambiguous");
    await expect(
      storeVerifiedOxideDeposit(journal, pxe, deposit),
    ).rejects.toThrow("prevents a second store");
    expect(pxe.calls).toBe(1);
    journal.close();
  });

  it("enforces the rolling 24h cap across finalized deposits", async () => {
    const journal = tempJournal();
    const base = await verifiedFixture();
    for (let i = 0; i < 10; i += 1) {
      const txHash = `0x${i.toString(16).padStart(64, "0")}` as Hex;
      const messageKey = `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex;
      const inboxIndex = base.inboxIndex + BigInt(i);
      journal.recordVerified({
        ...base,
        txHash,
        eventId: `${txHash}:${base.logIndex}:${messageKey}:${inboxIndex}`,
        inboxIndex,
        messageKey,
        amount: OXIDE_DEPOSIT_PER_TX_CAP,
      });
    }
    expect(() => {
      const txHash = `0x${"ff".repeat(32)}` as Hex;
      const messageKey = `0x${"ee".repeat(32)}` as Hex;
      journal.recordVerified({
        ...base,
        txHash,
        eventId: `${txHash}:${base.logIndex}:${messageKey}:${base.inboxIndex}`,
        messageKey,
        amount: 1n,
      });
    }).toThrow("rolling 24h cap");
    journal.close();
  });

  it("detects a database rollback against the separate high-water mark", async () => {
    const journal = tempJournal();
    const backup = `${journal.path}.old`;
    copyFileSync(journal.path, backup);
    journal.recordVerified(await verifiedFixture());
    const path = journal.path;
    journal.close();
    copyFileSync(backup, path);
    expect(() => openTestJournal(path)).toThrow("rollback detected");
  });
});
