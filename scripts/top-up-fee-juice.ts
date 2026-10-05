/**
 * Tops up an Aztec account's fee juice balance in one command: bridge from L1,
 * wait for the message, then claim on the account's behalf from a funded payer.
 *
 * This is the supported way to fund the spending-limit account. That account
 * cannot claim for itself and cannot attach any fee payment method to its own
 * transactions, so `FEE_JUICE_CLAIM` -- which the plain Schnorr path consumes
 * during deployment -- is rejected at startup when spending limits are on. See
 * FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR in src/aztec-client.ts.
 *
 * The payer sends the claim transaction and pays its fee from its own balance.
 * It must already be initialized on chain. Two payers, exactly one of which is
 * set:
 *
 *   FEE_JUICE_PAYER_DEPLOYER=true  The spending-limit account's deployer, which
 *       holds whatever its deployer claim left after both deploys. Its key is
 *       the bridge's key, resolved as the bridge resolves it
 *       (PXE_BRIDGE_SECRET_ARN; PXE_BRIDGE_SECRET_KEY outside production).
 *       The wallet stores holding it live under os.tmpdir() and are deleted
 *       on exit, SIGINT and SIGTERM; SIGKILL or a crash leaves them.
 *   FEE_JUICE_PAYER_KEY            A separate plain Schnorr account at the
 *       address the bridge derives from this key. Deploy it by running the
 *       bridge once with this key, without PXE_BRIDGE_SPENDING_LIMIT_ADMIN, and
 *       with FEE_JUICE_CLAIM bridged to the "Account address" it logs.
 *
 * The claim and its message hash are printed as FEE_JUICE_RESUME_CLAIM as soon
 * as the L1 deposit lands. If the wait or the claim transaction fails after
 * that, rerun with FEE_JUICE_RESUME_CLAIM set: it skips the deposit, waits for
 * the message and sends the claim. Rerunning without it deposits again.
 *
 * Usage:
 *   npx tsx scripts/top-up-fee-juice.ts
 *
 * Required env:
 *   FEE_JUICE_RECIPIENT    -- AztecAddress to credit (the bridge logs its own
 *                             as "[pxe-bridge] Account address:")
 *   FEE_JUICE_PAYER_KEY or FEE_JUICE_PAYER_DEPLOYER=true -- see above
 *   L1_PRIVATE_KEY         -- Ethereum private key holding at least BRIDGE_AMOUNT
 *                             of the Fee Juice ERC20 (checked before any L1 write);
 *                             unused with FEE_JUICE_RESUME_CLAIM
 *
 * Optional env:
 *   AZTEC_NODE_URL             -- Aztec node (default: http://localhost:8080)
 *   L1_RPC_URL                 -- Ethereum RPC (default: http://localhost:8545)
 *   L1_CHAIN_ID                -- L1 chain id (default: Anvil's, per the SDK)
 *   BRIDGE_AMOUNT              -- fee juice in wei (default: 1e18)
 *   FEE_JUICE_RESUME_CLAIM     -- JSON printed by an earlier run; skips the L1 deposit
 *   FEE_JUICE_PAYER_SPONSORED  -- "true" to pay via SponsoredFPC instead of the
 *                                 payer's own balance; sandbox and testnet only
 *   FEE_JUICE_MINT             -- "true" to mint BRIDGE_AMOUNT from the L1 faucet
 *                                 first; sandbox only, and BRIDGE_AMOUNT must equal
 *                                 the faucet's fixed mint amount
 */

import { rm } from "node:fs/promises";
import type { AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { deriveAccountKeys, deriveDeployerKeys } from "../src/aztec-client.js";
import type { AccountKeys } from "../src/aztec-client.js";
import {
  assertAztecAddress,
  assertBridgeAmount,
  claimFeeJuiceFor,
  topUpFeeJuice,
  waitForL1ToL2Message,
} from "../src/fee-juice.js";
import type { ClaimingWallet } from "../src/fee-juice.js";
import { resolveSecretKey } from "../src/secrets.js";
import { BridgedFeeJuiceClaimSchema } from "../src/types.js";
import type { BridgedFeeJuiceClaim, FeeJuiceClaim } from "../src/types.js";

/** Whatever EmbeddedWallet.create hands back, without naming the node variant. */
type PayerWallet = Awaited<
  ReturnType<typeof import("@aztec/wallets/embedded").EmbeddedWallet.create>
>;

/** Ends the run with `message`; the runner prints it, deletes the stores and exits 1. */
class ScriptFailure extends Error {}

function fail(message: string): never {
  throw new ScriptFailure(message);
}

// Run LIFO on exit. `graceful` is false on a signal, where wallet.stop() may
// wait on a proof in flight; stores are deleted either way.
type Disposer = (graceful: boolean) => Promise<void>;
const disposers: Disposer[] = [];

async function disposeAll(graceful: boolean): Promise<void> {
  for (let d = disposers.pop(); d; d = disposers.pop()) {
    try {
      await d(graceful);
    } catch (err) {
      console.error("cleanup:", err instanceof Error ? err.message : err);
    }
  }
}

function adoptStore(store: AztecLMDBStoreV2): void {
  disposers.push(async () => {
    try {
      await store.delete();
    } finally {
      // delete() closes first and skips the rm if closing throws.
      await rm(store.dataDirectory, { recursive: true, force: true });
    }
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

/** BigInt() throws a bare SyntaxError that names neither the variable nor the value. */
function parseBigInt(name: string, raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    fail(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
}

function parseResumeClaim(raw: string): BridgedFeeJuiceClaim {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("FEE_JUICE_RESUME_CLAIM is not valid JSON");
  }
  const parsed = BridgedFeeJuiceClaimSchema.safeParse(json);
  if (!parsed.success) {
    fail(`FEE_JUICE_RESUME_CLAIM: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const RECIPIENT = required("FEE_JUICE_RECIPIENT");
  const PAYER_DEPLOYER = process.env["FEE_JUICE_PAYER_DEPLOYER"] === "true";
  const PAYER_KEY = process.env["FEE_JUICE_PAYER_KEY"];
  const L1_PRIVATE_KEY = process.env["L1_PRIVATE_KEY"];
  const RESUME = process.env["FEE_JUICE_RESUME_CLAIM"];
  // Cleared for the same reason AztecClient nulls its own reference: none of
  // these has any further use once read.
  delete process.env["FEE_JUICE_PAYER_KEY"];
  delete process.env["L1_PRIVATE_KEY"];
  delete process.env["FEE_JUICE_RESUME_CLAIM"];

  if (PAYER_DEPLOYER === Boolean(PAYER_KEY)) {
    fail("Set exactly one of FEE_JUICE_PAYER_KEY or FEE_JUICE_PAYER_DEPLOYER=true");
  }

  const AZTEC_NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
  const L1_RPC_URL = process.env["L1_RPC_URL"] ?? "http://localhost:8545";
  const SPONSORED = process.env["FEE_JUICE_PAYER_SPONSORED"] === "true";
  const MINT = process.env["FEE_JUICE_MINT"] === "true";

  const AMOUNT = parseBigInt("BRIDGE_AMOUNT", process.env["BRIDGE_AMOUNT"] ?? "1000000000000000000");

  // Everything checkable is checked here, before a node connection or an L1
  // write. topUpFeeJuice repeats these for callers that are not this script;
  // running them again is about the ordering, not about the checks.
  try {
    assertAztecAddress("FEE_JUICE_RECIPIENT", RECIPIENT);
    assertBridgeAmount(AMOUNT);
  } catch (err) {
    fail((err as Error).message);
  }

  const resume = RESUME ? parseResumeClaim(RESUME) : undefined;
  if (!resume && !L1_PRIVATE_KEY) {
    fail("L1_PRIVATE_KEY is required");
  }

  const L1_CHAIN_ID = process.env["L1_CHAIN_ID"];
  if (L1_CHAIN_ID !== undefined && !/^\d+$/.test(L1_CHAIN_ID)) {
    fail("L1_CHAIN_ID must be a decimal integer");
  }

  let payerKeys: AccountKeys;
  try {
    payerKeys = PAYER_DEPLOYER
      ? await deriveDeployerKeys((await resolveSecretKey()).key)
      : await deriveAccountKeys(PAYER_KEY!);
  } catch (err) {
    fail((err as Error).message);
  }

  const { EmbeddedWallet } = await import("@aztec/wallets/embedded");
  const { openEphemeralStore } = await import("@aztec/kv-store/lmdb-v2");
  const { ContractInitializationStatus } = await import("@aztec/aztec.js/wallet");

  console.log(`Connecting to Aztec node at ${AZTEC_NODE_URL}`);
  // createSchnorrAccount writes the secret and signing key to the wallet DB,
  // and the PXE stores keys derived from them. `ephemeral: true` alone still
  // puts both stores on disk under os.tmpdir() and never deletes them, so the
  // stores are opened here and deleted on exit. Proving on, as in
  // AztecClient: a network that verifies proofs rejects the claim without it.
  const walletStore = await openEphemeralStore("wallet_data");
  adoptStore(walletStore);
  const pxeStore = await openEphemeralStore("pxe_data");
  adoptStore(pxeStore);
  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL, {
    ephemeral: true,
    walletDb: { store: walletStore },
    pxe: { store: pxeStore, proverEnabled: true },
  });
  disposers.push(async (graceful) => {
    if (graceful) await wallet.stop();
  });

  const manager = await wallet.createSchnorrAccount(
    payerKeys.secret,
    payerKeys.salt,
    payerKeys.signingKey,
  );
  const payer = (await manager.getAccount()).getAddress();
  console.log(`${PAYER_DEPLOYER ? "Payer (deployer)" : "Payer account"}: ${payer.toString()}`);

  // Initialization, not publication. The deployer self-deploys unpublished, so
  // node.getContract misses it; the init nullifier exists either way.
  // createSchnorrAccount registered the instance, so the status is definitive.
  const { initializationStatus } = await wallet.getContractMetadata(payer);
  if (initializationStatus !== ContractInitializationStatus.INITIALIZED) {
    fail(
      PAYER_DEPLOYER
        ? `Deployer ${payer.toString()} is not deployed on ${AZTEC_NODE_URL}. The bridge ` +
            "deploys it on first start with PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM."
        : `Payer ${payer.toString()} is not deployed on ${AZTEC_NODE_URL}. Run the bridge ` +
            "once with this key, without PXE_BRIDGE_SPENDING_LIMIT_ADMIN, and with " +
            "FEE_JUICE_CLAIM bridged to the Account address it logs.",
    );
  }

  const paymentMethod = SPONSORED ? await sponsoredFee(wallet) : undefined;
  const claimOpts = {
    wallet: wallet as unknown as ClaimingWallet,
    payer: payer.toString(),
    recipient: RECIPIENT,
    ...(paymentMethod ? { paymentMethod } : {}),
    log: console.log,
  };

  let claim: FeeJuiceClaim;
  if (resume) {
    const { messageHash, ...resumed } = resume;
    console.log("Resuming: no L1 deposit");
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    await waitForL1ToL2Message(createAztecNodeClient(AZTEC_NODE_URL), messageHash, {});
    await claimFeeJuiceFor({ ...claimOpts, claim: resumed });
    claim = resumed;
  } else {
    let bridged: BridgedFeeJuiceClaim | undefined;
    try {
      claim = await topUpFeeJuice({
        ...claimOpts,
        nodeUrl: AZTEC_NODE_URL,
        l1RpcUrl: L1_RPC_URL,
        l1PrivateKey: L1_PRIVATE_KEY!,
        ...(L1_CHAIN_ID ? { l1ChainId: Number(L1_CHAIN_ID) } : {}),
        amount: AMOUNT,
        mint: MINT,
        onClaim: (c) => {
          bridged = c;
          console.log(`\nDeposited on L1. To resume if what follows fails:\n`);
          console.log(`FEE_JUICE_RESUME_CLAIM='${JSON.stringify(c)}'\n`);
        },
      });
    } catch (err) {
      if (bridged === undefined) throw err;
      console.error("Fatal:", err);
      fail(
        "\nThe deposit is on L1. Rerun with FEE_JUICE_RESUME_CLAIM set to the value printed " +
          "above; rerunning without it deposits again.",
      );
    }
  }

  console.log(`\nCredited ${claim.claimAmount} fee juice to ${RECIPIENT}.`);
  console.log("No FEE_JUICE_CLAIM to set: the balance is already on chain.");
}

/**
 * SponsoredFPC, for a payer with no fee juice of its own. Sandbox and testnet
 * only -- the contract exists to blindly sponsor transactions and is not
 * deployed on a network that charges for them.
 */
async function sponsoredFee(
  wallet: PayerWallet,
): Promise<import("@aztec/aztec.js/fee").FeePaymentMethod> {
  const { SponsoredFPCContract } = await import("@aztec/noir-contracts.js/SponsoredFPC");
  const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee/testing");
  const { getContractInstanceFromInstantiationParams } = await import("@aztec/stdlib/contract");
  const { Fr } = await import("@aztec/aztec.js/fields");

  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(0),
  });
  await wallet.registerContract(instance, SponsoredFPCContract.artifact);
  return new SponsoredFeePaymentMethod(instance.address);
}

let signalled = false;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    if (signalled) return;
    signalled = true;
    console.error(`${signal}: deleting wallet stores`);
    void disposeAll(false).finally(() => process.exit(code));
  });
}

main()
  .then(() => 0)
  .catch((err: unknown) => {
    if (err instanceof ScriptFailure) console.error(err.message);
    else console.error("Fatal:", err);
    return 1;
  })
  .then(async (code) => {
    await disposeAll(true);
    if (!signalled) process.exit(code);
  });
