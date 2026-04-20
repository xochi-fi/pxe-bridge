import { describe, it, expect, beforeAll } from "vitest";
import { AztecClient } from "../../src/aztec-client.js";
import { getTestConfig } from "./helpers.js";

const config = getTestConfig();

describe("AztecClient (e2e)", () => {
  let client: AztecClient;

  beforeAll(async () => {
    client = new AztecClient(config.nodeUrl, config.secretKey, config.feeJuiceClaim);
    await client.connect();
  });

  describe("connect", () => {
    it("connects and deploys or recovers account", () => {
      // connect() succeeded in beforeAll -- account is deployed/recovered
      expect(client).toBeDefined();
    });

    it("is idempotent with same key", async () => {
      const second = new AztecClient(config.nodeUrl, config.secretKey);
      await expect(second.connect()).resolves.toBeUndefined();
    });
  });

  describe("getVersion", () => {
    it("returns a version string from the live node", async () => {
      const version = await client.getVersion();
      expect(version).toBeTruthy();
      expect(typeof version).toBe("string");
      expect(version).not.toBe("unknown");
    });
  });

  describe("createNote", () => {
    // These tests require a deployed token contract.
    // Token deployment is non-trivial and depends on the sandbox state.
    // Skip if no test token address is provided.
    const tokenAddress = process.env["E2E_TOKEN_ADDRESS"];

    it.skipIf(!tokenAddress)("creates a shielded note with valid receipt fields", async () => {
      const result = await client.createNote({
        recipient: tokenAddress!, // use solver's own address for self-transfer
        token: tokenAddress!,
        amount: "1000",
        chainId: 1,
      });

      expect(result.l2TxHash).toBeTruthy();
      expect(result.noteCommitment).toBeTruthy();
      expect(result.nullifierHash).toBeTruthy();
    });

    it("rejects a non-existent token contract", async () => {
      const fakeToken = "0x" + "dead".repeat(16);
      await expect(
        client.createNote({
          recipient: fakeToken,
          token: fakeToken,
          amount: "1000",
          chainId: 1,
        }),
      ).rejects.toThrow();
    });
  });
});
