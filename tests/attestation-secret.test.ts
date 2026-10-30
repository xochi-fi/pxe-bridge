import { describe, expect, it } from "vitest";
import { recoverAddress } from "viem";
import {
  resolveAttestationSecret,
  Secp256k1ReadinessSigner,
  validateAttestationKey,
} from "../src/attestation-secret.js";

const KEY = "0x" + "31".repeat(32);
const DIGEST = ("0x" + "ab".repeat(32)) as `0x${string}`;
const SECP256K1_ORDER =
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

describe("attestation signing key", () => {
  it("produces a real recoverable secp256k1 signature", async () => {
    const signer = new Secp256k1ReadinessSigner(KEY);
    const signature = await signer.signDigest(DIGEST);

    expect((await recoverAddress({ hash: DIGEST, signature })).toLowerCase()).toBe(
      signer.address.toLowerCase(),
    );
  });

  it.each([
    ["zero", "0x" + "00".repeat(32)],
    ["the curve order", `0x${SECP256K1_ORDER}`],
    ["a non-key string", "not-a-key"],
  ])("rejects %s as a signer key", (_name, key) => {
    expect(() => validateAttestationKey(key)).toThrow();
  });

  it("accepts the largest valid scalar", () => {
    expect(
      validateAttestationKey(
        "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140",
      ),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves a dev-only key and removes it only after successful validation", async () => {
    const env: NodeJS.ProcessEnv = { PXE_BRIDGE_ATTESTATION_SECRET_KEY: KEY };
    const resolved = await resolveAttestationSecret(env);
    expect(resolved.source).toBe("env");
    expect(env["PXE_BRIDGE_ATTESTATION_SECRET_KEY"]).toBeUndefined();

    const invalid: NodeJS.ProcessEnv = { PXE_BRIDGE_ATTESTATION_SECRET_KEY: "bad" };
    await expect(resolveAttestationSecret(invalid)).rejects.toThrow("32 bytes");
    expect(invalid["PXE_BRIDGE_ATTESTATION_SECRET_KEY"]).toBe("bad");
  });
  it("rejects reuse even when custody sources use different encodings", async () => {
    const env: NodeJS.ProcessEnv = { PXE_BRIDGE_ATTESTATION_SECRET_KEY: KEY };
    await expect(
      resolveAttestationSecret(env, [KEY.slice(2).toUpperCase()]),
    ).rejects.toThrow(/must not reuse/);
    expect(env["PXE_BRIDGE_ATTESTATION_SECRET_KEY"]).toBe(KEY);
  });


  it("never accepts the environment signer key in production", async () => {
    await expect(
      resolveAttestationSecret({
        NODE_ENV: "production",
        PXE_BRIDGE_ATTESTATION_SECRET_KEY: KEY,
      }),
    ).rejects.toThrow("required in production");
  });
});
