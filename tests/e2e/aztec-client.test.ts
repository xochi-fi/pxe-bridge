import { describe, it, expect, beforeAll } from "vitest";
import { AztecClient } from "../../src/aztec-client.js";
import { ACCOUNT_ADDRESS_ENV, SCHNORR_CLASS_ID_6_0_0 } from "../../src/account-identity.js";
import {
  getTestConfig,
  proveMinedPayout,
  recordingGate,
  requireTestToken,
  walletDataDirectory,
} from "./helpers.js";

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
        undefined,
        walletDataDirectory("client-second"),
      );
      await expect(second.connect()).resolves.toBeUndefined();
    });

    it("starts when the derived address is the recorded one", async () => {
      const recorded = new AztecClient(config.nodeUrl, config.secretKey, undefined, undefined, undefined, {
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
      const other = new AztecClient(config.nodeUrl, UNRECORDED_KEY, undefined, undefined, undefined, {
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
    it("broadcasts exactly the transaction the gate saw, and reports it mined", async () => {
      // Self-transfer. The recipient used to be the TOKEN address, which the
      // comment beside it already described as "the solver's own address" -- a
      // discrepancy nothing caught, because this test never ran.
      const gate = recordingGate();
      const result = await client.createNote(
        { recipient: client.getAddress()!, token: requireTestToken(), amount: "1000" },
        gate,
      );

      // The hash journaled before the broadcast is the one that landed: the
      // identity the recovery path depends on.
      expect(gate.seen).toHaveLength(1);
      expect(result.txHash).toBe(gate.seen[0]!.txHash);
      expect(gate.seen[0]!.txBytes.length).toBeGreaterThan(0);
      expect(gate.seen[0]!.expirationTimestamp).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
      expect(result.observation).toMatchObject({ kind: "mined", executionResult: "success" });
      if (result.observation.kind === "mined") {
        expect(result.observation.effects.noteHashes.length).toBeGreaterThan(0);
        expect(result.observation.effects.nullifiers.length).toBeGreaterThan(0);
      }
      expect(await client.observeTx(result.txHash)).toMatchObject({ kind: "mined" });

      // The plain Schnorr path captures the same randomness (#78).
      const proof = await proveMinedPayout(config.nodeUrl, {
        txHash: result.txHash,
        token: requireTestToken(),
        recipient: client.getAddress()!,
        payoutAccount: client.getAddress()!,
        amount: 1000n,
        partialNoteRandomness: gate.seen[0]!.partialNoteRandomness,
        txBytes: gate.seen[0]!.txBytes,
      });
      expect(proof.commitmentFromBytes).toBe(proof.partialCommitment);
      expect(proof.noteHashes).toContain(proof.uniqueNoteHash);
      expect(proof.nullifiers).toContain(proof.siloedValidityNullifier);
    });

    it("sends nothing when the gate refuses", async () => {
      const gate = recordingGate(new Error("held"));
      await expect(
        client.createNote(
          { recipient: client.getAddress()!, token: requireTestToken(), amount: "1000" },
          gate,
        ),
      ).rejects.toThrow("held");
      expect(gate.seen).toHaveLength(1);
      expect(await client.observeTx(gate.seen[0]!.txHash)).toEqual({ kind: "dropped" });
    });

    it("rejects a non-existent token contract before the gate", async () => {
      const fakeToken = "0x" + "dead".repeat(16);
      const gate = recordingGate();
      await expect(
        client.createNote({ recipient: fakeToken, token: fakeToken, amount: "1000" }, gate),
      ).rejects.toThrow();
      expect(gate.seen).toHaveLength(0);
    });

    it("reports the node's network identity", async () => {
      const network = await client.networkIdentity();
      expect(network.aztecChainId).toBe(network.l1ChainId);
      expect(network.rollupAddress).toMatch(/^0x[0-9a-f]{40}$/);
    });
  });
});
