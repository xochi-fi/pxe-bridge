/**
 * Bridges Fee Juice from Ethereum L1 to an Aztec L2 account and prints the
 * claim JSON the bridge consumes when it deploys that account.
 *
 * Two targets:
 *
 *   default     The solver account, for a plain Schnorr bridge. Prints
 *               FEE_JUICE_CLAIM. The spending-limit account cannot use this
 *               (see FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR) and the bridge refuses
 *               the combination at startup.
 *   --deployer  The spending-limit account's deployer, a plain Schnorr account
 *               at the account salt + 1. Prints
 *               PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM. The deployer self-deploys
 *               with the claim and pays the spending-limit account's deployment
 *               out of what is left, so bridge enough for both. The account's
 *               transfers are funded separately, by scripts/top-up-fee-juice.ts.
 *
 * The address printed must match the "Account address" or "Deployer address"
 * the bridge logs on connect: a claim commits to its recipient, and juice
 * bridged to the wrong address cannot be moved.
 *
 * --address-only prints the target address and exits before anything touches
 * L1, so the address can be checked (or funded some other way) first. It needs
 * no L1_PRIVATE_KEY.
 *
 * Usage:
 *   npx tsx scripts/bridge-fee-juice.ts [--deployer] [--address-only]
 *
 * Required env:
 *   PXE_BRIDGE_SECRET_KEY  -- same key the sidecar uses (derives the Aztec account address)
 *   L1_PRIVATE_KEY         -- Ethereum private key with Fee Juice ERC20 balance
 *   AZTEC_NODE_URL         -- Aztec node (default: http://localhost:8080)
 *   L1_RPC_URL             -- Ethereum RPC (default: http://localhost:8545)
 *   L1_CHAIN_ID            -- L1 chain id (default: Anvil's, per the SDK)
 *   BRIDGE_AMOUNT          -- Fee Juice amount in wei (default: 1000000000000000000 = 1e18)
 */

import {
  DEPLOYER_FEE_JUICE_CLAIM_ENV,
  deriveAccountKeys,
  deriveDeployerKeys,
} from "../src/aztec-client.js";
import { waitForL1ToL2Message } from "../src/fee-juice.js";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--deployer" && a !== "--address-only");
  if (unknown.length > 0) {
    console.error(
      `Unknown argument(s): ${unknown.join(" ")}. Usage: bridge-fee-juice [--deployer] [--address-only]`,
    );
    process.exit(1);
  }
  const toDeployer = args.includes("--deployer");
  const addressOnly = args.includes("--address-only");
  const SECRET_KEY = process.env["PXE_BRIDGE_SECRET_KEY"];
  const L1_PRIVATE_KEY = process.env["L1_PRIVATE_KEY"];
  // Clear sensitive env vars from process memory
  delete process.env["PXE_BRIDGE_SECRET_KEY"];
  delete process.env["L1_PRIVATE_KEY"];
  const AZTEC_NODE_URL =
    process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
  // Localhost, matching AZTEC_NODE_URL above and top-up-fee-juice.ts. This
  // used to default to a public mainnet RPC while the Aztec node defaulted to
  // a sandbox, so running the script with no L1 settings signed against
  // chainId 1 with a key meant for Anvil.
  const L1_RPC_URL = process.env["L1_RPC_URL"] ?? "http://localhost:8545";
  const L1_CHAIN_ID = process.env["L1_CHAIN_ID"];
  if (L1_CHAIN_ID !== undefined && !/^\d+$/.test(L1_CHAIN_ID)) {
    console.error("L1_CHAIN_ID must be a decimal integer");
    process.exit(1);
  }
  const BRIDGE_AMOUNT = BigInt(
    process.env["BRIDGE_AMOUNT"] ?? "1000000000000000000",
  );

  if (!SECRET_KEY) {
    console.error("PXE_BRIDGE_SECRET_KEY is required");
    process.exit(1);
  }
  if (!L1_PRIVATE_KEY && !addressOnly) {
    console.error("L1_PRIVATE_KEY is required (Ethereum key with Fee Juice)");
    process.exit(1);
  }

  // Shared with AztecClient.connect, not reimplemented. The copy that used to
  // live here built the salt with Fr.fromBuffer and omitted the signing key, so
  // it threw for most keys and derived a different address for the rest.
  const { EmbeddedWallet } = await import("@aztec/wallets/embedded");
  const { secret, salt, signingKey } = toDeployer
    ? await deriveDeployerKeys(SECRET_KEY)
    : await deriveAccountKeys(SECRET_KEY);

  console.log(`Connecting to Aztec node at ${AZTEC_NODE_URL}...`);
  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL);

  const accountManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const account = await accountManager.getAccount();
  const aztecAddress = account.getAddress();
  console.log(
    `${toDeployer ? "Deployer address" : "Aztec account address"}: ${aztecAddress.toString()}`,
  );
  if (addressOnly || !L1_PRIVATE_KEY) {
    await wallet.stop();
    process.exit(0);
  }

  // Get L1 contract addresses from the node via JSON-RPC
  const nodeInfoRes = await fetch(AZTEC_NODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "node_getNodeInfo",
      params: [],
      id: 1,
    }),
  });
  const nodeInfoJson = (await nodeInfoRes.json()) as {
    result: { l1ContractAddresses: Record<string, string> };
  };
  const l1Addresses = nodeInfoJson.result.l1ContractAddresses;
  const feeJuicePortalAddress = l1Addresses["feeJuicePortalAddress"];
  const feeJuiceAddress = l1Addresses["feeJuiceAddress"];
  if (!feeJuicePortalAddress || !feeJuiceAddress) {
    // EthAddress.fromString takes undefined without complaining and the failure
    // then surfaces as an L1 call to the zero address.
    console.error(`Node at ${AZTEC_NODE_URL} did not report the Fee Juice L1 addresses`);
    process.exit(1);
  }

  console.log(`Fee Juice Portal: ${feeJuicePortalAddress}`);
  console.log(`Fee Juice Token:  ${feeJuiceAddress}`);

  // Create L1 client
  const { createExtendedL1Client } = await import("@aztec/ethereum/client");
  const { createEthereumChain } = await import("@aztec/ethereum/chain");

  // Same resolution as src/fee-juice.ts. viem's `mainnet` was hardcoded here,
  // so the chain was mainnet whatever L1_RPC_URL pointed at. Undefined falls
  // through to the SDK's Anvil default, so the sandbox needs no chain id and a
  // real L1 cannot be reached without naming one.
  const chain =
    L1_CHAIN_ID === undefined
      ? undefined
      : createEthereumChain([L1_RPC_URL], Number(L1_CHAIN_ID)).chainInfo;

  const l1Client = createExtendedL1Client(
    [L1_RPC_URL],
    L1_PRIVATE_KEY as `0x${string}`,
    chain,
  );
  console.log(`L1 wallet: ${l1Client.account.address}`);

  // Bridge Fee Juice
  const { L1FeeJuicePortalManager } = await import("@aztec/aztec.js/ethereum");
  const { EthAddress } = await import("@aztec/foundation/eth-address");
  const { createLogger } = await import("@aztec/aztec.js/log");

  const portalManager = new L1FeeJuicePortalManager(
    EthAddress.fromString(feeJuicePortalAddress),
    EthAddress.fromString(feeJuiceAddress),
    undefined, // no mint handler on mainnet
    l1Client,
    // The SDK's own logger, as src/fee-juice.ts uses. A hand-rolled object
    // cast to the type lacked `trace`, which L1TxUtils.estimateGas calls, so
    // the approve threw "this.logger?.trace is not a function" before
    // anything was bridged.
    createLogger("pxe-bridge:bridge-fee-juice"),
  );

  // Check L1 token balance
  const balance = await portalManager
    .getTokenManager()
    .getL1TokenBalance(l1Client.account.address);
  console.log(`Fee Juice L1 balance: ${balance}`);
  if (balance < BRIDGE_AMOUNT) {
    console.error(
      `Insufficient Fee Juice balance: have ${balance}, need ${BRIDGE_AMOUNT}`,
    );
    process.exit(1);
  }

  console.log(`Bridging ${BRIDGE_AMOUNT} Fee Juice to ${aztecAddress}...`);
  const claim = await portalManager.bridgeTokensPublic(
    aztecAddress,
    BRIDGE_AMOUNT,
  );

  const claimJson = {
    claimAmount: claim.claimAmount.toString(),
    claimSecret: claim.claimSecret.toString(),
    messageLeafIndex: claim.messageLeafIndex.toString(),
  };

  // Printed before the wait, not after it: the L1 write has already happened,
  // and a wait that times out must not take the only copy of the claim with it.
  const envName = toDeployer ? DEPLOYER_FEE_JUICE_CLAIM_ENV : "FEE_JUICE_CLAIM";
  console.log("\nBridge successful! Set this env var on the sidecar:\n");
  console.log(`${envName}='${JSON.stringify(claimJson)}'`);

  // The claim is only consumable once the sequencer has pulled the message off
  // L1 into the tree. Starting the sidecar earlier fails its first deploy with
  // "No L1 to L2 message found for message hash".
  console.log("\nWaiting for the L1 to L2 message to sync...");
  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  try {
    await waitForL1ToL2Message(
      createAztecNodeClient(AZTEC_NODE_URL),
      claim.messageHash.toString(),
      {},
    );
  } catch (err) {
    console.error(
      `\n${err instanceof Error ? err.message : String(err)}. The claim above is still ` +
        "valid: start the sidecar once L2 has built a few more blocks.",
    );
    await wallet.stop();
    process.exit(1);
  }
  console.log(
    toDeployer
      ? "Message synced. The claim will be consumed on first sidecar startup, when the " +
          "deployer deploys itself and then the spending-limit account."
      : "Message synced. The claim will be consumed on first sidecar startup (account deployment).",
  );

  await wallet.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
