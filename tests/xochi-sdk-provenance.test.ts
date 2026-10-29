import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as signer from "@xochi/signer";

type Manifest = {
  schemaVersion: number;
  source: { repository: string; commit: string; commitUrl: string };
  artifacts: Record<string, { sourceUrl: string; sha256: string }>;
};

const typedManifest = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../vendor/xochi-sdk/PROVENANCE.json",
    ),
    "utf8",
  ),
) as Manifest;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/xochi-sdk");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
}

describe("vendored xochi-sdk PR49 artifacts", () => {
  it("matches the pinned commit and hashes", () => {
    expect(typedManifest.schemaVersion).toBe(1);
    expect(typedManifest.source).toEqual({
      repository: "https://github.com/xochi-fi/xochi-sdk",
      commit: "6626f545eade7e6a4226cb7be69f6196fd98f105",
      commitUrl:
        "https://github.com/xochi-fi/xochi-sdk/commit/6626f545eade7e6a4226cb7be69f6196fd98f105",
    });
    for (const [path, expected] of Object.entries(typedManifest.artifacts)) {
      expect(sha256(path), path).toBe(expected.sha256);
      expect(expected.sourceUrl).toContain("github.com/xochi-fi/xochi-sdk");
    }
  });

  it("uses the packaged signer and exposes readiness/recipient verification", () => {
    const require = createRequire(import.meta.url);
    const signerEntry = require.resolve("@xochi/signer");
    const packageJson = JSON.parse(
      readFileSync(resolve(dirname(signerEntry), "..", "package.json"), "utf8"),
    ) as { name: string; version: string };
    expect(packageJson.name).toBe("@xochi/signer");
    expect(packageJson.version).toBe("0.5.1");
    expect(typeof signer.verifyRecipientDescriptor).toBe("function");
    expect(typeof signer.verifyRecipientSchnorr).toBe("function");
    expect(typeof signer.verifyReadinessRecord).toBe("function");
    expect(typeof signer.readinessDigest).toBe("function");
    expect(typeof signer.hashRecipientDescriptor).toBe("function");
  });
});
