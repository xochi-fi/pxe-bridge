import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSchnorrAccountContractAddress } from "@aztec-labs/accounts/schnorr";
import { deriveAccountKeys, deriveDeployerKeys, type AccountKeys } from "../src/aztec-client.js";
import { recordBridgedClaim, writePendingDeposit } from "../src/fee-juice.js";

const SCRIPT = fileURLToPath(new URL("../scripts/bridge-fee-juice.ts", import.meta.url));
const ADMIN = "0x" + "ab".repeat(32);
const OTHER = "0x" + "cd".repeat(32);
// Test-only key -- never use with real funds.
const KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";

// Each case stops before any node or L1 contact, so the script runs for real
// with no network: the refusals by name, and the accepted admin at the next
// check, L1_PRIVATE_KEY, which only runs once the recipient has passed.
function run(env: Record<string, string>, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

async function addressOf(keys: AccountKeys): Promise<string> {
  return (await getSchnorrAccountContractAddress(keys.signingKey, keys.salt, keys.secret)).toString();
}

// Spawning tsx loads the Aztec SDK, which takes seconds.
describe("bridge-fee-juice --admin", { timeout: 60_000 }, () => {
  it("bridges to the configured admin", () => {
    const r = run({ PXE_BRIDGE_SPENDING_LIMIT_ADMIN: ADMIN }, ["--admin", "--recipient", ADMIN]);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("Refusing to bridge");
    expect(r.out).toContain("L1_PRIVATE_KEY is required");
  });

  it("accepts the admin address in any case", () => {
    const r = run({ PXE_BRIDGE_SPENDING_LIMIT_ADMIN: ADMIN.toUpperCase().replace("0X", "0x") }, [
      "--admin",
      "--recipient",
      ADMIN,
    ]);
    expect(r.out).toContain("L1_PRIVATE_KEY is required");
  });

  it("refuses a recipient other than the configured admin", () => {
    const r = run({ PXE_BRIDGE_SPENDING_LIMIT_ADMIN: ADMIN }, ["--admin", "--recipient", OTHER]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`--recipient ${OTHER} is not PXE_BRIDGE_SPENDING_LIMIT_ADMIN ${ADMIN}`);
  });

  it("refuses without PXE_BRIDGE_SPENDING_LIMIT_ADMIN", () => {
    const r = run({}, ["--admin", "--recipient", ADMIN]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("--admin needs PXE_BRIDGE_SPENDING_LIMIT_ADMIN");
  });

  it("refuses --admin without --recipient", () => {
    const r = run({ PXE_BRIDGE_SPENDING_LIMIT_ADMIN: ADMIN }, ["--admin"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("--admin needs --recipient");
  });

  it("refuses --admin with --deployer", () => {
    const r = run({ PXE_BRIDGE_SPENDING_LIMIT_ADMIN: ADMIN }, ["--admin", "--deployer", "--recipient", ADMIN]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("--admin and --deployer are exclusive");
  });

  // The admin is not the bridge account, so the bridge account's recorded
  // address must not be what it is checked against.
  it("does not check the admin against PXE_BRIDGE_ACCOUNT_ADDRESS", () => {
    const r = run(
      { PXE_BRIDGE_SPENDING_LIMIT_ADMIN: ADMIN, PXE_BRIDGE_ACCOUNT_ADDRESS: OTHER },
      ["--admin", "--recipient", ADMIN],
    );
    expect(r.out).toContain("L1_PRIVATE_KEY is required");
  });

  it("still refuses a non-admin recipient that is not the recorded account", () => {
    const r = run({ PXE_BRIDGE_ACCOUNT_ADDRESS: OTHER }, ["--recipient", ADMIN]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`--recipient ${ADMIN} is not PXE_BRIDGE_ACCOUNT_ADDRESS ${OTHER}`);
  });
});

// --address-only exits before any L1 or node access, and the refusals fire
// before any key is used.
describe("bridge-fee-juice deployer target", { timeout: 60_000 }, () => {
  // A claim commits to the address it was bridged to and fee juice cannot be
  // moved, so juice bridged for the deployer to any other address is lost.
  it("prints the deployer at the account salt plus one, not the account", async () => {
    const deployer = await addressOf(await deriveDeployerKeys(KEY));
    const account = await addressOf(await deriveAccountKeys(KEY));
    expect(deployer).not.toBe(account);

    const r = run({ PXE_BRIDGE_SECRET_KEY: KEY }, ["--deployer", "--address-only"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`Deployer address: ${deployer}`);
    expect(r.out).not.toContain(account);
  });

  it("prints the account without --deployer", async () => {
    const account = await addressOf(await deriveAccountKeys(KEY));
    const r = run({ PXE_BRIDGE_SECRET_KEY: KEY }, ["--address-only"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`Aztec account address: ${account}`);
  });

  // Production keys live in Secrets Manager; the runbook reads the address
  // from the bridge's log and passes it as --recipient.
  it("refuses key mode under NODE_ENV=production", () => {
    const r = run({ PXE_BRIDGE_SECRET_KEY: KEY, NODE_ENV: "production" }, [
      "--deployer",
      "--address-only",
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("PXE_BRIDGE_SECRET_KEY is dev only and refused under NODE_ENV=production");
  });

  // Two sources for one address could disagree.
  it("refuses --recipient together with a secret key", () => {
    const r = run({ PXE_BRIDGE_SECRET_KEY: KEY }, ["--deployer", "--recipient", OTHER]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("not both");
  });
});

// A recorded deposit file prints its claim without L1; the wait then fails
// against an unreachable node, after the claim boundary under test.
describe("bridge-fee-juice --claim-out", { timeout: 60_000 }, () => {
  it("writes the claim to the file and never prints its secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "pxe-bridge-claim-out-"));
    try {
      const secret = "0x" + "0A".repeat(32);
      const deposit = writePendingDeposit(
        {
          recipient: OTHER,
          claimAmount: "4000000000000000000",
          claimSecret: secret,
          secretHash: "0x" + "0b".repeat(32),
          l1FromBlock: "42",
          l1Sender: "0x" + "cd".repeat(20),
        },
        dir,
      );
      recordBridgedClaim(deposit, {
        claimAmount: "4000000000000000000",
        claimSecret: secret,
        messageLeafIndex: "7",
        messageHash: "0x00" + "ee".repeat(31),
      });
      const claimFile = join(dir, "claim.json");
      const r = run({ AZTEC_NODE_URL: "http://127.0.0.1:9" }, [
        "--deployer",
        "--recipient",
        OTHER,
        "--recover",
        deposit,
        "--claim-out",
        claimFile,
      ]);
      expect(r.out).toContain(`Claim written to ${claimFile}`);
      expect(r.out.toLowerCase()).not.toContain(secret.slice(2).toLowerCase());
      expect(r.out).not.toContain("PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM=");
      expect(JSON.parse(readFileSync(claimFile, "utf8")).claimSecret).toBe(secret.toLowerCase());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
