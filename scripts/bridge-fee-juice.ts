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
 * Before any L1 write the claim secret, its hash, the starting L1 block and
 * the L1 sender are written to fee-juice-deposit-<secretHash>.json in the
 * working directory, owner-only. If the run dies before the claim is printed,
 * the deposit may still land: rerun the same command with --recover <file>. It
 * finds the deposit on L1 and prints the claim without depositing, or says
 * whether one is still pending. The file is deleted once the claim is printed.
 * A hangup exits rather than killing the run mid-write.
 *
 * The claim and the L1 to L2 message hash are printed as soon as the L1
 * deposit lands, before the wait. If the wait times out, the deposit is done:
 * resume with --wait <messageHash> rather than bridging again.
 *
 * Usage:
 *   npx tsx scripts/bridge-fee-juice.ts [--deployer] --recipient 0x<address>
 *   npx tsx scripts/bridge-fee-juice.ts [--deployer] [--address-only]   (dev, key mode)
 *   npx tsx scripts/bridge-fee-juice.ts [--deployer] --recipient 0x<address> --recover <file>|0x<secretHash>
 *   npx tsx scripts/bridge-fee-juice.ts --wait 0x<messageHash>
 *
 * Env:
 *   L1_PRIVATE_KEY         -- Ethereum key holding BRIDGE_AMOUNT of the Fee Juice ERC20;
 *                             unused with --recover
 *   PXE_BRIDGE_SECRET_KEY  -- key mode only; refused under NODE_ENV=production
 *   FEE_JUICE_RECIPIENT    -- same as --recipient
 *   AZTEC_NODE_URL         -- Aztec node (default: http://localhost:8080)
 *   L1_RPC_URL             -- Ethereum RPC (default: http://localhost:8545)
 *   L1_CHAIN_ID            -- L1 chain id (default: Anvil's, per the SDK; with
 *                             --recover, the node's)
 *   BRIDGE_AMOUNT          -- Fee Juice amount in wei (default: 1000000000000000000 = 1e18);
 *                             with --recover 0x<secretHash>, the amount the lost run bridged
 *   FEE_JUICE_MINT         -- "true" to mint BRIDGE_AMOUNT from the L1 faucet first;
 *                             sandbox only, and BRIDGE_AMOUNT must equal the faucet's
 *                             fixed mint amount
 *   FEE_JUICE_CLAIM_SECRET       -- --recover 0x<secretHash> with no deposit file in the
 *                                   working directory: the claim secret
 *   FEE_JUICE_RECOVER_FROM_BLOCK -- likewise: the L1 block recorded with it
 */

import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  booleanEnv,
  DEPLOYER_FEE_JUICE_CLAIM_ENV,
  deriveAccountKeys,
  deriveDeployerKeys,
} from "../src/aztec-client.js";
import {
  assertAztecAddress,
  assertBridgeAmount,
  bridgeFeeJuice,
  findPendingDeposit,
  recoverFeeJuiceClaim,
  waitForL1ToL2Message,
  writePendingDeposit,
} from "../src/fee-juice.js";
import type { PendingFeeJuiceDeposit } from "../src/fee-juice.js";
import type { BridgedFeeJuiceClaim } from "../src/types.js";

const USAGE =
  "Usage: bridge-fee-juice [--deployer] --recipient 0x<address> [--recover <file>|0x<secretHash>] | " +
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
    recover?: string;
    wait?: string;
  };
  try {
    ({ values } = parseArgs({
      options: {
        deployer: { type: "boolean" },
        "address-only": { type: "boolean" },
        recipient: { type: "string" },
        recover: { type: "string" },
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
    if (
      values.deployer ||
      values["address-only"] ||
      values.recipient !== undefined ||
      values.recover !== undefined
    ) {
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
  const recoverArg = values.recover;
  // A deposit file, or a secret hash whose file is in the working directory.
  // A hash with no file there takes the secret from the env.
  let recoverFile: ReturnType<typeof findPendingDeposit>;
  if (recoverArg !== undefined) {
    if (addressOnly) fail(`--recover and --address-only are exclusive. ${USAGE}`);
    try {
      recoverFile = findPendingDeposit(recoverArg);
    } catch (err) {
      fail((err as Error).message);
    }
  }
  const recipientArg = values.recipient ?? process.env["FEE_JUICE_RECIPIENT"];
  const SECRET_KEY = process.env["PXE_BRIDGE_SECRET_KEY"];
  const L1_PRIVATE_KEY = process.env["L1_PRIVATE_KEY"];
  const CLAIM_SECRET = process.env["FEE_JUICE_CLAIM_SECRET"];
  // Cleared from the environment: none has any use past this point.
  delete process.env["PXE_BRIDGE_SECRET_KEY"];
  delete process.env["L1_PRIVATE_KEY"];
  delete process.env["FEE_JUICE_CLAIM_SECRET"];

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
  const AMOUNT_RAW = process.env["BRIDGE_AMOUNT"];
  const RECOVER_FROM_RAW = process.env["FEE_JUICE_RECOVER_FROM_BLOCK"];
  const AMOUNT = parseBigInt("BRIDGE_AMOUNT", AMOUNT_RAW ?? "1000000000000000000");
  try {
    assertBridgeAmount(AMOUNT);
  } catch (err) {
    fail((err as Error).message);
  }
  let MINT: boolean;
  try {
    MINT = booleanEnv(process.env, "FEE_JUICE_MINT") ?? false;
  } catch (err) {
    fail((err as Error).message);
  }
  let recovery:
    | { amount: bigint; claimSecret: string; secretHash: string; fromBlock: bigint; l1Sender?: string }
    | undefined;
  if (recoverFile) {
    // The file is the record; a second source for any of it could disagree.
    const { path, deposit } = recoverFile;
    if (AMOUNT_RAW !== undefined || CLAIM_SECRET !== undefined || RECOVER_FROM_RAW !== undefined) {
      fail(
        `--recover ${path} takes the amount, secret and block from the file; unset BRIDGE_AMOUNT, ` +
          "FEE_JUICE_CLAIM_SECRET and FEE_JUICE_RECOVER_FROM_BLOCK",
      );
    }
    if (deposit.recipient.toLowerCase() !== recipient.toLowerCase()) {
      fail(`Deposit file ${path} is for ${deposit.recipient}, not ${recipient}`);
    }
    recovery = {
      amount: BigInt(deposit.claimAmount),
      claimSecret: deposit.claimSecret,
      secretHash: deposit.secretHash,
      fromBlock: BigInt(deposit.l1FromBlock),
      l1Sender: deposit.l1Sender,
    };
  } else if (recoverArg !== undefined) {
    if (!CLAIM_SECRET) {
      fail(`No deposit file for ${recoverArg} here; --recover with a secret hash needs FEE_JUICE_CLAIM_SECRET`);
    }
    if (RECOVER_FROM_RAW === undefined || !/^\d+$/.test(RECOVER_FROM_RAW)) {
      fail("--recover needs FEE_JUICE_RECOVER_FROM_BLOCK, the decimal L1 block recorded with the secret");
    }
    recovery = {
      amount: AMOUNT,
      claimSecret: CLAIM_SECRET,
      secretHash: recoverArg,
      fromBlock: BigInt(RECOVER_FROM_RAW),
    };
  } else if (!L1_PRIVATE_KEY) {
    fail("L1_PRIVATE_KEY is required (Ethereum key with Fee Juice)");
  }

  const envName = toDeployer ? DEPLOYER_FEE_JUICE_CLAIM_ENV : "FEE_JUICE_CLAIM";
  let pending: PendingFeeJuiceDeposit | undefined;
  let bridged: BridgedFeeJuiceClaim | undefined;
  // Deleted once the claim is printed, which is the next record of the deposit.
  let depositFile = recoverFile?.path;

  const recoverCommand = (file: string): string =>
    `  npm run bridge-fee-juice -- ${toDeployer ? "--deployer " : ""}--recipient ${recipient} ` +
    `--recover ${file}`;

  // Printed before the wait: the L1 deposit is done and cannot be undone,
  // and a wait that times out must not take the only copy of the claim.
  const printClaim = (claim: BridgedFeeJuiceClaim): void => {
    bridged = claim;
    const { messageHash, ...claimJson } = claim;
    console.log("\nBridged. Set this on the bridge once the message has synced:\n");
    console.log(`${envName}='${JSON.stringify(claimJson)}'`);
    console.log(`\nL1 to L2 message hash: ${messageHash}\n`);
    if (depositFile !== undefined) {
      rmSync(depositFile, { force: true });
      depositFile = undefined;
    }
  };

  console.log(`Connecting to Aztec node at ${AZTEC_NODE_URL}`);
  try {
    if (recovery !== undefined) {
      printClaim(
        await recoverFeeJuiceClaim({
          nodeUrl: AZTEC_NODE_URL,
          l1RpcUrl: L1_RPC_URL,
          ...(L1_CHAIN_ID ? { l1ChainId: Number(L1_CHAIN_ID) } : {}),
          recipient,
          ...recovery,
          log: console.log,
        }),
      );
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      console.log("Waiting for the L1 to L2 message");
      await waitForL1ToL2Message(createAztecNodeClient(AZTEC_NODE_URL), bridged!.messageHash, {});
    } else {
      await bridgeFeeJuice({
        nodeUrl: AZTEC_NODE_URL,
        l1RpcUrl: L1_RPC_URL,
        l1PrivateKey: L1_PRIVATE_KEY!,
        ...(L1_CHAIN_ID ? { l1ChainId: Number(L1_CHAIN_ID) } : {}),
        recipient,
        amount: AMOUNT,
        mint: MINT,
        log: console.log,
        // Written before any L1 write: until the receipt is read, this is the
        // only copy of the secret a broadcast deposit needs. A failed write
        // throws here, before anything is sent.
        onSecret: (d) => {
          depositFile = writePendingDeposit(d);
          pending = d;
          console.log(`\nDeposit recorded in ${depositFile} (owner-only; holds the claim secret).`);
          console.log("If this run dies before the claim is printed, the deposit may still land.");
          console.log("Do not bridge again; recover it from this directory with:\n");
          console.log(recoverCommand(depositFile));
          console.log("\n(with the same AZTEC_NODE_URL and L1_RPC_URL)\n");
        },
        onClaim: printClaim,
      });
    }
  } catch (err) {
    if (bridged !== undefined) {
      fail(
        `\n${(err as Error).message}.\nThe deposit is on L1 and the claim above stays valid. ` +
          "Do not run the bridge step again: that deposits a second time. Resume the wait with:\n" +
          `  npm run bridge-fee-juice -- --wait ${bridged.messageHash}`,
      );
    }
    if (pending !== undefined && depositFile !== undefined) {
      console.error("Fatal:", err);
      fail(
        "\nThe deposit may be on L1. Do not bridge again before recovering it:\n" +
          recoverCommand(depositFile),
      );
    }
    if (recovery !== undefined) fail((err as Error).message);
    throw err;
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

// Unhandled, a hangup kills the process wherever it is, possibly mid-write of
// the deposit file. Handled, it runs between synchronous steps: before
// onSecret, with nothing sent, or after the file is complete.
process.on("SIGHUP", () => process.exit(129));

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
