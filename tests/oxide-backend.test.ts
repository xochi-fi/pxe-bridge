import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Fr } from "@aztec-labs/aztec.js/fields";
import {
  identifyTxBytes,
  loadOxideTokenArtifact,
  orderFingerprintMeta,
  OXIDE_TOKEN_ARTIFACT,
  oxideGasSettings,
  pinnedTokenImmutables,
} from "../src/oxide/backend.js";
import { JournaledBytesInvalid } from "../src/oxide/sender.js";
import { mockTx } from "@aztec-labs/stdlib/testing";
import { computeTokenImmutablesHash } from "../src/oxide/vendor/oxide-lib/token_immutables.js";

describe("Oxide backend policy", () => {
  it("the pinned immutables hash to the deployed OXDAI's on-chain immutablesHash", async () => {
    // The node reports this for 0x11d2...e0a3 (spike, 2026-11-02). Upstream's
    // readOxideTokenImmutables ("Dai Stablecoin"/"DAI") gives 0x02b9fb03..., which is no deployed token.
    expect((await computeTokenImmutablesHash(pinnedTokenImmutables())).toString()).toBe(
      "0x22da781ef4bc49891d089089b0280de85a7ee32881a12b79884f3aa5230a7de6",
    );
  });

  it("sizes explicit gas limits from the simulation, rounding up, and fees from the worst slot", () => {
    const gas = oxideGasSettings({ daGas: 1001, l2Gas: 505_400 }, { daGas: 0, l2Gas: 0 }, { feePerDaGas: 3n, feePerL2Gas: 7n });
    expect(gas.gasLimits).toEqual({ daGas: 1202, l2Gas: 606_480 });
    expect(gas.teardownGasLimits).toEqual({ daGas: 0, l2Gas: 0 });
    expect(gas.maxFeesPerGas).toEqual({ feePerDaGas: 6n, feePerL2Gas: 14n });
    const exact = oxideGasSettings({ daGas: 1, l2Gas: 1 }, { daGas: 0, l2Gas: 0 }, { feePerDaGas: 1n, feePerL2Gas: 1n }, {
      gasMarginBps: 0n,
      feeMultiplier: 1n,
    });
    expect(exact.gasLimits).toEqual({ daGas: 1, l2Gas: 1 });
    expect(() => oxideGasSettings({ daGas: 1, l2Gas: 1 }, { daGas: 0, l2Gas: 0 }, { feePerDaGas: 1n, feePerL2Gas: 1n }, { feeMultiplier: 0n })).toThrow();
  });

  it("carries the order fingerprint as a tag and two 128-bit halves, zero padded", () => {
    const fp = "0x" + "0123456789abcdef".repeat(4);
    const meta = orderFingerprintMeta(fp, 6);
    expect(meta).toHaveLength(6);
    expect(meta[1]!.toBigInt()).toBe(BigInt("0x" + "0123456789abcdef".repeat(2)));
    expect(meta[2]!.toBigInt()).toBe(BigInt("0x" + "0123456789abcdef".repeat(2)));
    expect(meta.slice(3).every((f) => f.equals(Fr.ZERO))).toBe(true);
    expect(meta[0]!.isZero()).toBe(false);
    // A full-width fingerprint (above the field modulus) still encodes.
    expect(() => orderFingerprintMeta("0x" + "ff".repeat(32), 3)).not.toThrow();
    expect(() => orderFingerprintMeta(fp, 2)).toThrow(/needs 3/);
  });
});

describe("identifyTxBytes (real stdlib Tx codec)", () => {
  it("answers the hash recomputed from the data and the expiry inside it", async () => {
    const tx = await mockTx(1);
    const id = await identifyTxBytes(tx.toBuffer());
    expect(id.txHash).toBe(tx.getTxHash().toString().toLowerCase());
    expect(id.expirationTimestamp).toBe(tx.data.expirationTimestamp);
  });

  it("refuses bytes changed after the stored hash prefix, which getTxHash() alone would accept", async () => {
    const bytes = Buffer.from((await mockTx(2)).toBuffer());
    bytes[200] = bytes[200]! ^ 0xff;
    await expect(identifyTxBytes(bytes)).rejects.toBeInstanceOf(JournaledBytesInvalid);
  });
});

/**
 * The artifact is gitignored and built by `npm run build:oxide-token` (CI's
 * `contract` job runs this file after building it). Elsewhere it is absent
 * and these skip.
 */
describe("OxideToken artifact", () => {
  const built = existsSync(OXIDE_TOKEN_ARTIFACT);
  const skipped = built ? "" : ` (skipped: ${OXIDE_TOKEN_ARTIFACT} absent; run \`npm run build:oxide-token\`)`;

  it.skipIf(!built)(`the source build is the deployed OXDAI class${skipped}`, async () => {
    const artifact = await loadOxideTokenArtifact(OXIDE_TOKEN_ARTIFACT);
    expect(artifact.functions.map((f) => f.name)).toEqual(expect.arrayContaining(["transfer", "publish_da", "store_immutables"]));
  });

  it.skipIf(!built)(`refuses the build with one function's bytecode changed${skipped}`, async () => {
    const raw = JSON.parse(readFileSync(OXIDE_TOKEN_ARTIFACT, "utf8")) as { functions: { name: string; bytecode: string }[] };
    const transfer = raw.functions.find((f) => f.name === "transfer")!;
    const at = transfer.bytecode.length >> 1;
    transfer.bytecode = transfer.bytecode.slice(0, at) + (transfer.bytecode[at] === "A" ? "B" : "A") + transfer.bytecode.slice(at + 1);
    const path = join(mkdtempSync(join(tmpdir(), "oxide-artifact-")), "tampered.json");
    writeFileSync(path, JSON.stringify(raw));
    await expect(loadOxideTokenArtifact(path)).rejects.toThrow(/not the pinned 0x27df40f9/);
  });
});
