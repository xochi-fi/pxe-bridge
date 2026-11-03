import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOxideFundingState,
  isExactAlreadyStoredError,
  readOxideFundingState,
  runOxideFunding,
  type FundingIdentityInput,
  type OxideFundingDependencies,
  type OxideFundingState,
} from "../src/oxide/funding.js";
import { OXIDE_V6_MAINNET } from "../src/oxide/pins.js";

const RECIPIENT = `0x${"00".repeat(31)}11`;
const SENDER = "0x1111111111111111111111111111111111111111";
const SALT = `0x${"00".repeat(31)}22`;
const COMMITMENT = `0x${"00".repeat(31)}33`;
const OTHER_COMMITMENT = `0x${"00".repeat(31)}44`;
const APPROVAL_HASH = `0x${"aa".repeat(32)}`;
const DEPOSIT_HASH = `0x${"bb".repeat(32)}`;
const MESSAGE_KEY = `0x${"00".repeat(31)}55`;
const RAW_APPROVAL = "0x0102";
const RAW_DEPOSIT = "0x0304";

const IDENTITY: FundingIdentityInput = {
  chainId: "1",
  portal: OXIDE_V6_MAINNET.bridge.portal,
  token: OXIDE_V6_MAINNET.bridge.underlying,
  sender: SENDER,
  recipient: RECIPIENT,
  amount: "1000000000000000000",
};

interface FakeControls {
  ready: boolean;
  approvalError?: Error;
  depositError?: Error;
  storeError?: Error;
}

function fakeDependencies(controls: FakeControls = { ready: true }) {
  const calls = {
    deployment: 0,
    prepareApproval: 0,
    confirmApproval: 0,
    prepareDeposit: 0,
    confirmDeposit: 0,
    readiness: 0,
    store: 0,
  };
  const dependencies: OxideFundingDependencies = {
    randomSalt: () => SALT,
    computeRecipientCommitment: async (salt, recipient) =>
      salt.toLowerCase() === SALT && recipient.toLowerCase() === RECIPIENT ? COMMITMENT : OTHER_COMMITMENT,
    deploymentFacts: async () => {
      calls.deployment += 1;
      return {
        chainId: OXIDE_V6_MAINNET.l1ChainId,
        portal: OXIDE_V6_MAINNET.bridge.portal,
        token: OXIDE_V6_MAINNET.bridge.underlying,
        l2Token: OXIDE_V6_MAINNET.bridge.l2Token,
        rollupVersion: OXIDE_V6_MAINNET.rollupVersion,
        txAmountCap: OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount,
        available: OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount,
        senderBalance: OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount,
        frozen: false,
      };
    },
    prepareApproval: async () => {
      calls.prepareApproval += 1;
      return { hash: APPROVAL_HASH, rawTransaction: RAW_APPROVAL };
    },
    confirmApproval: async () => {
      calls.confirmApproval += 1;
      if (controls.approvalError) throw controls.approvalError;
      return {
        transactionHash: APPROVAL_HASH,
        from: SENDER,
        to: OXIDE_V6_MAINNET.bridge.underlying,
        spender: OXIDE_V6_MAINNET.bridge.portal,
        amount: BigInt(IDENTITY.amount),
      };
    },
    prepareDeposit: async () => {
      calls.prepareDeposit += 1;
      return { hash: DEPOSIT_HASH, rawTransaction: RAW_DEPOSIT };
    },
    confirmDeposit: async () => {
      calls.confirmDeposit += 1;
      if (controls.depositError) throw controls.depositError;
      return {
        transactionHash: DEPOSIT_HASH,
        from: SENDER,
        to: OXIDE_V6_MAINNET.bridge.portal,
        recipientCommitment: COMMITMENT,
        requestedAmount: BigInt(IDENTITY.amount),
        event: {
          recipientCommitment: COMMITMENT,
          creditedAmount: BigInt(IDENTITY.amount),
          key: MESSAGE_KEY,
          index: 17n,
        },
      };
    },
    messageReady: async () => {
      calls.readiness += 1;
      return controls.ready;
    },
    waitBeforeNextPoll: async () => {},
    storeDeposit: async () => {
      calls.store += 1;
      if (controls.storeError) throw controls.storeError;
    },
    isAlreadyStored: isExactAlreadyStoredError,
  };
  return { dependencies, calls };
}

function preparedState(): OxideFundingState {
  return {
    version: 1,
    phase: "prepared",
    identity: { ...IDENTITY },
    sharedSecretSalt: SALT,
    recipientCommitment: COMMITMENT,
  };
}

function options(statePath: string, log?: (message: string) => void) {
  return {
    statePath,
    identity: IDENTITY,
    expectedRecipient: RECIPIENT,
    ...(log ? { log } : {}),
  };
}

let directory: string;
let statePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "oxide-funding-"));
  statePath = join(directory, "funding.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("Oxide funding state", () => {
  it("creates an owner-only state atomically and never replaces an existing file", () => {
    createOxideFundingState(statePath, preparedState());
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(readOxideFundingState(statePath)).toEqual(preparedState());
    expect(readdirSync(directory)).toEqual(["funding.json"]);

    const changed = { ...preparedState(), recipientCommitment: OTHER_COMMITMENT };
    expect(() => createOxideFundingState(statePath, changed)).toThrow();
    expect(readOxideFundingState(statePath)).toEqual(preparedState());
    expect(readdirSync(directory)).toEqual(["funding.json"]);
  });

  it("refuses malformed identity and over-limit amount before state or transaction writes", async () => {
    const { dependencies, calls } = fakeDependencies();
    await expect(
      runOxideFunding(
        {
          ...options(statePath),
          identity: { ...IDENTITY, amount: (OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount + 1n).toString() },
        },
        dependencies,
      ),
    ).rejects.toThrow(/exceeds the shipped/);
    expect(calls).toMatchObject({ deployment: 0, prepareApproval: 0, prepareDeposit: 0 });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("refuses moving portal facts before preparing a transaction", async () => {
    const fake = fakeDependencies();
    fake.dependencies.deploymentFacts = async () => ({
      chainId: 2n,
      portal: OXIDE_V6_MAINNET.bridge.portal,
      token: OXIDE_V6_MAINNET.bridge.underlying,
      l2Token: OXIDE_V6_MAINNET.bridge.l2Token,
      rollupVersion: OXIDE_V6_MAINNET.rollupVersion,
      txAmountCap: OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount,
      available: 10n ** 30n,
      senderBalance: 10n ** 30n,
      frozen: false,
    });
    await expect(runOxideFunding(options(statePath), fake.dependencies)).rejects.toThrow(/moved to chain/);
    expect(fake.calls.prepareApproval).toBe(0);
    expect(readOxideFundingState(statePath).phase).toBe("prepared");
  });

  it("refuses permissive or tampered state before touching a dependency", async () => {
    createOxideFundingState(statePath, preparedState());
    chmodSync(statePath, 0o644);
    const fake = fakeDependencies();
    await expect(runOxideFunding(options(statePath), fake.dependencies)).rejects.toThrow(/mode 0600/);
    expect(fake.calls.deployment).toBe(0);

    chmodSync(statePath, 0o600);
    const json = JSON.parse(readFileSync(statePath, "utf8")) as OxideFundingState;
    writeFileSync(statePath, `${JSON.stringify({ ...json, recipientCommitment: OTHER_COMMITMENT })}\n`, { mode: 0o600 });
    await expect(runOxideFunding(options(statePath), fake.dependencies)).rejects.toThrow(/salt\/recipient commitment/);
    expect(fake.calls.deployment).toBe(0);
  });
});

describe("Oxide funding resume", () => {
  it("resumes the exact recorded approval after an interrupted confirmation", async () => {
    const controls: FakeControls = { ready: true, approvalError: new Error("approval receipt timeout") };
    const fake = fakeDependencies(controls);
    await expect(runOxideFunding(options(statePath), fake.dependencies)).rejects.toThrow("approval receipt timeout");
    expect(readOxideFundingState(statePath)).toMatchObject({
      phase: "prepared",
      approvalTransaction: { hash: APPROVAL_HASH, rawTransaction: RAW_APPROVAL },
    });

    delete controls.approvalError;
    const outcome = await runOxideFunding(options(statePath), fake.dependencies);
    expect(outcome.kind).toBe("stored");
    expect(fake.calls.prepareApproval).toBe(1);
    expect(fake.calls.confirmApproval).toBe(2);
  });

  it("recovers a submitted deposit receipt without preparing a second deposit", async () => {
    const controls: FakeControls = { ready: true, depositError: new Error("crashed after broadcast") };
    const fake = fakeDependencies(controls);
    await expect(runOxideFunding(options(statePath), fake.dependencies)).rejects.toThrow("crashed after broadcast");
    expect(readOxideFundingState(statePath)).toMatchObject({
      phase: "deposited",
      deposit: { transaction: { hash: DEPOSIT_HASH, rawTransaction: RAW_DEPOSIT } },
    });

    delete controls.depositError;
    const outcome = await runOxideFunding(options(statePath), fake.dependencies);
    expect(outcome.kind).toBe("stored");
    expect(fake.calls.prepareDeposit).toBe(1);
    expect(fake.calls.confirmDeposit).toBe(2);
  });

  it("rejects any mismatch in the recovered Deposit event", async () => {
    const fake = fakeDependencies();
    const original = fake.dependencies.confirmDeposit;
    fake.dependencies.confirmDeposit = async (transaction) => {
      const evidence = await original(transaction);
      return { ...evidence, event: { ...evidence.event, creditedAmount: evidence.event.creditedAmount + 1n } };
    };
    await expect(runOxideFunding(options(statePath), fake.dependencies)).rejects.toThrow(/credited amount mismatch/);
    const state = readOxideFundingState(statePath);
    expect(state.phase).toBe("deposited");
    expect(state.deposit?.event).toBeUndefined();
    expect(fake.calls.store).toBe(0);
  });

  it("persists a verified event while the message is not ready, then stores on resume", async () => {
    const controls: FakeControls = { ready: false };
    const fake = fakeDependencies(controls);
    const waiting = await runOxideFunding(options(statePath), fake.dependencies);
    expect(waiting.kind).toBe("waiting");
    expect(readOxideFundingState(statePath)).toMatchObject({
      phase: "deposited",
      deposit: { event: { key: MESSAGE_KEY, index: "17", creditedAmount: IDENTITY.amount } },
    });
    expect(fake.calls.store).toBe(0);

    controls.ready = true;
    const stored = await runOxideFunding(options(statePath), fake.dependencies);
    expect(stored.kind).toBe("stored");
    expect(fake.calls.prepareDeposit).toBe(1);
    expect(fake.calls.confirmDeposit).toBe(1);
    expect(fake.calls.store).toBe(1);
  });

  it("stores successfully and makes a completed rerun a no-op", async () => {
    const fake = fakeDependencies();
    await expect(runOxideFunding(options(statePath), fake.dependencies)).resolves.toMatchObject({ kind: "stored" });
    expect(readOxideFundingState(statePath).phase).toBe("stored");
    await expect(runOxideFunding(options(statePath), fake.dependencies)).resolves.toMatchObject({ kind: "stored" });
    expect(fake.calls.store).toBe(1);
  });

  it("classifies only the exact already-stored assertion as idempotent", async () => {
    const exact = new Error("Assertion failed: deposit already stored");
    const fake = fakeDependencies({ ready: true, storeError: exact });
    await expect(runOxideFunding(options(statePath), fake.dependencies)).resolves.toMatchObject({ kind: "stored" });
    expect(readOxideFundingState(statePath).phase).toBe("stored");
    expect(isExactAlreadyStoredError(new Error("deposit already stored for another index"))).toBe(false);
    expect(isExactAlreadyStoredError(new Error("some unrelated error"))).toBe(false);
  });

  it("keeps unrelated store errors visible while redacting the salt from all output", async () => {
    const messages: string[] = [];
    const error = new Error(`backend refused salt ${SALT}`);
    const fake = fakeDependencies({ ready: true, storeError: error });
    let observed: Error | undefined;
    try {
      await runOxideFunding(options(statePath, (message) => messages.push(message)), fake.dependencies);
    } catch (cause) {
      observed = cause as Error;
    }
    expect(observed?.message).toContain("backend refused salt [REDACTED]");
    expect(observed?.message).not.toContain(SALT);
    expect(messages.join("\n")).not.toContain(SALT);
    expect(readOxideFundingState(statePath).phase).toBe("message_ready");
  });
});
