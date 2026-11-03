import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OXIDE_V6_MAINNET, type OxidePins } from "./pins.js";

const L1_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FIELD = /^0x[0-9a-fA-F]{64}$/;
const HASH = FIELD;
const RAW_TRANSACTION = /^0x(?:[0-9a-fA-F]{2})+$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const FUNDING_PHASES = ["prepared", "approved", "deposited", "message_ready", "stored"] as const;
export type FundingPhase = (typeof FUNDING_PHASES)[number];

export interface FundingIdentityInput {
  chainId: string;
  portal: string;
  token: string;
  sender: string;
  recipient: string;
  amount: string;
}

export interface FundingIdentity {
  chainId: string;
  portal: string;
  token: string;
  sender: string;
  recipient: string;
  amount: string;
}

export interface SignedFundingTransaction {
  hash: string;
  rawTransaction: string;
}

export interface FundingDepositEvent {
  recipientCommitment: string;
  creditedAmount: string;
  key: string;
  index: string;
}

export interface OxideFundingState {
  version: 1;
  phase: FundingPhase;
  identity: FundingIdentity;
  sharedSecretSalt: string;
  recipientCommitment: string;
  approvalTransaction?: SignedFundingTransaction;
  deposit?: {
    transaction: SignedFundingTransaction;
    event?: FundingDepositEvent;
  };
}

const FundingIdentitySchema = z.object({
  chainId: z.string().regex(POSITIVE_DECIMAL),
  portal: z.string().regex(L1_ADDRESS),
  token: z.string().regex(L1_ADDRESS),
  sender: z.string().regex(L1_ADDRESS),
  recipient: z.string().regex(FIELD),
  amount: z.string().regex(POSITIVE_DECIMAL),
}).strict();

const SignedFundingTransactionSchema = z.object({
  hash: z.string().regex(HASH),
  rawTransaction: z.string().regex(RAW_TRANSACTION),
}).strict();

const FundingDepositEventSchema = z.object({
  recipientCommitment: z.string().regex(FIELD),
  creditedAmount: z.string().regex(POSITIVE_DECIMAL),
  key: z.string().regex(FIELD),
  index: z.string().regex(/^\d+$/),
}).strict();

const OxideFundingStateSchema = z.object({
  version: z.literal(1),
  phase: z.enum(FUNDING_PHASES),
  identity: FundingIdentitySchema,
  sharedSecretSalt: z.string().regex(FIELD),
  recipientCommitment: z.string().regex(FIELD),
  approvalTransaction: SignedFundingTransactionSchema.optional(),
  deposit: z.object({
    transaction: SignedFundingTransactionSchema,
    event: FundingDepositEventSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((state, context) => {
  const phase = FUNDING_PHASES.indexOf(state.phase);
  if (phase >= FUNDING_PHASES.indexOf("approved") && state.approvalTransaction === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["approvalTransaction"], message: `${state.phase} needs approvalTransaction` });
  }
  if (phase >= FUNDING_PHASES.indexOf("deposited") && state.deposit === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["deposit"], message: `${state.phase} needs deposit` });
  }
  if (phase >= FUNDING_PHASES.indexOf("message_ready") && state.deposit?.event === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["deposit", "event"], message: `${state.phase} needs the Deposit event` });
  }
  if (state.phase === "prepared" && state.deposit !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["deposit"], message: "prepared cannot have a deposit transaction" });
  }
  if (state.phase === "approved" && state.deposit !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["deposit"], message: "approved cannot have a deposit transaction" });
  }
});

export interface FundingDeploymentFacts {
  chainId: bigint;
  portal: string;
  token: string;
  l2Token: string;
  rollupVersion: bigint;
  txAmountCap: bigint;
  available: bigint;
  senderBalance: bigint;
  frozen: boolean;
}

export interface FundingApprovalEvidence {
  transactionHash: string;
  from: string;
  to: string;
  spender: string;
  amount: bigint;
}

export interface FundingDepositEvidence {
  transactionHash: string;
  from: string;
  to: string;
  recipientCommitment: string;
  requestedAmount: bigint;
  event: {
    recipientCommitment: string;
    creditedAmount: bigint;
    key: string;
    index: bigint;
  };
}

export interface OxideFundingDependencies {
  randomSalt(): string;
  computeRecipientCommitment(sharedSecretSalt: string, recipient: string): Promise<string>;
  deploymentFacts(): Promise<FundingDeploymentFacts>;
  prepareApproval(identity: FundingIdentity): Promise<SignedFundingTransaction>;
  confirmApproval(transaction: SignedFundingTransaction): Promise<FundingApprovalEvidence>;
  prepareDeposit(identity: FundingIdentity, recipientCommitment: string): Promise<SignedFundingTransaction>;
  confirmDeposit(transaction: SignedFundingTransaction): Promise<FundingDepositEvidence>;
  messageReady(key: string): Promise<boolean>;
  waitBeforeNextPoll(): Promise<void>;
  storeDeposit(deposit: {
    inboxIndex: bigint;
    amount: bigint;
    recipient: string;
    sharedSecretSalt: string;
  }): Promise<void>;
  isAlreadyStored(error: unknown): boolean;
}

export interface RunOxideFundingOptions {
  statePath: string;
  identity: FundingIdentityInput;
  expectedRecipient: string;
  pollAttempts?: number;
  pins?: OxidePins;
  log?: (message: string) => void;
}

export type OxideFundingOutcome =
  | { kind: "waiting"; state: OxideFundingState }
  | { kind: "stored"; state: OxideFundingState };

function normalizeL1Address(name: string, value: string): string {
  if (!L1_ADDRESS.test(value)) throw new Error(`${name} must be a 20-byte hex address`);
  return value.toLowerCase();
}

function normalizeField(name: string, value: string): string {
  if (!FIELD.test(value)) throw new Error(`${name} must be a 32-byte hex field`);
  const field = BigInt(value);
  if (field === 0n || field >= FR_MODULUS) throw new Error(`${name} must be a nonzero BN254 field`);
  return `0x${field.toString(16).padStart(64, "0")}`;
}

/** Static, shipped identity and amount checks. These run before the state file or any transaction is written. */
export function validateFundingIdentity(
  input: FundingIdentityInput,
  expectedRecipient: string,
  pins: OxidePins = OXIDE_V6_MAINNET,
): FundingIdentity {
  if (!POSITIVE_DECIMAL.test(input.chainId)) throw new Error("--chain-id must be a canonical positive decimal integer");
  if (BigInt(input.chainId) !== pins.l1ChainId) {
    throw new Error(`--chain-id must be pinned chain ${pins.l1ChainId}, got ${input.chainId}`);
  }
  if (!POSITIVE_DECIMAL.test(input.amount)) throw new Error("--amount must be a canonical positive base-unit decimal integer");
  const amount = BigInt(input.amount);
  if (amount > pins.bridge.l2TokenImmutables.maxNoteAmount) {
    throw new Error(`--amount exceeds the shipped portal/OXDAI limit ${pins.bridge.l2TokenImmutables.maxNoteAmount}`);
  }

  const portal = normalizeL1Address("--portal", input.portal);
  const token = normalizeL1Address("--token", input.token);
  const sender = normalizeL1Address("--sender", input.sender);
  const recipient = normalizeField("--recipient", input.recipient);
  const pinnedRecipient = normalizeField("PXE_BRIDGE_ACCOUNT_ADDRESS", expectedRecipient);
  if (portal !== pins.bridge.portal) throw new Error(`--portal is not the shipped Oxide portal ${pins.bridge.portal}`);
  if (token !== pins.bridge.underlying) throw new Error(`--token is not the shipped Oxide underlying ${pins.bridge.underlying}`);
  if (recipient !== pinnedRecipient) {
    throw new Error("--recipient is not the recorded PXE_BRIDGE_ACCOUNT_ADDRESS");
  }
  return { chainId: input.chainId, portal, token, sender, recipient, amount: input.amount };
}

function stateIssue(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "state"}: ${issue.message}`).join("; ");
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function temporaryPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

function writeOwnerOnly(path: string, state: OxideFundingState): void {
  const parsed = OxideFundingStateSchema.safeParse(state);
  if (!parsed.success) throw new Error(`Refusing to write invalid Oxide funding state: ${stateIssue(parsed.error)}`);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(parsed.data, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Exclusive atomic creation: the final pathname appears only after its owner-only contents are fsynced. */
export function createOxideFundingState(path: string, state: OxideFundingState): void {
  const tmp = temporaryPath(path);
  try {
    writeOwnerOnly(tmp, state);
    linkSync(tmp, path);
    fsyncDirectory(dirname(path));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Atomic durable replacement: old state or new state survives, never a partial JSON document. */
export function updateOxideFundingState(path: string, state: OxideFundingState): void {
  if (!existsSync(path)) throw new Error(`Oxide funding state ${path} is missing`);
  const tmp = temporaryPath(path);
  try {
    writeOwnerOnly(tmp, state);
    renameSync(tmp, path);
    fsyncDirectory(dirname(path));
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function readOxideFundingState(path: string): OxideFundingState {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Oxide funding state ${path} must be a regular file`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Oxide funding state ${path} is not owned by this user`);
  }
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`Oxide funding state ${path} must have mode 0600`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Cannot read Oxide funding state ${path}`, { cause });
  }
  const parsed = OxideFundingStateSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Oxide funding state ${path} is invalid: ${stateIssue(parsed.error)}`);
  const state = parsed.data;
  return {
    version: state.version,
    phase: state.phase,
    identity: state.identity,
    sharedSecretSalt: state.sharedSecretSalt,
    recipientCommitment: state.recipientCommitment,
    ...(state.approvalTransaction ? { approvalTransaction: state.approvalTransaction } : {}),
    ...(state.deposit
      ? {
          deposit: {
            transaction: state.deposit.transaction,
            ...(state.deposit.event ? { event: state.deposit.event } : {}),
          },
        }
      : {}),
  };
}

function sameIdentity(actual: FundingIdentity, expected: FundingIdentity): boolean {
  return (Object.keys(expected) as (keyof FundingIdentity)[]).every((key) => actual[key] === expected[key]);
}

async function validateExistingState(
  state: OxideFundingState,
  expected: FundingIdentity,
  computeRecipientCommitment: OxideFundingDependencies["computeRecipientCommitment"],
): Promise<void> {
  if (!sameIdentity(state.identity, expected)) throw new Error("Oxide funding state identity differs from the required command identity");
  const commitment = await computeRecipientCommitment(state.sharedSecretSalt, state.identity.recipient);
  if (commitment.toLowerCase() !== state.recipientCommitment.toLowerCase()) {
    throw new Error("Oxide funding state salt/recipient commitment is inconsistent");
  }
  if (state.deposit?.event && state.deposit.event.recipientCommitment.toLowerCase() !== state.recipientCommitment.toLowerCase()) {
    throw new Error("Oxide funding state Deposit event commitment is inconsistent");
  }
}

export async function planOxideFunding(
  options: Pick<RunOxideFundingOptions, "statePath" | "identity" | "expectedRecipient" | "pins">,
  computeRecipientCommitment: OxideFundingDependencies["computeRecipientCommitment"],
): Promise<{ identity: FundingIdentity; phase: FundingPhase | "new" }> {
  const identity = validateFundingIdentity(options.identity, options.expectedRecipient, options.pins);
  if (!existsSync(options.statePath)) return { identity, phase: "new" };
  const state = readOxideFundingState(options.statePath);
  await validateExistingState(state, identity, computeRecipientCommitment);
  return { identity, phase: state.phase };
}

function assertDeploymentFacts(facts: FundingDeploymentFacts, identity: FundingIdentity, phase: FundingPhase, pins: OxidePins): void {
  if (facts.chainId !== pins.l1ChainId) throw new Error(`L1 RPC moved to chain ${facts.chainId}, expected ${pins.l1ChainId}`);
  if (facts.portal.toLowerCase() !== identity.portal) throw new Error("L1 deployment reports a different Oxide portal");
  if (facts.token.toLowerCase() !== identity.token) throw new Error("OxidePortal.UNDERLYING moved from the pinned token");
  if (facts.l2Token.toLowerCase() !== pins.bridge.l2Token) throw new Error("OxidePortal.L2_TOKEN moved from the pinned OXDAI token");
  if (facts.rollupVersion !== pins.rollupVersion) throw new Error("OxidePortal.ROLLUP_VERSION moved from the pinned deployment");
  if (facts.txAmountCap !== pins.bridge.l2TokenImmutables.maxNoteAmount) {
    throw new Error("OxidePortal.TX_AMOUNT_CAP moved from the shipped OXDAI note limit");
  }
  if (facts.frozen) throw new Error("Oxide portal is frozen");
  if (phase === "prepared" || phase === "approved") {
    const amount = BigInt(identity.amount);
    if (facts.available < amount) throw new Error(`Oxide portal capacity ${facts.available} is below requested amount ${amount}`);
    if (facts.senderBalance < amount) throw new Error(`L1 sender token balance ${facts.senderBalance} is below requested amount ${amount}`);
  }
}

function validateApprovalEvidence(evidence: FundingApprovalEvidence, transaction: SignedFundingTransaction, identity: FundingIdentity): void {
  if (evidence.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()) throw new Error("Approval receipt is for another transaction");
  if (evidence.from.toLowerCase() !== identity.sender) throw new Error("Approval transaction sender mismatch");
  if (evidence.to.toLowerCase() !== identity.token) throw new Error("Approval transaction token mismatch");
  if (evidence.spender.toLowerCase() !== identity.portal) throw new Error("Approval transaction spender mismatch");
  if (evidence.amount !== BigInt(identity.amount)) throw new Error("Approval transaction amount mismatch");
}

function validateDepositEvidence(
  evidence: FundingDepositEvidence,
  transaction: SignedFundingTransaction,
  state: OxideFundingState,
): FundingDepositEvent {
  if (evidence.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()) throw new Error("Deposit receipt is for another transaction");
  if (evidence.from.toLowerCase() !== state.identity.sender) throw new Error("Deposit transaction sender mismatch");
  if (evidence.to.toLowerCase() !== state.identity.portal) throw new Error("Deposit transaction portal mismatch");
  if (evidence.recipientCommitment.toLowerCase() !== state.recipientCommitment.toLowerCase()) {
    throw new Error("Deposit transaction recipient commitment mismatch");
  }
  const amount = BigInt(state.identity.amount);
  if (evidence.requestedAmount !== amount) throw new Error("Deposit transaction requested amount mismatch");
  if (evidence.event.recipientCommitment.toLowerCase() !== state.recipientCommitment.toLowerCase()) {
    throw new Error("Deposit event recipient commitment mismatch");
  }
  if (evidence.event.creditedAmount !== amount) throw new Error("Deposit event credited amount mismatch");
  if (!FIELD.test(evidence.event.key)) throw new Error("Deposit event key is not a 32-byte field");
  if (evidence.event.index < 0n) throw new Error("Deposit event index is negative");
  return {
    recipientCommitment: state.recipientCommitment,
    creditedAmount: amount.toString(),
    key: evidence.event.key.toLowerCase(),
    index: evidence.event.index.toString(),
  };
}

function nextState(path: string, state: OxideFundingState): OxideFundingState {
  updateOxideFundingState(path, state);
  return state;
}

function redactedStoreError(error: unknown, salt: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`store_deposit failed: ${message.split(salt).join("[REDACTED]")}`);
}

/**
 * Durable approve -> deposit -> message readiness -> store_deposit workflow.
 * A deposit is signed and durably recorded before its raw transaction is sent;
 * all later runs can only rebroadcast that exact transaction hash and nonce.
 */
export async function runOxideFunding(
  options: RunOxideFundingOptions,
  dependencies: OxideFundingDependencies,
): Promise<OxideFundingOutcome> {
  const pins = options.pins ?? OXIDE_V6_MAINNET;
  const identity = validateFundingIdentity(options.identity, options.expectedRecipient, pins);
  const pollAttempts = options.pollAttempts ?? 1;
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts <= 0) throw new Error("pollAttempts must be a positive integer");
  const log = options.log ?? (() => {});

  let state: OxideFundingState;
  if (existsSync(options.statePath)) {
    state = readOxideFundingState(options.statePath);
    await validateExistingState(state, identity, dependencies.computeRecipientCommitment);
  } else {
    const sharedSecretSalt = normalizeField("generated shared secret salt", dependencies.randomSalt());
    const recipientCommitment = normalizeField(
      "computed recipient commitment",
      await dependencies.computeRecipientCommitment(sharedSecretSalt, identity.recipient),
    );
    state = { version: 1, phase: "prepared", identity, sharedSecretSalt, recipientCommitment };
    createOxideFundingState(options.statePath, state);
    log(`Prepared owner-only state ${options.statePath}`);
  }

  assertDeploymentFacts(await dependencies.deploymentFacts(), state.identity, state.phase, pins);
  if (state.phase === "stored") return { kind: "stored", state };

  if (state.phase === "prepared") {
    let transaction = state.approvalTransaction;
    if (transaction === undefined) {
      transaction = await dependencies.prepareApproval(state.identity);
      state = nextState(options.statePath, { ...state, approvalTransaction: transaction });
    }
    validateApprovalEvidence(await dependencies.confirmApproval(transaction), transaction, state.identity);
    state = nextState(options.statePath, { ...state, phase: "approved" });
    log("Approval confirmed");
  }

  if (state.phase === "approved") {
    const transaction = await dependencies.prepareDeposit(state.identity, state.recipientCommitment);
    state = nextState(options.statePath, { ...state, phase: "deposited", deposit: { transaction } });
    log("Deposit transaction recorded before broadcast");
  }

  if (state.phase === "deposited") {
    const deposit = state.deposit;
    if (deposit === undefined) throw new Error("Deposited state has no recorded transaction");
    if (deposit.event === undefined) {
      const event = validateDepositEvidence(
        await dependencies.confirmDeposit(deposit.transaction),
        deposit.transaction,
        state,
      );
      state = nextState(options.statePath, { ...state, deposit: { transaction: deposit.transaction, event } });
      log("Deposit event recovered and verified");
    }
  }

  if (state.phase === "deposited") {
    const event = state.deposit?.event;
    if (event === undefined) throw new Error("Deposited state has no verified event");
    let ready = false;
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      ready = await dependencies.messageReady(event.key);
      if (ready) break;
      if (attempt + 1 < pollAttempts) await dependencies.waitBeforeNextPoll();
    }
    if (!ready) {
      log("L1 to L2 message is not ready; rerun with the same state file");
      return { kind: "waiting", state };
    }
    state = nextState(options.statePath, { ...state, phase: "message_ready" });
    log("L1 to L2 message ready");
  }

  if (state.phase === "message_ready") {
    const event = state.deposit?.event;
    if (event === undefined) throw new Error("Message-ready state has no verified Deposit event");
    try {
      await dependencies.storeDeposit({
        inboxIndex: BigInt(event.index),
        amount: BigInt(event.creditedAmount),
        recipient: state.identity.recipient,
        sharedSecretSalt: state.sharedSecretSalt,
      });
    } catch (error) {
      if (!dependencies.isAlreadyStored(error)) throw redactedStoreError(error, state.sharedSecretSalt);
      log("Deposit was already stored for this exact inbox index");
    }
    state = nextState(options.statePath, { ...state, phase: "stored" });
    log("OXDAI deposit stored in PXE");
  }

  return { kind: "stored", state };
}

/**
 * Exact Noir assertion emitted by the vendored OxideToken `store_deposit` at
 * upstream 8fd198412a956f214639b5782d3a86e3d47ca60e. No other failure is idempotent.
 */
export function isExactAlreadyStoredError(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.some((message) =>
    message === "deposit already stored" ||
    message === "Assertion failed: deposit already stored" ||
    message.startsWith("Assertion failed: deposit already stored\n"),
  );
}
