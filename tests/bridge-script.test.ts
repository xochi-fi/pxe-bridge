// Runs the real scripts/bridge-fee-juice.ts as a child process (no mocks), and
// asserts on its log lines: rewording the script's output breaks these tests.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { deriveAccountKeys, deriveDeployerKeys, type AccountKeys } from "../src/aztec-client.js";

const SCRIPT = fileURLToPath(new URL("../scripts/bridge-fee-juice.ts", import.meta.url));
// Test-only key -- never use with real funds.
const KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";

// --address-only exits before any L1 or node access, and the refusals fire
// before any key is used, so the script runs for real with no network.
function run(env: Record<string, string>, args: string[] = []): { status: number | null; out: string } {
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
    const r = run({ PXE_BRIDGE_SECRET_KEY: KEY }, ["--deployer", "--recipient", "0x" + "ab".repeat(32)]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("not both");
  });
});
