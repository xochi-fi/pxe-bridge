import type { FeeJuiceClaim } from "../../src/types.js";
import { FeeJuiceClaimSchema } from "../../src/types.js";
import { topUpFeeJuice, type ClaimingWallet } from "../../src/fee-juice.js";
import { headroomGasSettings } from "../../src/aztec-client.js";

export interface E2EConfig {
  nodeUrl: string;
  secretKey: string;
  bridgePort: number;
  feeJuiceClaim?: FeeJuiceClaim;
}

// Test-only key well under BN254 Fr modulus -- never use with real funds
const DEFAULT_SECRET_KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";

/**
 * The account that mints tokens and pays for other accounts' fee juice.
 *
 * Distinct from the bridge key so the two accounts do not collide, and shared
 * between global-setup and the spending-limit suite so the second one to
 * connect recovers the account rather than deploying a second funder. An extra
 * deployment is not free here: it raises the sandbox base fee, which is what
 * `headroomGasSettings` exists to absorb.
 */
export const FUNDER_KEY = "0x000000000000000000000000000000000000000000000000000000000000cafe";

/** One resolution for the node URL, shared by getTestConfig and the fee helper. */
export function resolveNodeUrl(): string {
  return process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
}

export function getTestConfig(): E2EConfig {
  let feeJuiceClaim: FeeJuiceClaim | undefined;
  const raw = process.env["FEE_JUICE_CLAIM"];
  if (raw) {
    const parsed = FeeJuiceClaimSchema.safeParse(JSON.parse(raw));
    if (parsed.success) feeJuiceClaim = parsed.data;
  }

  return {
    nodeUrl: resolveNodeUrl(),
    secretKey: process.env["PXE_BRIDGE_SECRET_KEY"] ?? DEFAULT_SECRET_KEY,
    bridgePort: 0, // let OS pick
    // Spread rather than assign: exactOptionalPropertyTypes distinguishes an
    // absent key from one set to undefined, and E2EConfig declares it optional.
    ...(feeJuiceClaim ? { feeJuiceClaim } : {}),
  };
}

/**
 * The token global-setup provisioned, or a failure explaining why there is not
 * one.
 *
 * Throwing rather than skipping is the point. Both note suites used to guard on
 * `it.skipIf(!process.env.E2E_TOKEN_ADDRESS)` against a variable that was set
 * nowhere in the repo, so the default createNote path never executed and CI
 * stayed green over it for the whole life of the branch. A skip is invisible in
 * a passing run; a throw is not.
 */
export function requireTestToken(): string {
  const token = process.env["E2E_TOKEN_ADDRESS"];
  if (token) return token;

  const reason = process.env["E2E_TOKEN_SETUP_ERROR"];
  throw new Error(
    reason
      ? `global-setup could not provision a test token: ${reason}`
      : "E2E_TOKEN_ADDRESS is unset and global-setup recorded no failure, so " +
        "provisioning did not run or did not reach this process",
  );
}

export async function waitForNode(url: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  const statusUrl = url.replace(/\/$/, "") + "/status";

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(statusUrl);
      if (res.ok) return;
    } catch {
      // node not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Aztec node at ${url} did not become ready within ${timeoutMs}ms`);
}

/**
 * The `fee` option every e2e send should use: sponsored payment plus the same
 * predicted-fee headroom the deploy path applies.
 *
 * Sends here took the SDK's default gas settings, which are a point prediction.
 * `rejects apply_limits from a non-admin` deploys an account of its own and
 * then sends against an estimate made before that deployment moved the base
 * fee, so it failed validation with "maxFeesPerGas.feePerL2Gas must be greater
 * than or equal to gasFees.feePerL2Gas". Intermittent, and the last open flake
 * on the branch. The deploy path already solved this; the sends never got it.
 *
 * View simulations need it too, which the first fix missed because a view pays
 * nothing so the fee looked irrelevant. It is not: the node validates
 * maxFeesPerGas against the live base fee before executing, so `balanceOf` in
 * spending-limit.test.ts failed the same way at 45909093 against 73600000 on
 * 2026-09-02, after 20 of 21 tests had passed. Every simulate() in the suite
 * passes this now.
 */
export async function feeWithHeadroom(wallet: unknown): Promise<{
  paymentMethod: import("@aztec/aztec.js/fee").FeePaymentMethod;
  gasSettings: Awaited<ReturnType<typeof headroomGasSettings>>;
}> {
  return {
    paymentMethod: await sponsoredFee(wallet),
    gasSettings: await headroomGasSettings(resolveNodeUrl()),
  };
}

/**
 * SponsoredFPC payment method, so a test account with no fee juice can still
 * send transactions. The bridge uses the same mechanism for its own account
 * deployment; without it every send() fails with "Not enough balance for fee
 * payer to pay for transaction".
 */
export async function sponsoredFee(
  wallet: unknown,
): Promise<import("@aztec/aztec.js/fee").FeePaymentMethod> {
  const { SponsoredFPCContract } = await import("@aztec/noir-contracts.js/SponsoredFPC");
  const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee/testing");
  const { getContractInstanceFromInstantiationParams } = await import("@aztec/stdlib/contract");
  const { Fr } = await import("@aztec/aztec.js/fields");

  const instance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await (wallet as {
    registerContract: (i: unknown, a: unknown) => Promise<unknown>;
  }).registerContract(instance, SponsoredFPCContract.artifact);
  return new SponsoredFeePaymentMethod(instance.address);
}

// Anvil's first default account. docker-compose starts anvil with the stock
// mnemonic, so this key is funded on L1 and is test-only by construction.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const L1_RPC = process.env["L1_RPC_URL"] ?? "http://localhost:8545";

// An idle sandbox may not build a block on its own, so every wait here drives
// one instead of sleeping. Twelve is plenty for a healthy node and keeps a
// broken one failing in minutes rather than in the beforeAll timeout.
const SANDBOX_WAIT_ATTEMPTS = 12;

/**
 * Gives `recipient` a fee juice balance, bridging from L1 and then claiming on
 * its behalf from `wallet`.
 *
 * The mechanism and the reason it has to work this way live in
 * `src/fee-juice.ts`, which the bridge's own top-up script also uses. What is
 * specific here is the sandbox: Anvil's key funds the L1 side, blocks are
 * driven rather than waited for, and the payer pays via SponsoredFPC because a
 * sandbox account has no fee juice until somebody bridges it some.
 */
export async function fundFeeJuice(
  nodeUrl: string,
  wallet: unknown,
  payer: string,
  recipient: string,
  amount: bigint,
  onBlockNeeded: () => Promise<void>,
): Promise<void> {
  await topUpFeeJuice({
    nodeUrl,
    l1RpcUrl: L1_RPC,
    l1PrivateKey: ANVIL_KEY,
    recipient,
    amount,
    onBlockNeeded,
    attempts: SANDBOX_WAIT_ATTEMPTS,
    wallet: wallet as ClaimingWallet,
    payer,
    paymentMethod: await sponsoredFee(wallet),
  });
}

/**
 * Sends one cheap transaction, so the sequencer builds an L2 block. Mints are
 * the cheapest thing the funder is already able to do.
 */
export async function mintOne(
  wallet: unknown,
  token: string,
  minter: string,
): Promise<void> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const minterAddress = AztecAddress.fromStringUnsafe(minter);
  const contract = await (
    TokenContract as unknown as {
      at: (a: unknown, w: unknown) => Promise<{
        methods: Record<
          string,
          (...a: unknown[]) => { send: (o: { from: unknown; fee: unknown }) => Promise<unknown> }
        >;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(token), wallet);

  await contract.methods["mint_to_public"]!(minterAddress, 1n).send({
    from: minterAddress,
    fee: await feeWithHeadroom(wallet),
  });
}

/**
 * Mints `amount` of `token` into `to`'s PUBLIC balance.
 *
 * Public and not private, deliberately. transfer_to_private moves the sender's
 * public balance into a private note for the recipient, so the sending account
 * has to be funded publicly. Minting to private leaves the public balance at
 * zero and the transfer fails inside the token with "attempt to subtract with
 * overflow".
 */
export async function mintTo(
  wallet: unknown,
  token: string,
  to: string,
  amount: bigint,
  minter: string,
): Promise<void> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const contract = await (
    TokenContract as unknown as {
      at: (a: unknown, w: unknown) => Promise<{
        methods: Record<
          string,
          (...a: unknown[]) => { send: (o: { from: unknown; fee: unknown }) => Promise<unknown> }
        >;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(token), wallet);

  await contract.methods["mint_to_public"]!(
    AztecAddress.fromStringUnsafe(to),
    amount,
  ).send({
    from: AztecAddress.fromStringUnsafe(minter),
    fee: await feeWithHeadroom(wallet),
  });
}

/**
 * Deploys an 18-decimal test token with `admin` as its minter.
 *
 * v5.1.0 requires an explicit `from` on send(), and send() resolves to
 * { contract, instance, receipt } after waiting -- not to the contract itself.
 * Both mismatches went unnoticed while this helper had no caller, which is what
 * E2E_TOKEN_ADDRESS being set nowhere used to mean.
 */
export async function deployTestToken(wallet: unknown, admin: string): Promise<string> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const adminAddress = AztecAddress.fromStringUnsafe(admin);

  const { contract } = await (
    TokenContract as unknown as {
      deploy: (
        wallet: unknown,
        admin: unknown,
        name: string,
        symbol: string,
        decimals: number,
      ) => {
        send: (o: { from: unknown; fee: unknown }) => Promise<{
          contract: { address: { toString: () => string } };
        }>;
      };
    }
  )
    .deploy(wallet, adminAddress, "TestToken", "TST", 18)
    .send({ from: adminAddress, fee: await feeWithHeadroom(wallet) });

  return contract.address.toString();
}
