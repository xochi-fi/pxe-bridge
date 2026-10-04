/**
 * Bridges Fee Juice from Ethereum L1 to an Aztec L2 account and prints the
 * claim JSON the bridge consumes when it deploys that account.
 *
 * Two targets, which decide the variable the claim is printed under:
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
 * Two ways to name the recipient:
 *
 *   --recipient 0x...  (or FEE_JUICE_RECIPIENT) The address the bridge logs as
 *               "Account address" or "Deployer address". Needs no secret key,
 *               and is the only mode accepted under NODE_ENV=production.
 *   key mode    Derives the address from PXE_BRIDGE_SECRET_KEY, offline. Dev
 *               only. --address-only prints it and exits before any network
 *               call, and needs no L1_PRIVATE_KEY.
 *
 * A claim commits to its recipient, and juice bridged to the wrong address
 * cannot be moved.
 *
 * The claim and the L1 to L2 message hash are printed as soon as the L1
 * deposit lands, before the wait. If the wait times out, the deposit is done:
 * resume with --wait <messageHash> rather than bridging again.
 *
 * Usage:
 *   npx tsx scripts/bridge-fee-juice.ts [--deployer] --recipient 0x<address>
 *   npx tsx scripts/bridge-fee-juice.ts [--deployer] [--address-only]   (dev, key mode)
 *   npx tsx scripts/bridge-fee-juice.ts --wait 0x<messageHash>
 *
 * Env:
 *   L1_PRIVATE_KEY         -- Ethereum key holding BRIDGE_AMOUNT of the Fee Juice ERC20
 *   PXE_BRIDGE_SECRET_KEY  -- key mode only; refused under NODE_ENV=production
 *   FEE_JUICE_RECIPIENT    -- same as --recipient
 *   AZTEC_NODE_URL         -- Aztec node (default: http://localhost:8080)
 *   L1_RPC_URL             -- Ethereum RPC (default: http://localhost:8545)
 *   L1_CHAIN_ID            -- L1 chain id (default: Anvil's, per the SDK)
 *   BRIDGE_AMOUNT          -- Fee Juice amount in wei (default: 1000000000000000000 = 1e18)
 *   FEE_JUICE_MINT         -- "true" to mint BRIDGE_AMOUNT from the L1 faucet first;
 *                             sandbox only, and BRIDGE_AMOUNT must equal the faucet's
 *                             fixed mint amount
 */

import { parseArgs } from "node:util";
import {
  DEPLOYER_FEE_JUICE_CLAIM_ENV,
  deriveAccountKeys,
  deriveDeployerKeys,
} from "../src/aztec-client.js";
import {
  assertAztecAddress,
  assertBridgeAmount,
  bridgeFeeJuice,
  waitForL1ToL2Message,
} from "../src/fee-juice.js";
import type { BridgedFeeJuiceClaim } from "../src/types.js";

const USAGE =
  "Usage: bridge-fee-juice [--deployer] --recipient 0x<address> | " +
  "[--deployer] [--address-only] (dev, PXE_BRIDGE_SECRET_KEY) | --wait 0x<messageHash>";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** BigInt() throws a bare SyntaxError that names neither the variable nor the value. */
function parseBigInt(name: string, raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    fail(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
}

async function main(): Promise<void> {
  let values: {
    deployer?: boolean;
    "address-only"?: boolean;
    recipient?: string;
    wait?: string;
  };
  try {
    ({ values } = parseArgs({
      options: {
        deployer: { type: "boolean" },
        "address-only": { type: "boolean" },
        recipient: { type: "string" },
        wait: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    fail(`${(err as Error).message}. ${USAGE}`);
  }

  const AZTEC_NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";

  if (values.wait !== undefined) {
    if (values.deployer || values["address-only"] || values.recipient !== undefined) {
      fail(`--wait takes no other argument. ${USAGE}`);
    }
    if (!HASH_PATTERN.test(values.wait)) {
      fail(`--wait must be a 32-byte hex message hash, got ${JSON.stringify(values.wait)}`);
    }
    await waitForSync(AZTEC_NODE_URL, values.wait);
    return;
  }

  const toDeployer = values.deployer === true;
  const addressOnly = values["address-only"] === true;
  const recipientArg = values.recipient ?? process.env["FEE_JUICE_RECIPIENT"];
  const SECRET_KEY = process.env["PXE_BRIDGE_SECRET_KEY"];
  const L1_PRIVATE_KEY = process.env["L1_PRIVATE_KEY"];
  // Cleared from the environment: neither has any use past this point.
  delete process.env["PXE_BRIDGE_SECRET_KEY"];
  delete process.env["L1_PRIVATE_KEY"];

  let recipient: string;
  if (recipientArg !== undefined) {
    // Two sources for one address could disagree, and juice bridged to the
    // wrong one is unrecoverable.
    if (SECRET_KEY) {
      fail("Set --recipient (FEE_JUICE_RECIPIENT) or PXE_BRIDGE_SECRET_KEY, not both");
    }
    if (addressOnly) {
      fail("--address-only derives the address from PXE_BRIDGE_SECRET_KEY; --recipient already names it");
    }
    try {
      assertAztecAddress("--recipient", recipientArg);
    } catch (err) {
      fail((err as Error).message);
    }
    recipient = recipientArg;
    console.log(`Recipient: ${recipient}`);
  } else {
    // The production key lives in Secrets Manager and the bridge refuses it
    // from the environment. The address it would derive is public and logged
    // by the bridge itself, so production has no reason to export the key.
    if (process.env["NODE_ENV"] === "production") {
      fail(
        "PXE_BRIDGE_SECRET_KEY is dev only and refused under NODE_ENV=production. Start the " +
          'bridge once, read "Deployer address" (or "Account address") from its log, and pass ' +
          "it as --recipient.",
      );
    }
    if (!SECRET_KEY) {
      fail(`--recipient (FEE_JUICE_RECIPIENT) or PXE_BRIDGE_SECRET_KEY is required. ${USAGE}`);
    }
    if (!KEY_PATTERN.test(SECRET_KEY)) {
      fail("PXE_BRIDGE_SECRET_KEY must be 32-byte hex");
    }
    recipient = await deriveAddress(SECRET_KEY, toDeployer);
    console.log(`${toDeployer ? "Deployer address" : "Aztec account address"}: ${recipient}`);
    if (addressOnly) return;
  }

  // Localhost, matching AZTEC_NODE_URL. A mainnet RPC default paired with a
  // sandbox node signed against chainId 1 with a key meant for Anvil.
  const L1_RPC_URL = process.env["L1_RPC_URL"] ?? "http://localhost:8545";
  const L1_CHAIN_ID = process.env["L1_CHAIN_ID"];
  if (L1_CHAIN_ID !== undefined && !/^\d+$/.test(L1_CHAIN_ID)) {
    fail("L1_CHAIN_ID must be a decimal integer");
  }
  const AMOUNT = parseBigInt("BRIDGE_AMOUNT", process.env["BRIDGE_AMOUNT"] ?? "1000000000000000000");
  try {
    assertBridgeAmount(AMOUNT);
  } catch (err) {
    fail((err as Error).message);
  }
  if (!L1_PRIVATE_KEY) {
    fail("L1_PRIVATE_KEY is required (Ethereum key with Fee Juice)");
  }

  const envName = toDeployer ? DEPLOYER_FEE_JUICE_CLAIM_ENV : "FEE_JUICE_CLAIM";
  let bridged: BridgedFeeJuiceClaim | undefined;

  console.log(`Connecting to Aztec node at ${AZTEC_NODE_URL}`);
  try {
    await bridgeFeeJuice({
      nodeUrl: AZTEC_NODE_URL,
      l1RpcUrl: L1_RPC_URL,
      l1PrivateKey: L1_PRIVATE_KEY,
      ...(L1_CHAIN_ID ? { l1ChainId: Number(L1_CHAIN_ID) } : {}),
      recipient,
      amount: AMOUNT,
      mint: process.env["FEE_JUICE_MINT"] === "true",
      log: console.log,
      // Printed before the wait: the L1 deposit is done and cannot be undone,
      // and a wait that times out must not take the only copy of the claim.
      onClaim: (claim) => {
        bridged = claim;
        const { messageHash, ...claimJson } = claim;
        console.log("\nBridged. Set this on the bridge once the message has synced:\n");
        console.log(`${envName}='${JSON.stringify(claimJson)}'`);
        console.log(`\nL1 to L2 message hash: ${messageHash}\n`);
      },
    });
  } catch (err) {
    if (bridged === undefined) throw err;
    fail(
      `\n${(err as Error).message}.\nThe deposit is on L1 and the claim above stays valid. ` +
        "Do not run the bridge step again: that deposits a second time. Resume the wait with:\n" +
        `  npm run bridge-fee-juice -- --wait ${bridged.messageHash}`,
    );
  }

  console.log(
    toDeployer
      ? "Message synced. The bridge consumes the claim on first startup, when the deployer " +
          "deploys itself and then the spending-limit account."
      : "Message synced. The bridge consumes the claim on first startup (account deployment).",
  );
}

/**
 * The address the bridge deploys, computed without a node or a wallet. A
 * wallet would persist the key under ./aztec-wallet-data.
 */
async function deriveAddress(secretKey: string, toDeployer: boolean): Promise<string> {
  const { getSchnorrAccountContractAddress } = await import("@aztec/accounts/schnorr");
  const { secret, salt, signingKey } = toDeployer
    ? await deriveDeployerKeys(secretKey)
    : await deriveAccountKeys(secretKey);
  return (await getSchnorrAccountContractAddress(signingKey, salt, secret)).toString();
}

async function waitForSync(nodeUrl: string, messageHash: string): Promise<void> {
  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  console.log(`Waiting for L1 to L2 message ${messageHash} on ${nodeUrl}`);
  try {
    await waitForL1ToL2Message(createAztecNodeClient(nodeUrl), messageHash, {});
  } catch (err) {
    fail(`${(err as Error).message}. Run --wait again once L2 has built more blocks.`);
  }
  console.log("Message synced. The claim printed with it can now be consumed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
