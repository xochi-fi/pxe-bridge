import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address";
import { createOxideFundingState } from "../src/oxide/funding.js";
import { OXIDE_V6_MAINNET } from "../src/oxide/pins.js";
import { computeRecipientCommitment } from "../src/oxide/vendor/oxide-lib-tee/recipient_commitment.js";

const SCRIPT = fileURLToPath(new URL("../scripts/fund-oxide.ts", import.meta.url));
const RECIPIENT = `0x${"00".repeat(31)}11`;
const SENDER = "0x1111111111111111111111111111111111111111";
const SALT = `0x${"00".repeat(31)}22`;
let directory: string;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("fund-oxide --dry-run", { timeout: 60_000 }, () => {
  it("prints the resumable plan to stdout and never prints the salt to either stream", async () => {
    directory = mkdtempSync(join(tmpdir(), "fund-oxide-script-"));
    const statePath = join(directory, "state.json");
    const commitment = await computeRecipientCommitment(Fr.fromHexString(SALT), AztecAddress.fromStringUnsafe(RECIPIENT));
    createOxideFundingState(statePath, {
      version: 1,
      phase: "prepared",
      identity: {
        chainId: "1",
        portal: OXIDE_V6_MAINNET.bridge.portal,
        token: OXIDE_V6_MAINNET.bridge.underlying,
        sender: SENDER,
        recipient: RECIPIENT,
        amount: "1",
      },
      sharedSecretSalt: SALT,
      recipientCommitment: commitment.toString(),
    });

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        SCRIPT,
        "--dry-run",
        "--state",
        statePath,
        "--chain-id",
        "1",
        "--token",
        OXIDE_V6_MAINNET.bridge.underlying,
        "--portal",
        OXIDE_V6_MAINNET.bridge.portal,
        "--recipient",
        RECIPIENT,
        "--sender",
        SENDER,
        "--amount",
        "1",
      ],
      {
        env: { PATH: process.env["PATH"] ?? "", PXE_BRIDGE_ACCOUNT_ADDRESS: RECIPIENT },
        encoding: "utf8",
        timeout: 60_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Plan only: no state, approval, deposit, store, or network write was made.");
    expect(result.stdout).toContain("prepared -> approved -> deposited -> message_ready -> stored");
    expect(result.stdout).not.toContain(SALT);
    expect(result.stderr).not.toContain(SALT);
  });
});
