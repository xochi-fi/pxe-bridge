import { describe, it, expect, beforeAll } from "vitest";
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { CompleteAddress } from "@aztec/stdlib/contract";
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec/stdlib/abi";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { GasSettings } from "@aztec/stdlib/gas";
import {
  SpendingLimitAccountContract,
  TRANSFER_TO_PRIVATE_SELECTOR,
  TRANSFER_TO_PRIVATE_SIGNATURE,
  type SpendingLimitConfig,
} from "../src/spending-limit-account.js";
import { ALLOWLIST_TREE_HEIGHT, rootFromSiblingPath } from "../src/allowlist-tree.js";

/**
 * The entrypoint must declare what the payload actually transfers, and must
 * carry a membership witness for that recipient and no other.
 *
 * The declaration used to be pushed onto the contract object before each send,
 * which made it a second source of truth that could disagree with the payload.
 * The witness would have had the same problem, and does not: both are read out
 * of the call being signed.
 *
 * Offsets into the encoded entrypoint args, from getEntrypointAbi():
 *   0..30  AppPayload   ([FunctionCall; 5] at 6 fields each, then tx_nonce)
 *   31     fee_payment_method
 *   32     cancellable
 *   33     declared_amount
 *   34     declared_recipient
 *   35     leaf_salt
 *   36     leaf_index
 *   37..   sibling_path (ALLOWLIST_TREE_HEIGHT entries)
 */
const DECLARED_AMOUNT_OFFSET = 33;
const DECLARED_RECIPIENT_OFFSET = 34;
const LEAF_SALT_OFFSET = 35;
const LEAF_INDEX_OFFSET = 36;
const SIBLING_PATH_OFFSET = 37;

// All must be BN254 field elements, so the leading byte stays below the
// modulus's 0x30. The old 0xaa/0xbb values only worked because nothing ever
// converted them to a field.
const RECIPIENT = "0x" + "11".repeat(32);
const OTHER_RECIPIENT = "0x" + "22".repeat(32);
const UNLISTED = "0x" + "13".repeat(32);
const TOKEN = "0x" + "0b".repeat(32);
const AMOUNT = 500_000_000_000_000_000_000n;

// Indices are deliberately not 0 and 1. Filling left to right would make the
// first touch of a position visibly an addition when the admin later updates
// it, so real deployments assign them randomly and the fixture models that.
const RECIPIENT_INDEX = 137;
const OTHER_INDEX = 942;

const config: SpendingLimitConfig = {
  maxAmountPerTx: 1_000_000_000_000_000_000_000n,
  dailyLimit: 5_000_000_000_000_000_000_000n,
  admin: "0x" + "0a".repeat(32),
  token: TOKEN,
  allowlistSeed: "0x" + "07".repeat(32),
  allowlistRecipients: [
    { address: RECIPIENT, index: RECIPIENT_INDEX },
    { address: OTHER_RECIPIENT, index: OTHER_INDEX },
  ],
};

/** A transfer_to_private call, shaped the way TokenContract emits one. */
async function transferCall(recipient: string, amount: bigint): Promise<FunctionCall> {
  return FunctionCall.from({
    name: "transfer_to_private",
    to: AztecAddress.fromStringUnsafe(TOKEN),
    selector: await FunctionSelector.fromSignature(TRANSFER_TO_PRIVATE_SIGNATURE),
    type: FunctionType.PRIVATE,
    hideMsgSender: false,
    isStatic: false,
    // (to: AztecAddress, amount: u128) encodes as two fields, a u128 packing
    // into one.
    args: [Fr.fromString(recipient), new Fr(amount)],
    returnTypes: [],
  });
}

async function transferPayload(
  recipient = RECIPIENT,
  amount = AMOUNT,
): Promise<ExecutionPayload> {
  return new ExecutionPayload([await transferCall(recipient, amount)], [], [], []);
}

const CHAIN_INFO = { chainId: new Fr(31337), version: new Fr(1) };
const ENTRYPOINT_OPTIONS = {
  cancellable: false,
  txNonce: Fr.ZERO,
  feePaymentMethodOptions: 0,
};

/**
 * The args the entrypoint encodes on the path the bridge actually takes.
 *
 * BaseWallet.createTxExecutionRequestFromPayloadAndFee calls
 * createTxExecutionRequest. wrapExecutionPayload is only reached through
 * AccountEntrypointMetaPaymentMethod, which this account never uses: it pays
 * with PREEXISTING_FEE_JUICE, so completeFeeOptions returns no
 * walletFeePaymentMethod and nothing wraps the payload. Testing only
 * wrapExecutionPayload would leave the production path uncovered.
 */
async function requestArgs(
  account: import("@aztec/aztec.js/account").Account,
  exec: ExecutionPayload,
): Promise<Fr[]> {
  const request = await account.createTxExecutionRequest(
    exec,
    GasSettings.empty(),
    CHAIN_INFO,
    ENTRYPOINT_OPTIONS as Parameters<typeof account.createTxExecutionRequest>[3],
  );
  // argsOfCalls is unordered; firstCallArgsHash points at the entrypoint's.
  const entry = request.argsOfCalls.find((h) => h.hash.equals(request.firstCallArgsHash));
  expect(entry).toBeDefined();
  return entry!.values;
}

/** The same, through the wrapping path, which the class still has to satisfy. */
async function wrappedArgs(
  account: import("@aztec/aztec.js/account").Account,
  exec: ExecutionPayload,
): Promise<Fr[]> {
  const payload = await account.wrapExecutionPayload(
    exec,
    CHAIN_INFO,
    ENTRYPOINT_OPTIONS as Parameters<typeof account.wrapExecutionPayload>[2],
  );
  const call = payload.calls[0];
  expect(call).toBeDefined();
  return call!.args;
}

describe("SpendingLimitAccountContract declaration binding", () => {
  const signingKey = GrumpkinScalar.fromString("0x" + "0".repeat(63) + "7");

  // Shared, because building the tree is 2 * 1024 hashes and the contract is
  // not mutated by any of these tests. Only the handed-out-early case needs a
  // contract of its own.
  let contract: SpendingLimitAccountContract;
  let address: CompleteAddress;

  beforeAll(async () => {
    contract = new SpendingLimitAccountContract(signingKey, config);
    address = await CompleteAddress.random();
    await contract.allowlistTree();
  });

  // Pins the same constant main.nr's transfer_to_private_selector_pin does. A
  // typo in the signature string would otherwise make deriveDeclaration find
  // no transfer and reject every send.
  it("derives the selector main.nr pins", async () => {
    const selector = await FunctionSelector.fromSignature(TRANSFER_TO_PRIVATE_SIGNATURE);
    expect(selector.toString()).toBe(TRANSFER_TO_PRIVATE_SELECTOR);
  });

  it("declares what the payload transfers", async () => {
    const args = await requestArgs(contract.getAccount(address), await transferPayload());

    expect(args[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(AMOUNT);
    expect(args[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(RECIPIENT);
    expect(args[LEAF_INDEX_OFFSET]!.toBigInt()).toBe(BigInt(RECIPIENT_INDEX));
  });

  /**
   * THE BINDING. The witness in the payload must reproduce the root the account
   * stores, using the recipient the payload declares.
   *
   * This is what the circuit does, reimplemented over the encoded args, so a
   * bug in path ordering or salt derivation fails here rather than as an
   * unexplained revert in public. `stale_witness_is_rejected` in main.nr covers
   * the other half, that a witness against a superseded root does not verify.
   */
  it("carries a witness that reproduces the stored root", async () => {
    const args = await requestArgs(contract.getAccount(address), await transferPayload());
    const tree = await contract.allowlistTree();

    const reproduced = await rootFromSiblingPath(
      Fr.fromString(RECIPIENT),
      args[LEAF_SALT_OFFSET]!,
      Number(args[LEAF_INDEX_OFFSET]!.toBigInt()),
      args.slice(SIBLING_PATH_OFFSET, SIBLING_PATH_OFFSET + ALLOWLIST_TREE_HEIGHT),
    );

    expect(reproduced.toString()).toBe(tree.root.toString());
  });

  // A witness proves membership of the leaf it is built for. Presenting the
  // same path with a different recipient must not verify, or the recipient
  // would not be bound to the proof at all.
  it("does not verify another recipient against the same path", async () => {
    const args = await requestArgs(contract.getAccount(address), await transferPayload());
    const tree = await contract.allowlistTree();

    const reproduced = await rootFromSiblingPath(
      Fr.fromString(OTHER_RECIPIENT),
      args[LEAF_SALT_OFFSET]!,
      Number(args[LEAF_INDEX_OFFSET]!.toBigInt()),
      args.slice(SIBLING_PATH_OFFSET, SIBLING_PATH_OFFSET + ALLOWLIST_TREE_HEIGHT),
    );

    expect(reproduced.toString()).not.toBe(tree.root.toString());
  });

  // Each recipient gets its own witness, derived from the payload rather than
  // from anything set beforehand.
  it("carries the witness for whichever recipient the payload names", async () => {
    const account = contract.getAccount(address);

    const first = await requestArgs(account, await transferPayload(RECIPIENT, AMOUNT));
    const second = await requestArgs(account, await transferPayload(OTHER_RECIPIENT, 1n));

    expect(first[LEAF_INDEX_OFFSET]!.toBigInt()).toBe(BigInt(RECIPIENT_INDEX));
    expect(second[LEAF_INDEX_OFFSET]!.toBigInt()).toBe(BigInt(OTHER_INDEX));
    expect(first[LEAF_SALT_OFFSET]!.toString()).not.toBe(second[LEAF_SALT_OFFSET]!.toString());
  });

  // The property the whole design turns on. Two sends built from different
  // payloads cannot declare each other's values, because neither has anywhere
  // to write a declaration the other could read. The witness is now in the same
  // position: it is looked up per payload, not pushed in per send.
  it("keeps concurrent sends from declaring each other's values", async () => {
    const account = contract.getAccount(address);

    const [first, second] = await Promise.all([
      requestArgs(account, await transferPayload(RECIPIENT, AMOUNT)),
      requestArgs(account, await transferPayload(OTHER_RECIPIENT, 1n)),
    ]);

    expect(first[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(AMOUNT);
    expect(first[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(RECIPIENT);
    expect(first[LEAF_INDEX_OFFSET]!.toBigInt()).toBe(BigInt(RECIPIENT_INDEX));
    expect(second[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(1n);
    expect(second[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(OTHER_RECIPIENT);
    expect(second[LEAF_INDEX_OFFSET]!.toBigInt()).toBe(BigInt(OTHER_INDEX));
  });

  // getAccount() is called during connect() and again on every wallet
  // resolution, so an account handed out before the tree was built is routinely
  // the one that signs. The tree lives in a holder shared by reference for
  // exactly this reason.
  it("shows an account created earlier the tree built later", async () => {
    const fresh = new SpendingLimitAccountContract(signingKey, config);
    const freshAddress = await CompleteAddress.random();
    const early = fresh.getAccount(freshAddress);

    await fresh.allowlistTree();

    const args = await requestArgs(early, await transferPayload());
    expect(args[LEAF_INDEX_OFFSET]!.toBigInt()).toBe(BigInt(RECIPIENT_INDEX));
  });

  // Both entrypoint methods build their args through buildEntrypointArgs now,
  // but they still assemble different envelopes around it. Only
  // createTxExecutionRequest is on the bridge's path today; this keeps the
  // other honest rather than leaving it silently untested.
  it("encodes the same declaration on both entrypoint paths", async () => {
    const account = contract.getAccount(address);
    const exec = await transferPayload();

    const viaRequest = await requestArgs(account, exec);
    const viaWrap = await wrappedArgs(account, exec);

    // Everything from fee_payment_method onward; the AppPayload before it
    // carries a random tx nonce.
    expect(viaWrap.slice(31).map(String)).toEqual(viaRequest.slice(31).map(String));
  });

  // Failing here costs nothing. Failing in the circuit costs a fee, because
  // set_as_fee_payer runs in the non-revertible setup phase.
  // Every call the SDK routes through this entrypoint reaches the derivation,
  // including simulating a private view such as verify_private_authwit.
  // Refusing those broke reads that have nothing to do with spending, which is
  // how the e2e authwit test caught it.
  //
  // Fail-closed is the circuit's job here: assert_single_call_matches rejects
  // an empty payload, and the entrypoint asserts !declared_recipient.is_zero(),
  // so a zero declaration cannot move value.
  it("declares zero and a zero witness for a payload with no transfer", async () => {
    const args = await requestArgs(contract.getAccount(address), ExecutionPayload.empty());

    expect(args[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(0n);
    expect(args[DECLARED_RECIPIENT_OFFSET]!.toBigInt()).toBe(0n);
    expect(args[LEAF_SALT_OFFSET]!.toBigInt()).toBe(0n);
    for (let i = 0; i < ALLOWLIST_TREE_HEIGHT; i++) {
      expect(args[SIBLING_PATH_OFFSET + i]!.toBigInt()).toBe(0n);
    }
  });

  // Two is unresolvable: one declaration and no basis for picking which
  // transfer it describes. Failing here costs nothing; failing in the circuit
  // costs a fee, since set_as_fee_payer runs in the non-revertible setup phase.
  it("refuses a payload with two transfers", async () => {
    const exec = new ExecutionPayload(
      [await transferCall(RECIPIENT, AMOUNT), await transferCall(OTHER_RECIPIENT, 1n)],
      [],
      [],
      [],
    );

    await expect(requestArgs(contract.getAccount(address), exec)).rejects.toThrow("at most one");
  });

  // An unlisted recipient has no witness, and there is no way to fabricate one.
  // Refusing here rather than letting the circuit refuse in public is the
  // difference between a free failure and a paid one.
  it("refuses a transfer to a recipient outside the allowlist", async () => {
    await expect(
      requestArgs(contract.getAccount(address), await transferPayload(UNLISTED, 1n)),
    ).rejects.toThrow("is not in the allowlist");
  });

  // The tree has to exist before anything can be signed against it. Without
  // this the failure would be an encoding error deep in the SDK.
  it("refuses to send before the tree is built", async () => {
    const unbuilt = new SpendingLimitAccountContract(signingKey, config);
    const unbuiltAddress = await CompleteAddress.random();

    await expect(
      requestArgs(unbuilt.getAccount(unbuiltAddress), await transferPayload()),
    ).rejects.toThrow("no allowlist tree");
  });
});
