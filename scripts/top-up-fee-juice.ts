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
 * The payer must already be deployed and able to pay for one transaction. Run
 * the bridge once with its key and without PXE_BRIDGE_SPENDING_LIMIT_ADMIN to
 * get a plain Schnorr account deployed at the address this script derives.
 *
 * Usage:
 *   npx tsx scripts/top-up-fee-juice.ts
 *
 * Required env:
 *   FEE_JUICE_RECIPIENT    -- AztecAddress to credit (the bridge logs its own
 *                             as "[pxe-bridge] Account address:")
 *   FEE_JUICE_PAYER_KEY    -- 32-byte hex secret key of the account that sends
 *                             the claim; needs its own fee juice
 *   FEE_JUICE_PAYER_ADDRESS -- the payer's recorded AztecAddress. The address
 *                             the key derives to must equal it, or nothing is
 *                             sent: an SDK that changes the stock SchnorrAccount
 *                             class derives a different payer address
 *                             (SECURITY.md, "Account address pinning")
 *   L1_PRIVATE_KEY         -- Ethereum private key with a Fee Juice ERC20 balance
 *
 * Optional env:
 *   AZTEC_NODE_URL             -- Aztec node (default: http://localhost:8080)
 *   L1_RPC_URL                 -- Ethereum RPC (default: http://localhost:8545)
 *   L1_CHAIN_ID                -- L1 chain id (default: Anvil's, per the SDK)
 *   BRIDGE_AMOUNT              -- fee juice in wei (default: 1e18)
 *   FEE_JUICE_PAYER_SPONSORED  -- "true" to pay via SponsoredFPC instead of the
 *                                 payer's own balance; sandbox and testnet only
 */

import { deriveAccountKeys } from "../src/aztec-client.js";
import { assertAccountIdentity } from "../src/account-identity.js";
import { assertAztecAddress, assertBridgeAmount, topUpFeeJuice } from "../src/fee-juice.js";
import type { ClaimingWallet } from "../src/fee-juice.js";

/** Whatever EmbeddedWallet.create hands back, without naming the node variant. */
type PayerWallet = Awaited<
  ReturnType<typeof import("@aztec-labs/wallets/embedded").EmbeddedWallet.create>
>;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

/** BigInt() throws a bare SyntaxError that names neither the variable nor the value. */
function parseBigInt(name: string, raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    console.error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const RECIPIENT = required("FEE_JUICE_RECIPIENT");
  const PAYER_KEY = required("FEE_JUICE_PAYER_KEY");
  const PAYER_ADDRESS = required("FEE_JUICE_PAYER_ADDRESS");
  const L1_PRIVATE_KEY = required("L1_PRIVATE_KEY");
  // Cleared for the same reason AztecClient nulls its own reference: neither
  // key has any further use once the account and the L1 client exist.
  delete process.env["FEE_JUICE_PAYER_KEY"];
  delete process.env["L1_PRIVATE_KEY"];

  const AZTEC_NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
  const L1_RPC_URL = process.env["L1_RPC_URL"] ?? "http://localhost:8545";
  const SPONSORED = process.env["FEE_JUICE_PAYER_SPONSORED"] === "true";

  const AMOUNT = parseBigInt("BRIDGE_AMOUNT", process.env["BRIDGE_AMOUNT"] ?? "1000000000000000000");

  // Everything checkable is checked here, before a node connection or an L1
  // write. topUpFeeJuice repeats these for callers that are not this script;
  // running them again is about the ordering, not about the checks.
  try {
    assertAztecAddress("FEE_JUICE_RECIPIENT", RECIPIENT);
    assertAztecAddress("FEE_JUICE_PAYER_ADDRESS", PAYER_ADDRESS);
    assertBridgeAmount(AMOUNT);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const L1_CHAIN_ID = process.env["L1_CHAIN_ID"];
  if (L1_CHAIN_ID !== undefined && !/^\d+$/.test(L1_CHAIN_ID)) {
    console.error("L1_CHAIN_ID must be a decimal integer");
    process.exit(1);
  }

  const { EmbeddedWallet } = await import("@aztec-labs/wallets/embedded");
  const { createAztecNodeClient } = await import("@aztec-labs/aztec.js/node");

  console.log(`Connecting to Aztec node at ${AZTEC_NODE_URL}`);
  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL);

  const { secret, salt, signingKey } = await deriveAccountKeys(PAYER_KEY);
  const manager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const payer = (await manager.getAccount()).getAddress();
  console.log(`Payer account: ${payer.toString()}`);

  // Before the L1 write. A payer that derives elsewhere is not the account
  // the operator funded, and the fee juice at the recorded one cannot be moved.
  try {
    assertAccountIdentity({
      role: "Fee juice payer",
      derived: payer.toString(),
      derivedClassId: manager.getInstance().currentContractClassId.toString(),
      expected: PAYER_ADDRESS,
      expectedSource: "FEE_JUICE_PAYER_ADDRESS",
    });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // Asked of the node, not the PXE. createSchnorrAccount registers the instance
  // locally whether or not anything was ever deployed, so a PXE-side lookup
  // always answers yes and the claim would fail much later with a message about
  // the entrypoint rather than about the account not existing.
  const node = createAztecNodeClient(AZTEC_NODE_URL);
  if ((await node.getContract(payer)) === undefined) {
    console.error(
      `Payer ${payer.toString()} is not deployed on ${AZTEC_NODE_URL}. ` +
        "Start the bridge once with this key and without " +
        "PXE_BRIDGE_SPENDING_LIMIT_ADMIN to deploy it.",
    );
    process.exit(1);
  }

  const claim = await topUpFeeJuice({
    nodeUrl: AZTEC_NODE_URL,
    l1RpcUrl: L1_RPC_URL,
    l1PrivateKey: L1_PRIVATE_KEY,
    ...(L1_CHAIN_ID ? { l1ChainId: Number(L1_CHAIN_ID) } : {}),
    recipient: RECIPIENT,
    amount: AMOUNT,
    wallet: wallet as unknown as ClaimingWallet,
    payer: payer.toString(),
    ...(SPONSORED ? { paymentMethod: await sponsoredFee(wallet) } : {}),
    log: console.log,
  });

  console.log(`\nCredited ${claim.claimAmount} fee juice to ${RECIPIENT}.`);
  console.log("No FEE_JUICE_CLAIM to set: the balance is already on chain.");

  await wallet.stop();
}

/**
 * SponsoredFPC, for a payer with no fee juice of its own. Sandbox and testnet
 * only -- the contract exists to blindly sponsor transactions and is not
 * deployed on a network that charges for them.
 */
async function sponsoredFee(
  wallet: PayerWallet,
): Promise<import("@aztec-labs/aztec.js/fee").FeePaymentMethod> {
  const { SponsoredFPCContract } = await import("@aztec-labs/noir-contracts.js/SponsoredFPC");
  const { SponsoredFeePaymentMethod } = await import("@aztec-labs/aztec.js/fee/testing");
  const { getContractInstanceFromInstantiationParams } = await import("@aztec-labs/stdlib/contract");
  const { Fr } = await import("@aztec-labs/aztec.js/fields");

  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(0),
  });
  await wallet.registerContract(instance, SponsoredFPCContract.artifact);
  return new SponsoredFeePaymentMethod(instance.address);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
