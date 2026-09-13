import { execSync } from "node:child_process";

const COMPOSE_MANAGED = !process.env["AZTEC_NODE_URL"];

// Enough to cover the small transfers the note suites make, with room for the
// suites to grow without anyone having to think about it again.
const MINT_AMOUNT = 100_000_000_000_000_000_000_000n; // 100k tokens at 18 decimals

// createNote sends with no explicit fee option, so the bridge account pays out
// of its own fee juice balance. Sized like the spending-limit suite's: one
// claim plus a handful of transfers.
const FEE_JUICE_AMOUNT = 1_000_000_000_000_000_000_000n;

export async function setup(): Promise<void> {
  if (COMPOSE_MANAGED) {
    console.log("[e2e] Starting Aztec sandbox via docker compose...");
    // Only the chain services. The e2e suite builds the bridge in-process via
    // createApp(), so the containerised pxe-bridge is redundant here and
    // starting it would only add an image build to every run.
    execSync("docker compose up -d --wait anvil aztec-sandbox", { stdio: "inherit" });
    process.env["AZTEC_NODE_URL"] = "http://localhost:8080";
  }

  const nodeUrl = process.env["AZTEC_NODE_URL"]!;
  console.log(`[e2e] Waiting for Aztec node at ${nodeUrl}...`);

  const start = Date.now();
  const timeout = 180_000;
  const statusUrl = nodeUrl.replace(/\/$/, "") + "/status";

  let ready = false;
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(statusUrl);
      if (res.ok) {
        console.log(`[e2e] Aztec node ready (${Date.now() - start}ms)`);
        ready = true;
        break;
      }
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!ready) {
    throw new Error(`Aztec node did not become ready within ${timeout}ms`);
  }

  await provisionTestToken(nodeUrl);
}

/**
 * Deploys a token the bridge account can actually spend, and publishes it as
 * E2E_TOKEN_ADDRESS.
 *
 * Without this the note suites read an environment variable nobody set and
 * skipped themselves, so the plain-Schnorr createNote path -- the DEFAULT
 * configuration -- had no executing e2e coverage while CI reported green. The
 * last run before this was written said "18 passed | 2 skipped"; those two
 * skips were the entire default path.
 *
 * Provisioning is three things, not one, and the missing variable hid all
 * three:
 *
 *   1. A token exists. deployTestToken had no caller at all, which is how two
 *      real API mismatches in it survived (see its docstring).
 *   2. The bridge account holds a PUBLIC balance of it. transfer_to_private
 *      debits the public balance, so a private mint would fail inside the token
 *      rather than in anything the bridge owns.
 *   3. The bridge account holds fee juice. createNote sends with no `fee`
 *      option, so unlike the deploy path it cannot fall back to SponsoredFPC
 *      and pays from its own balance, which a fresh sandbox account has none
 *      of.
 *
 * Done here rather than in each suite's beforeAll so the two note files share
 * one deployment instead of provisioning twice against the same sandbox.
 *
 * A failure is recorded rather than thrown. Throwing here fails the whole run,
 * including the spending-limit suite, which provisions its own token and does
 * not care about any of this. The note tests read the recorded message and fail
 * with it, which keeps the blast radius to the tests that actually need a
 * token. Skipping quietly is the one thing not on the table: it is the bug.
 */
async function provisionTestToken(nodeUrl: string): Promise<void> {
  const { AztecClient } = await import("../../src/aztec-client.js");
  const { getTestConfig, deployTestToken, fundFeeJuice, mintOne, mintTo, FUNDER_KEY } =
    await import("./helpers.js");

  try {
    console.log("[e2e] Provisioning test token...");

    // Inside the try: getTestConfig JSON.parses FEE_JUICE_CLAIM and throws on a
    // malformed one, which would otherwise escape as an unrecorded setup crash.
    const config = getTestConfig();

    // A separate account mints and pays. The bridge account cannot mint to
    // itself: it is not the token admin, and making it one would mean the
    // default path under test differs from the deployed one.
    const funder = new AztecClient(nodeUrl, FUNDER_KEY);
    await funder.connect();
    const funderWallet = (funder as unknown as { wallet: unknown }).wallet;
    const funderAddress = funder.getAddress()!;

    const token = await deployTestToken(funderWallet, funderAddress);

    // Deployed here so the suites recover the account rather than racing to
    // deploy it, and so the mint below has an address to credit.
    const bridge = new AztecClient(nodeUrl, config.secretKey);
    await bridge.connect();
    const bridgeAddress = bridge.getAddress()!;

    await mintTo(funderWallet, token, bridgeAddress, MINT_AMOUNT, funderAddress);
    await fundFeeJuice(
      nodeUrl,
      funderWallet,
      funderAddress,
      bridgeAddress,
      FEE_JUICE_AMOUNT,
      () => mintOne(funderWallet, token, funderAddress),
    );

    process.env["E2E_TOKEN_ADDRESS"] = token;
    console.log(`[e2e] Test token ${token} funded to ${bridgeAddress}`);
  } catch (err) {
    process.env["E2E_TOKEN_SETUP_ERROR"] = (err as Error).message;
    console.error(`[e2e] Test token provisioning failed: ${(err as Error).message}`);
  }
}

export async function teardown(): Promise<void> {
  if (COMPOSE_MANAGED) {
    console.log("[e2e] Stopping Aztec sandbox...");
    execSync("docker compose down", { stdio: "inherit" });
  }
}
