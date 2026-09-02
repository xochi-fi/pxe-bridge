import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  assertAztecAddress,
  assertBridgeAmount,
  claimFeeJuiceFor,
  topUpFeeJuice,
  type ClaimingWallet,
} from "../src/fee-juice.js";
import {
  AztecClient,
  FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR,
  deriveAccountKeys,
} from "../src/aztec-client.js";
import type { FeeJuiceClaim } from "../src/types.js";
import type { SpendingLimitConfig } from "../src/spending-limit-account.js";

// Test-only keys well under the BN254 Fr modulus -- never use with real funds.
const KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";
// The salt derivation hashes the key and the digest lands above the modulus for
// this one, which is the case Fr.fromBufferReduce exists to absorb.
const OVERFLOWING_SALT_KEY = "0x000000000000000000000000000000000000000000000000000000000000d00d";

const FR_MODULUS = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");

const RECIPIENT = "0x" + "11".repeat(32);
const PAYER = "0x" + "22".repeat(32);

const CLAIM: FeeJuiceClaim = {
  claimAmount: "1000000000000000000",
  claimSecret: "0x" + "33".repeat(32),
  messageLeafIndex: "0",
};

const SPENDING_LIMITS: SpendingLimitConfig = {
  maxAmountPerTx: 1_000n,
  dailyLimit: 10_000n,
  admin: "0x" + "0a".repeat(32),
  token: "0x" + "0b".repeat(32),
  allowlistSeed: "0x" + "07".repeat(32),
  allowlistRecipients: [{ address: RECIPIENT, index: 0 }],
};

/** The salt the bridge derives, computed independently of the code under test. */
function expectedSalt(key: string): bigint {
  const keyBytes = Buffer.alloc(32);
  Buffer.from(key.replace(/^0x/, ""), "hex").copy(keyBytes, 0);
  return (
    BigInt(
      "0x" +
        createHash("sha256")
          .update(Buffer.from("pxe-bridge-account-salt-v1"))
          .update(keyBytes)
          .digest("hex"),
    ) % FR_MODULUS
  );
}

describe("fee juice argument checks", () => {
  // Nothing recovers juice bridged to a mistyped address: the message commits
  // to its recipient and FeeJuice has no transfer. So these run before the L1
  // write, not after it.
  it("rejects an address that is not 32-byte hex", () => {
    expect(() => assertAztecAddress("recipient", "0x1234")).toThrow("32-byte hex");
    expect(() => assertAztecAddress("recipient", RECIPIENT.slice(2))).toThrow("32-byte hex");
    expect(() => assertAztecAddress("recipient", "")).toThrow("32-byte hex");
  });

  it("names the offending argument", () => {
    expect(() => assertAztecAddress("payer", "nope")).toThrow(/^payer /);
  });

  it("accepts a well-formed address in either case", () => {
    expect(() => assertAztecAddress("recipient", RECIPIENT)).not.toThrow();
    expect(() => assertAztecAddress("recipient", "0x" + "AB".repeat(32))).not.toThrow();
  });

  it("rejects an amount that credits nothing", () => {
    expect(() => assertBridgeAmount(0n)).toThrow("positive");
    expect(() => assertBridgeAmount(-1n)).toThrow("positive");
  });

  it("rejects an amount the contract cannot hold", () => {
    expect(() => assertBridgeAmount(1n << 128n)).toThrow("2^128");
    expect(() => assertBridgeAmount((1n << 128n) - 1n)).not.toThrow();
  });
});

describe("fee juice top-up ordering", () => {
  // The node URL below is unreachable on purpose. Reaching it at all would mean
  // the L1 write had been attempted with an argument already known to be bad.
  const UNREACHABLE = "http://127.0.0.1:1";

  it("checks the payer before bridging anything", async () => {
    await expect(
      topUpFeeJuice({
        nodeUrl: UNREACHABLE,
        l1RpcUrl: UNREACHABLE,
        l1PrivateKey: "0x" + "44".repeat(32),
        recipient: RECIPIENT,
        amount: 1n,
        wallet: undefined as unknown as ClaimingWallet,
        payer: "not-an-address",
      }),
    ).rejects.toThrow("payer must be a 32-byte hex Aztec address");
  });

  it("checks the recipient before bridging anything", async () => {
    await expect(
      topUpFeeJuice({
        nodeUrl: UNREACHABLE,
        l1RpcUrl: UNREACHABLE,
        l1PrivateKey: "0x" + "44".repeat(32),
        recipient: "0xdeadbeef",
        amount: 1n,
        wallet: undefined as unknown as ClaimingWallet,
        payer: PAYER,
      }),
    ).rejects.toThrow("recipient must be a 32-byte hex Aztec address");
  });

  it("checks addresses before touching the wallet", async () => {
    await expect(
      claimFeeJuiceFor({
        wallet: undefined as unknown as ClaimingWallet,
        payer: PAYER,
        recipient: "0xdeadbeef",
        claim: CLAIM,
      }),
    ).rejects.toThrow("recipient must be a 32-byte hex Aztec address");
  });
});

describe("account derivation", () => {
  it("is deterministic", async () => {
    const first = await deriveAccountKeys(KEY);
    const second = await deriveAccountKeys(KEY);

    expect(first.secret.toString()).toBe(second.secret.toString());
    expect(first.salt.toString()).toBe(second.salt.toString());
    expect(first.signingKey.toString()).toBe(second.signingKey.toString());
  });

  it("accepts a key with or without the 0x prefix", async () => {
    const prefixed = await deriveAccountKeys(KEY);
    const bare = await deriveAccountKeys(KEY.slice(2));
    expect(bare.salt.toString()).toBe(prefixed.salt.toString());
  });

  it("derives the salt as the digest reduced into the field", async () => {
    const { salt } = await deriveAccountKeys(KEY);
    expect(salt.toBigInt()).toBe(expectedSalt(KEY));
  });

  // ~81% of keys hash to a digest above the modulus. Fr.fromBuffer threw for
  // every one of them, which took out connect() before anything was deployed.
  it("reduces a salt digest that overflows the field", async () => {
    const { salt } = await deriveAccountKeys(OVERFLOWING_SALT_KEY);

    const raw = BigInt(
      "0x" +
        createHash("sha256")
          .update(Buffer.from("pxe-bridge-account-salt-v1"))
          .update(Buffer.from(OVERFLOWING_SALT_KEY.slice(2), "hex"))
          .digest("hex"),
    );
    expect(raw).toBeGreaterThanOrEqual(FR_MODULUS);
    expect(salt.toBigInt()).toBe(raw % FR_MODULUS);
  });
});

describe("fee juice claim against the spending limit account", () => {
  // A claim is bridged to the account it names, so buildFeePaymentMethod hands
  // the deploy a FeeJuicePaymentMethodWithClaim naming the limit account while
  // the deploy is sent from the deployer. completeFeeOptions then gives the
  // deployer's entrypoint EXTERNAL rather than FEE_JUICE_WITH_CLAIM, and
  // claim_and_end_setup never calls set_as_fee_payer, so the transaction ends
  // up with no fee payer at all. Refused up front instead.
  it("refuses the combination", () => {
    expect(() => new AztecClient("http://localhost:8080", KEY, CLAIM, SPENDING_LIMITS)).toThrow(
      FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR,
    );
  });

  it("points at the script that does work", () => {
    expect(FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR).toContain("scripts/top-up-fee-juice.ts");
  });

  it("allows a claim on the plain Schnorr path", () => {
    expect(() => new AztecClient("http://localhost:8080", KEY, CLAIM)).not.toThrow();
  });

  it("allows the spending limit account without a claim", () => {
    expect(
      () => new AztecClient("http://localhost:8080", KEY, undefined, SPENDING_LIMITS),
    ).not.toThrow();
  });
});
