import { describe, it, expect } from "vitest";
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { CompleteAddress } from "@aztec/stdlib/contract";
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec/stdlib/abi";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { GasSettings } from "@aztec/stdlib/gas";
import {
  SpendingLimitAccountContract,
  ALLOWLIST_SIZE,
  TRANSFER_TO_PRIVATE_SELECTOR,
  TRANSFER_TO_PRIVATE_SIGNATURE,
  type SpendingLimitConfig,
} from "../src/spending-limit-account.js";

/**
 * The entrypoint must declare what the payload actually transfers.
 *
 * The declaration used to be pushed onto the contract object before each send,
 * which made it a second source of truth that could disagree with the payload:
 * two overlapping sends each set it and whichever built second signed the
 * other's values. It is now read out of the call being signed, so these tests
 * check the derivation rather than the plumbing.
 *
 * Offsets into the encoded entrypoint args, from getEntrypointAbi():
 *   0..30  AppPayload   ([FunctionCall; 5] at 6 fields each, then tx_nonce)
 *   31     fee_payment_method
 *   32     cancellable
 *   33     declared_amount
 *   34     declared_recipient
 *   35..42 allowlist_hint
 */
const DECLARED_AMOUNT_OFFSET = 33;
const DECLARED_RECIPIENT_OFFSET = 34;
const ALLOWLIST_HINT_OFFSET = 35;

// All four must be BN254 field elements, so the leading byte stays below the
// modulus's 0x30. The old 0xaa/0xbb values only worked because nothing ever
// converted them to a field.
const RECIPIENT = "0x" + "11".repeat(32);
const OTHER_RECIPIENT = "0x" + "22".repeat(32);
const TOKEN = "0x" + "0b".repeat(32);
const AMOUNT = 500_000_000_000_000_000_000n;

const config: SpendingLimitConfig = {
  maxAmountPerTx: 1_000_000_000_000_000_000_000n,
  dailyLimit: 5_000_000_000_000_000_000_000n,
  admin: "0x" + "0a".repeat(32),
  token: TOKEN,
  seedRecipient: RECIPIENT,
  minAnonymitySet: 1,
};

function allowlistHint(): string[] {
  const hint = new Array<string>(ALLOWLIST_SIZE).fill("0x" + "0".repeat(64));
  hint[0] = RECIPIENT;
  return hint;
}

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

  async function newContract(): Promise<{
    contract: SpendingLimitAccountContract;
    address: CompleteAddress;
  }> {
    const contract = new SpendingLimitAccountContract(signingKey, config);
    const address = await CompleteAddress.random();
    return { contract, address };
  }

  // Pins the same constant main.nr's transfer_to_private_selector_pin does. A
  // typo in the signature string would otherwise make deriveDeclaration find
  // no transfer and reject every send.
  it("derives the selector main.nr pins", async () => {
    const selector = await FunctionSelector.fromSignature(TRANSFER_TO_PRIVATE_SIGNATURE);
    expect(selector.toString()).toBe(TRANSFER_TO_PRIVATE_SELECTOR);
  });

  it("declares what the payload transfers", async () => {
    const { contract, address } = await newContract();
    contract.setAllowlistHint(allowlistHint());

    const args = await requestArgs(contract.getAccount(address), await transferPayload());

    expect(args[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(AMOUNT);
    expect(args[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(RECIPIENT);
    expect(args[ALLOWLIST_HINT_OFFSET]!.toString()).toBe(RECIPIENT);
  });

  // The property the whole design turns on. Two sends built from different
  // payloads cannot declare each other's values, because neither has anywhere
  // to write a declaration the other could read.
  it("keeps concurrent sends from declaring each other's values", async () => {
    const { contract, address } = await newContract();
    contract.setAllowlistHint(allowlistHint());
    const account = contract.getAccount(address);

    const [first, second] = await Promise.all([
      requestArgs(account, await transferPayload(RECIPIENT, AMOUNT)),
      requestArgs(account, await transferPayload(OTHER_RECIPIENT, 1n)),
    ]);

    expect(first[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(AMOUNT);
    expect(first[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(RECIPIENT);
    expect(second[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(1n);
    expect(second[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(OTHER_RECIPIENT);
  });

  // getAccount() is called during connect() and again on every wallet
  // resolution, so an account handed out before the hint was set is routinely
  // the one that signs.
  it("shows an account created earlier the current allowlist hint", async () => {
    const { contract, address } = await newContract();
    const early = contract.getAccount(address);

    contract.setAllowlistHint(allowlistHint());

    const args = await requestArgs(early, await transferPayload());
    expect(args[ALLOWLIST_HINT_OFFSET]!.toString()).toBe(RECIPIENT);
  });

  it("carries a re-read allowlist to an account already handed out", async () => {
    const { contract, address } = await newContract();
    contract.setAllowlistHint(allowlistHint());
    const account = contract.getAccount(address);

    const grown = allowlistHint();
    grown[1] = OTHER_RECIPIENT;
    contract.setAllowlistHint(grown);

    const args = await requestArgs(account, await transferPayload());
    expect(args[ALLOWLIST_HINT_OFFSET + 1]!.toString()).toBe(OTHER_RECIPIENT);
  });

  // Both entrypoint methods build their args through buildEntrypointArgs now,
  // but they still assemble different envelopes around it. Only
  // createTxExecutionRequest is on the bridge's path today; this keeps the
  // other honest rather than leaving it silently untested.
  it("encodes the same declaration on both entrypoint paths", async () => {
    const { contract, address } = await newContract();
    contract.setAllowlistHint(allowlistHint());
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
  it("refuses a payload with no transfer to declare", async () => {
    const { contract, address } = await newContract();
    contract.setAllowlistHint(allowlistHint());

    await expect(
      requestArgs(contract.getAccount(address), ExecutionPayload.empty()),
    ).rejects.toThrow("requires exactly one");
  });

  it("refuses a payload with two transfers", async () => {
    const { contract, address } = await newContract();
    contract.setAllowlistHint(allowlistHint());
    const exec = new ExecutionPayload(
      [await transferCall(RECIPIENT, AMOUNT), await transferCall(OTHER_RECIPIENT, 1n)],
      [],
      [],
      [],
    );

    await expect(requestArgs(contract.getAccount(address), exec)).rejects.toThrow(
      "requires exactly one",
    );
  });

  it("rejects an allowlist hint of the wrong length", async () => {
    const { contract } = await newContract();
    expect(() => contract.setAllowlistHint([])).toThrow(
      `allowlistHint must have ${ALLOWLIST_SIZE} entries`,
    );
  });
});
