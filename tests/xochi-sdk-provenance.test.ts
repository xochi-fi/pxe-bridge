import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as signer from "@xochi/signer";

const require = createRequire(import.meta.url);

function packageJson(entry: string): { name: string; version: string } {
  return JSON.parse(readFileSync(resolve(dirname(entry), "..", "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
}

// The shielded recipient/readiness fixtures, byte-identical to the copies
// vendored from xochi-sdk commit 50e8dc26 before @xochi/spec 0.11.0 published
// them.
const SPEC_FIXTURES: Record<string, string> = {
  "shielded-recipient.json": "54ecc492b344e62cfdb14fe9906cdb03e0b9f5e967974d78880ee911aae522ad",
  "shielded-recipient.schema.json":
    "eb690d07ae3c71d3e181bea20b4a3cb0f744f21cf87116e76f24c06b0fd2afed",
  "shielded-readiness.json": "4642210afd6bbdaf7a2ea3549ab149595549ecb3c88c9370a0b7ba678ed6e3b4",
  "shielded-readiness.schema.json":
    "adcd94fa20c7bd01d4f25c485ff972e98e2a4cbc07451217e8c1e91ee886153f",
};

describe("published xochi-sdk packages", () => {
  it("installs the pinned @xochi/spec with the pinned shielded fixtures", () => {
    for (const [file, sha256] of Object.entries(SPEC_FIXTURES)) {
      const path = require.resolve(`@xochi/spec/conformance/${file}`);
      expect(packageJson(path)).toMatchObject({ name: "@xochi/spec", version: "0.11.0" });
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), file).toBe(sha256);
    }
  });

  it("uses the pinned signer and exposes readiness/recipient verification", () => {
    expect(packageJson(require.resolve("@xochi/signer"))).toMatchObject({
      name: "@xochi/signer",
      version: "0.6.0",
    });
    expect(typeof signer.verifyRecipientDescriptor).toBe("function");
    expect(typeof signer.verifyRecipientSchnorr).toBe("function");
    expect(typeof signer.verifyReadinessRecord).toBe("function");
    expect(typeof signer.readinessDigest).toBe("function");
    expect(typeof signer.hashRecipientDescriptor).toBe("function");
  });
});
