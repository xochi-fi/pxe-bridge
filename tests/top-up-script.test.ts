import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/top-up-fee-juice.ts", import.meta.url));
const RECIPIENT = "0x" + "ab".repeat(32);

// Each case is refused before any key is resolved or any node is contacted,
// so the script runs for real with no network.
function run(env: Record<string, string>, args: string[] = []): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// Spawning tsx loads the Aztec SDK, which takes seconds.
describe("top-up-fee-juice refusals", { timeout: 60_000 }, () => {
  // `npm run top-up-fee-juice -- --recover <file>` used to be dropped
  // silently, and the run deposited again.
  it("refuses arguments, naming the env equivalent", () => {
    const r = run({ FEE_JUICE_RECIPIENT: RECIPIENT }, ["--recover", "x.json"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("takes no arguments");
    expect(r.out).toContain("--recover is FEE_JUICE_RECOVER");
  });

  it.each(["FEE_JUICE_PAYER_DEPLOYER", "FEE_JUICE_MINT", "FEE_JUICE_PAYER_SPONSORED"])(
    "rejects a %s that is not true or false",
    (name) => {
      const r = run({ FEE_JUICE_RECIPIENT: RECIPIENT, FEE_JUICE_PAYER_KEY: "0x" + "01".repeat(32), [name]: "1" });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`${name} must be "true" or "false", got "1"`);
    },
  );

  it("gates FEE_JUICE_PAYER_SPONSORED on the SponsoredFPC policy", () => {
    const r = run({
      FEE_JUICE_RECIPIENT: RECIPIENT,
      FEE_JUICE_PAYER_KEY: "0x" + "01".repeat(32),
      FEE_JUICE_PAYER_SPONSORED: "true",
      NODE_ENV: "production",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FEE_JUICE_PAYER_SPONSORED=true is refused (NODE_ENV=production)");
  });
});
