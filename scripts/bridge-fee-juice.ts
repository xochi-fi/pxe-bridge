/**
 * Bridges Fee Juice from Ethereum L1 to an Aztec L2 account.
 * Outputs the claim JSON needed by PXE_BRIDGE via FEE_JUICE_CLAIM env var.
 *
 * Usage:
 *   npx tsx scripts/bridge-fee-juice.ts
 *
 * Required env:
 *   PXE_BRIDGE_SECRET_KEY  -- same key the sidecar uses (derives the Aztec account address)
 *   L1_PRIVATE_KEY         -- Ethereum private key with Fee Juice ERC20 balance
 *   AZTEC_NODE_URL         -- Aztec node (default: http://localhost:8080)
 *   L1_RPC_URL             -- Ethereum RPC (default: https://eth.llamarpc.com)
 *   BRIDGE_AMOUNT          -- Fee Juice amount in wei (default: 1000000000000000000 = 1e18)
 */

import { createHash } from "node:crypto";

async function main() {
  const SECRET_KEY = process.env["PXE_BRIDGE_SECRET_KEY"];
  const L1_PRIVATE_KEY = process.env["L1_PRIVATE_KEY"];
  const AZTEC_NODE_URL =
    process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
  const L1_RPC_URL = process.env["L1_RPC_URL"] ?? "https://eth.llamarpc.com";
  const BRIDGE_AMOUNT = BigInt(
    process.env["BRIDGE_AMOUNT"] ?? "1000000000000000000",
  );

  if (!SECRET_KEY) {
    console.error("PXE_BRIDGE_SECRET_KEY is required");
    process.exit(1);
  }
  if (!L1_PRIVATE_KEY) {
    console.error("L1_PRIVATE_KEY is required (Ethereum key with Fee Juice)");
    process.exit(1);
  }

  // Derive the Aztec account address (same logic as AztecClient.connect)
  const { Fr } = await import("@aztec/aztec.js/fields");
  const { EmbeddedWallet } = await import("@aztec/wallets/embedded");

  const rawKey = Buffer.from(SECRET_KEY.replace(/^0x/, ""), "hex");
  const keyBytes = Buffer.alloc(32);
  rawKey.copy(keyBytes, 32 - rawKey.length);

  const secret = Fr.fromBuffer(keyBytes);
  const saltBytes = createHash("sha256")
    .update(Buffer.from("pxe-bridge-account-salt-v1"))
    .update(keyBytes)
    .digest();
  const salt = Fr.fromBuffer(saltBytes);

  console.log(`Connecting to Aztec node at ${AZTEC_NODE_URL}...`);
  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL);

  const accountManager = await wallet.createSchnorrAccount(secret, salt);
  const account = await accountManager.getAccount();
  const aztecAddress = account.getAddress();
  console.log(`Aztec account address: ${aztecAddress.toString()}`);

  // Get L1 contract addresses from the node
  const nodeInfo = await (
    wallet as unknown as {
      getNodeInfo: () => Promise<Record<string, unknown>>;
    }
  ).getNodeInfo();
  const l1Addresses = nodeInfo["l1ContractAddresses"] as Record<
    string,
    unknown
  >;
  const feeJuicePortalAddress = String(l1Addresses["feeJuicePortalAddress"]);
  const feeJuiceAddress = String(l1Addresses["feeJuiceAddress"]);

  console.log(`Fee Juice Portal: ${feeJuicePortalAddress}`);
  console.log(`Fee Juice Token:  ${feeJuiceAddress}`);

  // Create L1 client
  const { createExtendedL1Client } = await import("@aztec/ethereum/client");
  const { mainnet } = await import("viem/chains");

  const l1Client = createExtendedL1Client(
    [L1_RPC_URL],
    L1_PRIVATE_KEY as `0x${string}`,
    mainnet,
  );
  console.log(`L1 wallet: ${l1Client.account.address}`);

  // Bridge Fee Juice
  const { L1FeeJuicePortalManager } = await import("@aztec/aztec.js/ethereum");
  const { EthAddress } = await import("@aztec/foundation/eth-address");

  const portalManager = new L1FeeJuicePortalManager(
    EthAddress.fromString(feeJuicePortalAddress),
    EthAddress.fromString(feeJuiceAddress),
    undefined, // no mint handler on mainnet
    l1Client,
    {
      info: console.log,
      verbose: console.log,
      debug: () => {},
      warn: console.warn,
      error: console.error,
    } as never,
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

  console.log("\nBridge successful! Set this env var on the sidecar:\n");
  console.log(`FEE_JUICE_CLAIM='${JSON.stringify(claimJson)}'`);
  console.log(
    "\nThe claim will be consumed on first sidecar startup (account deployment).",
  );

  await wallet.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
