import { describe, it, expect } from "vitest";
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { CompleteAddress } from "@aztec/stdlib/contract";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import {
  SpendingLimitAccountContract,
  ALLOWLIST_SIZE,
  type SpendingLimitConfig,
} from "../src/spending-limit-account.js";

/**
 * The declaration must reach the entrypoint that actually builds the request.
 *
 * The SDK resolves the account through AccountContract.getAccount() and does
 * not memoize, so several entrypoints exist per connection and the one the
 * bridge writes to is not necessarily the one that signs. When the declaration
 * lived on the entrypoint instance the payload carried (0, zero address) and
 * every transfer died on-chain in assert_single_call_matches with "Transfer
 * does not match declared spending".
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

const RECIPIENT = "0x" + "11".repeat(32);
const AMOUNT = 500_000_000_000_000_000_000n;

const config: SpendingLimitConfig = {
  maxAmountPerTx: 1_000_000_000_000_000_000_000n,
  dailyLimit: 5_000_000_000_000_000_000_000n,
  admin: "0x" + "aa".repeat(32),
  token: "0x" + "bb".repeat(32),
  seedRecipient: RECIPIENT,
  minAnonymitySet: 1,
};

function allowlistHint(): string[] {
  const hint = new Array<string>(ALLOWLIST_SIZE).fill("0x" + "0".repeat(64));
  hint[0] = RECIPIENT;
  return hint;
}

async function encodedEntrypointArgs(
  account: import("@aztec/aztec.js/account").Account,
): Promise<Fr[]> {
  const payload = await account.wrapExecutionPayload(
    ExecutionPayload.empty(),
    { chainId: new Fr(31337), version: new Fr(1) },
    {
      cancellable: false,
      txNonce: Fr.ZERO,
      feePaymentMethodOptions: 0,
    } as Parameters<typeof account.wrapExecutionPayload>[2],
  );
  const call = payload.calls[0];
  expect(call).toBeDefined();
  return call!.args;
}

describe("SpendingLimitAccountContract declaration binding", () => {
  const signingKey = GrumpkinScalar.fromString(
    "0x" + "0".repeat(63) + "7",
  );

  async function newContract(): Promise<{
    contract: SpendingLimitAccountContract;
    address: CompleteAddress;
  }> {
    const contract = new SpendingLimitAccountContract(signingKey, config);
    const address = await CompleteAddress.random();
    return { contract, address };
  }

  it("binds the declaration into the entrypoint args", async () => {
    const { contract, address } = await newContract();
    contract.setDeclaredSpending(AMOUNT, RECIPIENT, allowlistHint());

    const args = await encodedEntrypointArgs(contract.getAccount(address));

    expect(args[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(AMOUNT);
    expect(args[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(RECIPIENT);
    expect(args[ALLOWLIST_HINT_OFFSET]!.toString()).toBe(RECIPIENT);
  });

  // The regression. getAccount() is called during connect() and again on every
  // wallet resolution, so an account handed out before the declaration is set
  // is routinely the one that signs.
  it("binds the declaration into accounts created before it was set", async () => {
    const { contract, address } = await newContract();
    const early = contract.getAccount(address);

    contract.setDeclaredSpending(AMOUNT, RECIPIENT, allowlistHint());

    const args = await encodedEntrypointArgs(early);
    expect(args[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(AMOUNT);
    expect(args[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(RECIPIENT);
  });

  it("shows every outstanding account the same declaration", async () => {
    const { contract, address } = await newContract();
    const first = contract.getAccount(address);
    contract.setDeclaredSpending(AMOUNT, RECIPIENT, allowlistHint());
    const second = contract.getAccount(address);

    const firstArgs = await encodedEntrypointArgs(first);
    const secondArgs = await encodedEntrypointArgs(second);

    expect(firstArgs[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(
      secondArgs[DECLARED_AMOUNT_OFFSET]!.toBigInt(),
    );
    expect(firstArgs[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(
      secondArgs[DECLARED_RECIPIENT_OFFSET]!.toString(),
    );
  });

  it("carries a redeclaration to an account already handed out", async () => {
    const { contract, address } = await newContract();
    contract.setDeclaredSpending(AMOUNT, RECIPIENT, allowlistHint());
    const account = contract.getAccount(address);

    const other = "0x" + "22".repeat(32);
    const hint = allowlistHint();
    hint[1] = other;
    contract.setDeclaredSpending(1n, other, hint);

    const args = await encodedEntrypointArgs(account);
    expect(args[DECLARED_AMOUNT_OFFSET]!.toBigInt()).toBe(1n);
    expect(args[DECLARED_RECIPIENT_OFFSET]!.toString()).toBe(other);
    expect(args[ALLOWLIST_HINT_OFFSET + 1]!.toString()).toBe(other);
  });

  it("rejects an allowlist hint of the wrong length", async () => {
    const { contract } = await newContract();
    expect(() => contract.setDeclaredSpending(AMOUNT, RECIPIENT, [])).toThrow(
      `allowlistHint must have ${ALLOWLIST_SIZE} entries`,
    );
  });
});
