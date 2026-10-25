import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/bridge-fee-juice.ts", import.meta.url));
const ADMIN = "0x" + "ab".repeat(32);
const OTHER = "0x" + "cd".repeat(32);

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
