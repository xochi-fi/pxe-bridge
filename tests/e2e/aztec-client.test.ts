import { describe, it, expect, beforeAll } from "vitest";
import { AztecClient } from "../../src/aztec-client.js";
import { ACCOUNT_ADDRESS_ENV, SCHNORR_CLASS_ID_6_0_0 } from "../../src/account-identity.js";
import { getTestConfig, requireTestToken, walletDataDirectory } from "./helpers.js";

// Never deployed by this suite: the guard refuses before connect() reaches the
// deploy, which is what the test below checks on the node.
const UNRECORDED_KEY = "0x000000000000000000000000000000000000000000000000000000000000f00d";

const config = getTestConfig();

describe("AztecClient (e2e)", () => {
  let client: AztecClient;

  beforeAll(async () => {
    client = new AztecClient(
      config.nodeUrl,
      config.secretKey,
      config.feeJuiceClaim,
      undefined,
      walletDataDirectory("client"),
    );
    await client.connect();
  });

  describe("connect", () => {
    it("connects and deploys or recovers account", () => {
      // connect() succeeded in beforeAll -- account is deployed/recovered
      expect(client).toBeDefined();
    });

    it("is idempotent with same key", async () => {
      const second = new AztecClient(
        config.nodeUrl,
        config.secretKey,
        undefined,
        undefined,
        walletDataDirectory("client-second"),
      );
      await expect(second.connect()).resolves.toBeUndefined();
    });

    it("starts when the derived address is the recorded one", async () => {
      const recorded = new AztecClient(config.nodeUrl, config.secretKey, undefined, undefined, {
        ...walletDataDirectory("client-recorded"),
        expectedAccountAddress: client.getAddress()!,
      });
      await expect(recorded.connect()).resolves.toBeUndefined();
      expect(recorded.getAddress()).toBe(client.getAddress());
    });

    // UPGRADE GUARD -- a key whose account was deployed under an older runtime
    // (5.1.0, 5.2.0) derives a different address under 6.0.0. The bridge must
    // stop there, not deploy an empty account and serve from it.
    it("refuses, before deploying, a key that derives away from the recorded address", async () => {
      const other = new AztecClient(config.nodeUrl, UNRECORDED_KEY, undefined, undefined, {
        ...walletDataDirectory("client-unrecorded"),
        expectedAccountAddress: client.getAddress()!,
      });
      const refusal = await other.connect().then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      const match = new RegExp(
        `^Bridge account derives to (0x[0-9a-f]{64}) \\(contract class ${SCHNORR_CLASS_ID_6_0_0}\\), ` +
          `but ${ACCOUNT_ADDRESS_ENV} is ${client.getAddress()}`,
      ).exec(refusal ?? "");
      expect(match, `connect() should have refused; got: ${refusal}`).not.toBeNull();
      // Unusable after the refusal: nothing to send from.
      expect(other.getAddress()).toBeNull();

      // And nothing was deployed at the address it refused.
      const { createAztecNodeClient } = await import("@aztec-labs/aztec.js/node");
      const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses");
      const derived = AztecAddress.fromStringUnsafe(match![1]!);
      expect(await createAztecNodeClient(config.nodeUrl).getContract(derived)).toBeUndefined();
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
