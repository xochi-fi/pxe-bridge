import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAztecAddress,
  assertBridgeAmount,
  claimFeeJuiceFor,
  findPendingDeposit,
  isDepositOf,
  pendingDepositPath,
  recoverFeeJuiceClaim,
  topUpFeeJuice,
  writePendingDeposit,
  type ClaimingWallet,
  type PendingFeeJuiceDeposit,
} from "../src/fee-juice.js";
import {
  AztecClient,
  DEPLOYER_CLAIM_WITHOUT_SPENDING_LIMIT_ERROR,
  FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR,
  deriveAccountKeys,
  deriveDeployerKeys,
  feeJuiceMessageHash,
  sponsoredFpcSetting,
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

describe("fee juice deposit recovery", () => {
  const UNREACHABLE = "http://127.0.0.1:1";
  const SECRET_HASH = "0x" + "0a".repeat(32);
  const deposit = { recipient: "0x" + "AB".repeat(32), claimAmount: "1000", secretHash: SECRET_HASH };

  // The event decodes bytes32 lowercase. A case-sensitive compare would read
  // a mined deposit as missing, and the operator would bridge a second time.
  it("matches the deposit regardless of hex case", () => {
    expect(
      isDepositOf({ to: "0x" + "ab".repeat(32), amount: 1000n, secretHash: "0x" + "0A".repeat(32) }, deposit),
    ).toBe(true);
  });

  // Anyone can deposit to the recipient, and the secret hash is public once
  // the first deposit is mined. Only the exact deposit is recovered.
  it("rejects a deposit with another amount or secret hash", () => {
    const to = deposit.recipient;
    expect(isDepositOf({ to, amount: 999n, secretHash: SECRET_HASH }, deposit)).toBe(false);
    expect(isDepositOf({ to, amount: 1000n, secretHash: "0x" + "0b".repeat(32) }, deposit)).toBe(false);
    expect(isDepositOf({ to: "0x" + "cd".repeat(32), amount: 1000n, secretHash: SECRET_HASH }, deposit)).toBe(false);
    expect(isDepositOf({}, deposit)).toBe(false);
  });

  // A secret that does not produce the hash can claim nothing the scan finds,
  // and the scan would report the deposit as unmined.
  it("rejects a secret that does not hash to the secret hash before any lookup", async () => {
    await expect(
      recoverFeeJuiceClaim({
        nodeUrl: UNREACHABLE,
        l1RpcUrl: UNREACHABLE,
        recipient: RECIPIENT,
        amount: 1n,
        claimSecret: "0x" + "01".repeat(32),
        secretHash: SECRET_HASH,
        fromBlock: 0n,
      }),
    ).rejects.toThrow(`hashes to`);
  });
});

describe("pending deposit file", () => {
  const SECRET_HASH = "0x" + "0A".repeat(32);
  const pending: PendingFeeJuiceDeposit = {
    recipient: "0x" + "ab".repeat(32),
    claimAmount: "1000",
    claimSecret: "0x" + "01".repeat(32),
    secretHash: SECRET_HASH,
    l1FromBlock: "42",
    l1Sender: "0x" + "cd".repeat(20),
  };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxe-bridge-deposit-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // It holds the claim secret.
  it("is written owner-only", () => {
    const path = writePendingDeposit(pending, dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // A second deposit under the same secret hash would make the first
  // unrecoverable.
  it("is never overwritten", () => {
    writePendingDeposit(pending, dir);
    expect(() => writePendingDeposit({ ...pending, claimAmount: "1" }, dir)).toThrow(/EEXIST/);
  });

  it("is found by its path or by its secret hash in any case", () => {
    const path = writePendingDeposit(pending, dir);
    expect(findPendingDeposit(path)).toEqual({ path, deposit: pending });
    expect(findPendingDeposit(SECRET_HASH.toLowerCase(), dir)?.deposit).toEqual(pending);
  });

  // The hash form falls back to the env-supplied secret.
  it("is absent for a secret hash with no file", () => {
    expect(findPendingDeposit(SECRET_HASH, dir)).toBeUndefined();
  });

  it("rejects a missing path or a malformed file", () => {
    expect(() => findPendingDeposit(join(dir, "nope.json"))).toThrow(/Cannot read deposit file/);
    const path = pendingDepositPath(SECRET_HASH, dir);
    writeFileSync(path, JSON.stringify({ ...pending, claimSecret: "0x01" }));
    expect(() => findPendingDeposit(SECRET_HASH, dir)).toThrow(/claimSecret/);
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

describe("deployer fee juice claim", () => {
  // The deployer is an address an operator bridges to before the bridge ever
  // runs, and a claim commits to that address. Any drift in this derivation
  // strands what was bridged, and moves the deployer of every existing bridge.
  it("derives the deployer at the account salt plus one, same secret", async () => {
    const account = await deriveAccountKeys(OVERFLOWING_SALT_KEY);
    const deployer = await deriveDeployerKeys(OVERFLOWING_SALT_KEY);
    expect(deployer.salt.toBigInt()).toBe(account.salt.toBigInt() + 1n);
    expect(deployer.secret.toString()).toBe(account.secret.toString());
    expect(deployer.signingKey.toString()).toBe(account.signingKey.toString());
  });

  // A plain Schnorr bridge never derives a deployer, so the claim would sit
  // unconsumed while the operator believed the deploy was paid for.
  it("is refused without the spending limit account", () => {
    expect(
      () => new AztecClient("http://localhost:8080", KEY, undefined, undefined, CLAIM),
    ).toThrow(DEPLOYER_CLAIM_WITHOUT_SPENDING_LIMIT_ERROR);
  });

  it("is accepted with the spending limit account", () => {
    expect(
      () => new AztecClient("http://localhost:8080", KEY, undefined, SPENDING_LIMITS, CLAIM),
    ).not.toThrow();
  });
});

describe("SponsoredFPC deployment fee fallback", () => {
  // SponsoredFPC exists only on sandbox and testnet. The image sets
  // NODE_ENV=production everywhere, so production needs an explicit opt-in
  // rather than the fallback being taken on any network by default.
  it("is refused in production by default", () => {
    expect(sponsoredFpcSetting({ NODE_ENV: "production" }).allowed).toBe(false);
  });

  it("is permitted in production on explicit opt-in", () => {
    expect(
      sponsoredFpcSetting({ NODE_ENV: "production", PXE_BRIDGE_ALLOW_SPONSORED_FPC: "true" }).allowed,
    ).toBe(true);
  });

  it("is permitted outside production, where the sandbox runs", () => {
    expect(sponsoredFpcSetting({}).allowed).toBe(true);
    expect(sponsoredFpcSetting({ NODE_ENV: "development" }).allowed).toBe(true);
  });

  it("can be switched off outside production", () => {
    expect(
      sponsoredFpcSetting({ NODE_ENV: "development", PXE_BRIDGE_ALLOW_SPONSORED_FPC: "false" }).allowed,
    ).toBe(false);
  });

  // Logged when the fallback is taken, so an operator can tell a deliberate
  // opt-in from a missing NODE_ENV.
  it("names the variable that decided", () => {
    expect(
      sponsoredFpcSetting({ NODE_ENV: "production", PXE_BRIDGE_ALLOW_SPONSORED_FPC: "true" }).reason,
    ).toBe("PXE_BRIDGE_ALLOW_SPONSORED_FPC=true");
    expect(sponsoredFpcSetting({}).reason).toBe("NODE_ENV=(unset)");
    expect(sponsoredFpcSetting({ NODE_ENV: "development" }).reason).toBe("NODE_ENV=development");
  });

  // "1" or "yes" meaning neither would be a silent choice either way.
  it("rejects any value other than true or false", () => {
    expect(() =>
      sponsoredFpcSetting({ NODE_ENV: "production", PXE_BRIDGE_ALLOW_SPONSORED_FPC: "1" }),
    ).toThrow(/PXE_BRIDGE_ALLOW_SPONSORED_FPC must be "true" or "false"/);
  });

  // `VAR=` in an env file is a setting someone wrote, not an absence.
  it("rejects an empty value", () => {
    expect(() =>
      sponsoredFpcSetting({ NODE_ENV: "development", PXE_BRIDGE_ALLOW_SPONSORED_FPC: "" }),
    ).toThrow(/PXE_BRIDGE_ALLOW_SPONSORED_FPC must be "true" or "false", got ""/);
  });
});

// The bridge rebuilds this hash to tell a spent deployer claim from an unspent
// one; the bridge-fee-juice path reads it off the Inbox's MessageSent event
// instead. This mirrors the Solidity that emits that event, so a sender or
// encoding drift fails here rather than as a startup throw on a live node.
describe("deployer claim message hash", () => {
  const sha256ToField = (data: Buffer): Buffer =>
    Buffer.concat([Buffer.alloc(1), createHash("sha256").update(data).digest().subarray(0, 31)]);
  const word = (value: bigint): Buffer => Buffer.from(value.toString(16).padStart(64, "0"), "hex");

  it("matches the leaf Inbox.sendL2Message inserts for a FeeJuicePortal deposit", async () => {
    const { Fr } = await import("@aztec/aztec.js/fields");
    const { computeSecretHash } = await import("@aztec/stdlib/hash");
    const l1ChainId = 31337;
    const rollupVersion = 1234567;
    const claim: FeeJuiceClaim = { ...CLAIM, claimSecret: "0x" + "0c".repeat(32), messageLeafIndex: "77" };

    // FeeJuicePortal.depositToAztecPublic: abi.encodeWithSignature("claim(bytes32,uint256)", to, amount).
    const content = sha256ToField(
      Buffer.concat([
        Buffer.from("63f44968", "hex"),
        Buffer.from(RECIPIENT.slice(2), "hex"),
        word(BigInt(claim.claimAmount)),
      ]),
    );
    // Inbox.sendL2Message: sender rewritten to address(FEE_JUICE_ADDRESS) = 3,
    // recipient L2Actor(FEE_JUICE_ADDRESS, VERSION), then Hash.sha256ToField(abi.encode(...)).
    const leaf = sha256ToField(
      Buffer.concat([
        word(3n),
        word(BigInt(l1ChainId)),
        word(3n),
        word(BigInt(rollupVersion)),
        content,
        (await computeSecretHash(Fr.fromString(claim.claimSecret))).toBuffer(),
        word(77n),
      ]),
    );

    expect(await feeJuiceMessageHash(RECIPIENT, claim, l1ChainId, rollupVersion)).toBe(
      "0x" + leaf.toString("hex"),
    );
  });
});
