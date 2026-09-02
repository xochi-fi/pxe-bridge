import { describe, it, expect, beforeAll } from "vitest";
import { AztecClient } from "../../src/aztec-client.js";
import { getTestConfig, requireTestToken } from "./helpers.js";

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
    it("creates a shielded note with valid receipt fields", async () => {
      // Self-transfer. The recipient used to be the TOKEN address, which the
      // comment beside it already described as "the solver's own address" -- a
      // discrepancy nothing caught, because this test never ran.
      const result = await client.createNote({
        recipient: client.getAddress()!,
        token: requireTestToken(),
        amount: "1000",
        chainId: 1,
      });

      expect(result.l2TxHash).toBeTruthy();
      expect(result.noteCommitment).toBeTruthy();
      expect(result.nullifierHash).toBeTruthy();

      // The full effects, and the alias identity types.ts declares. Exact
      // counts are deliberately not pinned here: "two note hashes and three
      // nullifiers" is prose in CLAUDE.md rather than anything the code
      // asserts, and this suite has never once executed, so it is not a
      // number to encode on the strength of a comment.
      expect(result.noteHashes.length).toBeGreaterThan(0);
      expect(result.nullifiers.length).toBeGreaterThan(0);
      expect(result.noteCommitment).toBe(result.noteHashes[0]);
      expect(result.nullifierHash).toBe(result.nullifiers[0]);
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
