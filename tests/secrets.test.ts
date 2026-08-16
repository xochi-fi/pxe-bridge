import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the AWS SDK before importing the module under test.
// We intercept SecretsManagerClient at the module level so that
// resolveSecretKey() calls our fake instead of reaching AWS.
const sendStub = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => {
  return {
    SecretsManagerClient: class {
      send = sendStub;
    },
    GetSecretValueCommand: class {
      constructor(public input: unknown) {}
    },
  };
});

// Dynamic import so the mock is in place first
const { resolveSecretKey } = await import("../src/secrets.js");

// Below the BN254 Fr modulus. The old value here started with 0xaa, which is
// about 0.67 of 2^256 and so was never a usable secret key -- the format check
// was the only thing it had to pass.
const VALID_KEY = "0abbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd";

// One increment above the modulus, so it is well-formed hex of the right length
// and fails only the range check.
const ABOVE_MODULUS = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000002";

beforeEach(() => {
  // Clear relevant env vars before each test
  delete process.env["PXE_BRIDGE_SECRET_ARN"];
  delete process.env["PXE_BRIDGE_SECRET_KEY"];
  delete process.env["NODE_ENV"];
  sendStub.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSecretKey", () => {
  describe("env var path", () => {
    it("resolves from PXE_BRIDGE_SECRET_KEY", async () => {
      process.env["PXE_BRIDGE_SECRET_KEY"] = VALID_KEY;

      const result = await resolveSecretKey();
      expect(result.key).toBe(VALID_KEY);
      expect(result.source).toBe("env");
    });

    it("strips 0x prefix", async () => {
      process.env["PXE_BRIDGE_SECRET_KEY"] = `0x${VALID_KEY}`;

      const result = await resolveSecretKey();
      expect(result.key).toBe(VALID_KEY);
      expect(result.source).toBe("env");
    });

    it("rejects invalid hex", async () => {
      process.env["PXE_BRIDGE_SECRET_KEY"] = "not-hex";

      await expect(resolveSecretKey()).rejects.toThrow("32 bytes");
    });

    it("rejects short key", async () => {
      process.env["PXE_BRIDGE_SECRET_KEY"] = "aabb";

      await expect(resolveSecretKey()).rejects.toThrow("32 bytes");
    });

    it("rejects a key at or above the BN254 Fr modulus", async () => {
      process.env["PXE_BRIDGE_SECRET_KEY"] = ABOVE_MODULUS;

      await expect(resolveSecretKey()).rejects.toThrow("valid BN254 field element");
    });

    it("accepts the largest key below the modulus", async () => {
      const maxKey = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000";
      process.env["PXE_BRIDGE_SECRET_KEY"] = maxKey;

      const result = await resolveSecretKey();
      expect(result.key).toBe(maxKey);
    });

    it("throws when neither ARN nor env var set", async () => {
      await expect(resolveSecretKey()).rejects.toThrow(
        "PXE_BRIDGE_SECRET_KEY or PXE_BRIDGE_SECRET_ARN is required",
      );
    });
  });

  describe("production mode", () => {
    it("rejects env var when NODE_ENV=production", async () => {
      process.env["NODE_ENV"] = "production";
      process.env["PXE_BRIDGE_SECRET_KEY"] = VALID_KEY;

      await expect(resolveSecretKey()).rejects.toThrow(
        "PXE_BRIDGE_SECRET_ARN is required in production",
      );
    });

    it("allows ARN in production", async () => {
      process.env["NODE_ENV"] = "production";
      process.env["PXE_BRIDGE_SECRET_ARN"] =
        "arn:aws:secretsmanager:us-east-1:123456789:secret:pxe-key";
      sendStub.mockResolvedValueOnce({ SecretString: VALID_KEY });

      const result = await resolveSecretKey();
      expect(result.key).toBe(VALID_KEY);
      expect(result.source).toBe("secretsmanager");
    });
  });

  describe("Secrets Manager path", () => {
    it("fetches plain hex secret", async () => {
      process.env["PXE_BRIDGE_SECRET_ARN"] = "arn:aws:secretsmanager:test";
      sendStub.mockResolvedValueOnce({ SecretString: VALID_KEY });

      const result = await resolveSecretKey();
      expect(result.key).toBe(VALID_KEY);
      expect(result.source).toBe("secretsmanager");
    });

    it("fetches 0x-prefixed hex secret", async () => {
      process.env["PXE_BRIDGE_SECRET_ARN"] = "arn:aws:secretsmanager:test";
      sendStub.mockResolvedValueOnce({ SecretString: `0x${VALID_KEY}` });

      const result = await resolveSecretKey();
      expect(result.key).toBe(VALID_KEY);
      expect(result.source).toBe("secretsmanager");
    });

    it("fetches JSON secret with key field", async () => {
      process.env["PXE_BRIDGE_SECRET_ARN"] = "arn:aws:secretsmanager:test";
      sendStub.mockResolvedValueOnce({
        SecretString: JSON.stringify({ key: VALID_KEY }),
      });

      const result = await resolveSecretKey();
      expect(result.key).toBe(VALID_KEY);
      expect(result.source).toBe("secretsmanager");
    });

    it("rejects JSON without key field", async () => {
      process.env["PXE_BRIDGE_SECRET_ARN"] = "arn:aws:secretsmanager:test";
      sendStub.mockResolvedValueOnce({
        SecretString: JSON.stringify({ password: VALID_KEY }),
      });

      await expect(resolveSecretKey()).rejects.toThrow('must have a "key" field');
    });

    it("rejects an out-of-range key from Secrets Manager", async () => {
      process.env["PXE_BRIDGE_SECRET_ARN"] = "arn:aws:secretsmanager:us-east-1:1:secret:k";
      sendStub.mockResolvedValue({ SecretString: ABOVE_MODULUS });

      await expect(resolveSecretKey()).rejects.toThrow("valid BN254 field element");
    });

    it("rejects binary/empty secret", async () => {
      process.env["PXE_BRIDGE_SECRET_ARN"] = "arn:aws:secretsmanager:test";
      sendStub.mockResolvedValueOnce({ SecretString: undefined });

      await expect(resolveSecretKey()).rejects.toThrow("binary or empty");
    });

    it("wraps SDK errors", async () => {
      process.env["PXE_BRIDGE_SECRET_ARN"] = "arn:aws:secretsmanager:test";
      sendStub.mockRejectedValueOnce(new Error("AccessDeniedException"));

      await expect(resolveSecretKey()).rejects.toThrow(
        "Failed to fetch secret from Secrets Manager: AccessDeniedException",
      );
    });

    it("ignores env var when ARN is set", async () => {
      process.env["PXE_BRIDGE_SECRET_ARN"] = "arn:aws:secretsmanager:test";
      process.env["PXE_BRIDGE_SECRET_KEY"] = "should-be-ignored";
      sendStub.mockResolvedValueOnce({ SecretString: VALID_KEY });

      const result = await resolveSecretKey();
      expect(result.key).toBe(VALID_KEY);
      expect(result.source).toBe("secretsmanager");
    });
  });
});
