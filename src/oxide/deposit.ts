import { DomainSeparator } from "@aztec-labs/constants";
import { toBufferBE } from "@aztec-labs/foundation/bigint-buffer";
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon";
import { keccak256String } from "@aztec-labs/foundation/crypto/keccak";
import { sha256ToField } from "@aztec-labs/foundation/crypto/sha256";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { EthAddress } from "@aztec-labs/foundation/eth-address";
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address";
import { L1Actor, L1ToL2Message, L2Actor } from "@aztec-labs/stdlib/messaging";
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { OXIDE_V6_MAINNET } from "./pins.js";

export const OXIDE_DEPOSIT_CHAIN_ID = 1;
export const OXIDE_DEPOSIT_PORTAL = getAddress(
  "0xCB99C58Fe81Ae6b2cB4835e46F7b703745879042",
);
export const OXIDE_DEPOSIT_DAI = getAddress(
  "0x6B175474E89094C44Da98b954EedeAC495271d0F",
);
export const OXIDE_DEPOSIT_OXDAI =
  "0x11d2bed21a36289fd6f6a6af93a546b5be7115caf957f0f700f42d56e25fe0a3";
export const OXIDE_DEPOSIT_SENDER =
  "0x15ff3aa2270843241b4405bfc8ba72ae59b68c85996cff9e5c03daf03109cb22";
export const OXIDE_DEPOSIT_ROLLUP_VERSION = 2_070_860_440n;
export const OXIDE_DEPOSIT_PER_TX_CAP = 1_000n * 10n ** 18n;
export const OXIDE_DEPOSIT_ROLLING_CAP = 10_000n * 10n ** 18n;
export const OXIDE_DEPOSIT_NOTE_MAX =
  OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount;
export const OXIDE_DEPOSIT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const OXIDE_PORTAL_ABI = parseAbi([
  "function deposit(bytes32 recipientCommitment, uint256 amount) returns (bytes32 key, uint256 index, uint256 creditedAmount)",
  "function UNDERLYING() view returns (address)",
  "function L2_TOKEN() view returns (bytes32)",
  "function ROLLUP_VERSION() view returns (uint256)",
  "function TX_AMOUNT_CAP() view returns (uint256)",
  "function $depositMessageIndex(bytes32 key) view returns (uint256)",
  "event Deposit(bytes32 indexed recipientCommitment, uint256 amount, bytes32 key, uint256 index)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export interface OxideDepositLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
}

export interface OxideDepositReceipt {
  status: "success" | "reverted";
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  to: Address | null;
  logs: readonly OxideDepositLog[];
}

export interface OxideDepositTransaction {
  hash: Hex;
  to: Address | null;
  input: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
}

export interface OxideDepositBlock {
  number: bigint;
  hash: Hex | null;
  timestamp: bigint;
}

export interface OxidePortalState {
  underlying: Address;
  l2Token: Hex;
  rollupVersion: bigint;
  txAmountCap: bigint;
  depositMessageIndex: bigint;
}

/** Narrow read surface so receipt verification is deterministic in tests. */
export interface OxideDepositChain {
  chainId(): Promise<number>;
  receipt(txHash: Hex): Promise<OxideDepositReceipt>;
  transaction(txHash: Hex): Promise<OxideDepositTransaction>;
  finalizedBlock(): Promise<OxideDepositBlock>;
  block(blockNumber: bigint): Promise<OxideDepositBlock>;
  portalState(blockNumber: bigint, messageKey: Hex): Promise<OxidePortalState>;
}

export interface VerifiedOxideDeposit {
  txHash: Hex;
  eventId: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestampMs: number;
  amount: bigint;
  messageKey: Hex;
  inboxIndex: bigint;
  recipientCommitment: Hex;
}

export interface OxideDepositPlan {
  chainId: number;
  portal: Address;
  underlying: Address;
  l2Token: string;
  rollupVersion: string;
  sender: string;
  amount: string;
  recipientCommitment: Hex;
  approval: {
    to: Address;
    function: "approve";
    args: readonly [Address, string];
    calldata: Hex;
  };
  deposit: {
    to: Address;
    function: "deposit";
    args: readonly [Hex, string];
    calldata: Hex;
  };
}

export async function oxideRecipientCommitment(
  sharedSecretSalt: Fr,
): Promise<Hex> {
  const sender = AztecAddress.fromStringUnsafe(OXIDE_DEPOSIT_SENDER);
  const commitment = await poseidon2HashWithSeparator(
    [sharedSecretSalt, sender.toField()],
    DomainSeparator.SECRET_HASH,
  );
  return commitment.toString() as Hex;
}

export async function prepareOxideDeposit(
  amount: bigint,
  sharedSecretSalt: Fr,
): Promise<OxideDepositPlan> {
  assertDepositAmount(amount);
  const recipientCommitment = await oxideRecipientCommitment(sharedSecretSalt);
  return {
    chainId: OXIDE_DEPOSIT_CHAIN_ID,
    portal: OXIDE_DEPOSIT_PORTAL,
    underlying: OXIDE_DEPOSIT_DAI,
    l2Token: OXIDE_DEPOSIT_OXDAI,
    rollupVersion: OXIDE_DEPOSIT_ROLLUP_VERSION.toString(),
    sender: OXIDE_DEPOSIT_SENDER,
    amount: amount.toString(),
    recipientCommitment,
    approval: {
      to: OXIDE_DEPOSIT_DAI,
      function: "approve",
      args: [OXIDE_DEPOSIT_PORTAL, amount.toString()],
      calldata: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [OXIDE_DEPOSIT_PORTAL, amount],
      }),
    },
    deposit: {
      to: OXIDE_DEPOSIT_PORTAL,
      function: "deposit",
      args: [recipientCommitment, amount.toString()],
      calldata: encodeFunctionData({
        abi: OXIDE_PORTAL_ABI,
        functionName: "deposit",
        args: [recipientCommitment, amount],
      }),
    },
  };
}

export function oxideDepositMessageKey(
  recipientCommitment: Hex,
  amount: bigint,
  inboxIndex: bigint,
): Hex {
  const selector = Buffer.from(
    keccak256String("deposit(uint256)").replace(/^0x/, ""),
    "hex",
  ).subarray(0, 4);
  const content = sha256ToField([selector, toBufferBE(amount, 32)]);
  return new L1ToL2Message(
    new L1Actor(
      EthAddress.fromString(OXIDE_DEPOSIT_PORTAL),
      OXIDE_DEPOSIT_CHAIN_ID,
    ),
    new L2Actor(
      AztecAddress.fromStringUnsafe(OXIDE_DEPOSIT_OXDAI),
      Number(OXIDE_DEPOSIT_ROLLUP_VERSION),
    ),
    content,
    Fr.fromString(recipientCommitment),
    new Fr(inboxIndex),
  )
    .hash()
    .toString() as Hex;
}

export async function verifyOxideDeposit(
  chain: OxideDepositChain,
  txHash: Hex,
  sharedSecretSalt: Fr,
): Promise<VerifiedOxideDeposit> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
    throw new Error("deposit transaction hash must be 32-byte hex");
  const chainId = await chain.chainId();
  if (chainId !== OXIDE_DEPOSIT_CHAIN_ID) {
    throw new Error(
      `wrong L1 chain: expected ${OXIDE_DEPOSIT_CHAIN_ID}, got ${chainId}`,
    );
  }

  const [receipt, transaction, finalized] = await Promise.all([
    chain.receipt(txHash),
    chain.transaction(txHash),
    chain.finalizedBlock(),
  ]);
  const normalizedTxHash = txHash.toLowerCase();
  if (
    receipt.transactionHash.toLowerCase() !== normalizedTxHash ||
    transaction.hash.toLowerCase() !== normalizedTxHash
  ) {
    throw new Error(
      "L1 RPC returned a receipt or transaction for a different hash",
    );
  }
  if (receipt.status !== "success")
    throw new Error("deposit transaction reverted");
  if (receipt.blockNumber > finalized.number) {
    throw new Error(
      `deposit transaction is not finalized: receipt block ${receipt.blockNumber}, finalized ${finalized.number}`,
    );
  }
  const canonical = await chain.block(receipt.blockNumber);
  if (
    canonical.hash === null ||
    canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    transaction.blockHash === null ||
    transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    transaction.blockNumber !== receipt.blockNumber
  ) {
    throw new Error("deposit receipt is ambiguous or no longer canonical");
  }
  if (receipt.to === null || getAddress(receipt.to) !== OXIDE_DEPOSIT_PORTAL) {
    throw new Error(`wrong receipt portal: expected ${OXIDE_DEPOSIT_PORTAL}`);
  }
  if (
    transaction.to === null ||
    getAddress(transaction.to) !== OXIDE_DEPOSIT_PORTAL
  ) {
    throw new Error(
      `wrong transaction portal: expected ${OXIDE_DEPOSIT_PORTAL}`,
    );
  }

  let decodedCall: { functionName: string; args?: readonly unknown[] };
  try {
    decodedCall = decodeFunctionData({
      abi: OXIDE_PORTAL_ABI,
      data: transaction.input,
    });
  } catch (cause) {
    throw new Error(
      "deposit transaction calldata is not a canonical OxidePortal call",
      { cause },
    );
  }
  if (decodedCall.functionName !== "deposit")
    throw new Error("transaction did not call OxidePortal.deposit");
  const callArgs = decodedCall.args;
  if (!callArgs || callArgs.length !== 2)
    throw new Error("deposit calldata has the wrong argument shape");
  const callCommitment = String(callArgs[0]).toLowerCase() as Hex;
  const callAmount = BigInt(callArgs[1] as bigint);
  assertDepositAmount(callAmount);
  const canonicalCalldata = encodeFunctionData({
    abi: OXIDE_PORTAL_ABI,
    functionName: "deposit",
    args: [callCommitment, callAmount],
  });
  if (canonicalCalldata.toLowerCase() !== transaction.input.toLowerCase()) {
    throw new Error(
      "deposit transaction calldata is not the canonical OxidePortal.deposit encoding",
    );
  }

  const expectedCommitment = await oxideRecipientCommitment(sharedSecretSalt);
  if (callCommitment !== expectedCommitment.toLowerCase()) {
    throw new Error(
      `deposit is not for the approved Oxide sender ${OXIDE_DEPOSIT_SENDER}`,
    );
  }

  const matchingLogs = receipt.logs.filter(
    (log) => getAddress(log.address) === OXIDE_DEPOSIT_PORTAL,
  );
  const decodedDeposits: {
    logIndex: number;
    recipientCommitment: Hex;
    amount: bigint;
    key: Hex;
    index: bigint;
  }[] = [];
  for (const log of matchingLogs) {
    try {
      if (log.topics.length === 0) continue;
      const decoded = decodeEventLog({
        abi: OXIDE_PORTAL_ABI,
        eventName: "Deposit",
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        strict: true,
      });
      if (log.logIndex === null)
        throw new Error("deposit event has no log index");
      const args = decoded.args;
      decodedDeposits.push({
        logIndex: log.logIndex,
        recipientCommitment: args.recipientCommitment,
        amount: args.amount,
        key: args.key,
        index: args.index,
      });
    } catch {
      // Other portal events are irrelevant. A malformed Deposit does not count.
    }
  }
  if (decodedDeposits.length !== 1) {
    throw new Error(
      `deposit receipt is ambiguous: expected one Deposit event, got ${decodedDeposits.length}`,
    );
  }
  const event = decodedDeposits[0]!;
  if (
    event.recipientCommitment.toLowerCase() !== expectedCommitment.toLowerCase()
  ) {
    throw new Error(
      "Deposit event recipient commitment does not match the approved Oxide sender",
    );
  }
  if (event.amount !== callAmount)
    throw new Error("Deposit event amount does not match transaction calldata");
  if (BigInt(event.key) === 0n)
    throw new Error("Deposit event has an empty message key");
  const derivedMessageKey = oxideDepositMessageKey(
    event.recipientCommitment,
    event.amount,
    event.index,
  );
  if (derivedMessageKey.toLowerCase() !== event.key.toLowerCase()) {
    throw new Error(
      "Deposit event message key does not match its canonical L1-to-L2 message",
    );
  }

  const state = await chain.portalState(receipt.blockNumber, event.key);
  if (getAddress(state.underlying) !== OXIDE_DEPOSIT_DAI) {
    throw new Error(
      `wrong portal underlying token: expected DAI ${OXIDE_DEPOSIT_DAI}`,
    );
  }
  if (state.l2Token.toLowerCase() !== OXIDE_DEPOSIT_OXDAI) {
    throw new Error(
      `wrong portal L2 token: expected OXDAI ${OXIDE_DEPOSIT_OXDAI}`,
    );
  }
  if (state.rollupVersion !== OXIDE_DEPOSIT_ROLLUP_VERSION) {
    throw new Error(
      `wrong portal rollup version: expected ${OXIDE_DEPOSIT_ROLLUP_VERSION}, got ${state.rollupVersion}`,
    );
  }
  if (state.txAmountCap !== OXIDE_DEPOSIT_NOTE_MAX) {
    throw new Error(
      `wrong portal transaction cap: expected ${OXIDE_DEPOSIT_NOTE_MAX}, got ${state.txAmountCap}`,
    );
  }
  if (state.depositMessageIndex !== event.index + 1n) {
    throw new Error(
      "Deposit event inbox index does not match OxidePortal depositMessageIndex",
    );
  }

  const timestampMs = Number(canonical.timestamp) * 1_000;
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0)
    throw new Error("canonical block timestamp is invalid");
  return {
    txHash: txHash.toLowerCase() as Hex,
    eventId: `${txHash.toLowerCase()}:${event.logIndex}:${event.key.toLowerCase()}:${event.index}`,
    logIndex: event.logIndex,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase() as Hex,
    blockTimestampMs: timestampMs,
    amount: event.amount,
    messageKey: event.key.toLowerCase() as Hex,
    inboxIndex: event.index,
    recipientCommitment: expectedCommitment.toLowerCase() as Hex,
  };
}

function assertDepositAmount(amount: bigint): void {
  if (amount <= 0n) throw new Error("deposit amount must be positive");
  if (amount > OXIDE_DEPOSIT_PER_TX_CAP) {
    throw new Error(
      `deposit amount exceeds the ${OXIDE_DEPOSIT_PER_TX_CAP} per-transaction cap`,
    );
  }
  if (amount > OXIDE_DEPOSIT_NOTE_MAX) {
    throw new Error(
      `deposit amount exceeds the ${OXIDE_DEPOSIT_NOTE_MAX} OXDAI note maximum`,
    );
  }
}
