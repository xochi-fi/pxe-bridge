import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TokenContract } from "@aztec-labs/noir-contracts.js/Token";
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import {
  AztecClient,
  DEFAULT_WALLET_DATA_DIRECTORY,
  assertStandardTokenInstance,
  claimWalletDataDirectory,
} from "../src/aztec-client.js";

// Test-only key well under the BN254 Fr modulus -- never use with real funds.
const KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";

// Nothing listens here. Every connect() below must refuse before it is dialled.
const UNREACHABLE_NODE = "http://127.0.0.1:1";

const TOKEN_ADDRESS = "0x" + "0b".repeat(32);

function freshDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pxe-bridge-wallet-dir-test-"));
}

/**
 * xochi-fi/xochi#513: two EmbeddedWallets on one LMDB directory in one process
 * fail with `mdb_txn_begin: 22` once either is garbage-collected. These pin the
 * refusal that replaces that late, unexplained failure.
 */
describe("wallet data directory (xochi-fi/xochi#513)", () => {
  it("lets distinct directories be claimed, returning canonical paths", () => {
    const a = freshDirectory();
    const b = freshDirectory();
    expect(claimWalletDataDirectory(a)).toBe(realpathSync.native(a));
    expect(claimWalletDataDirectory(b)).toBe(realpathSync.native(b));
  });

  it("refuses a second claim on the same directory", () => {
    const dir = freshDirectory();
    claimWalletDataDirectory(dir);
    expect(() => claimWalletDataDirectory(dir)).toThrow(/already open in this process/);
  });

  it("compares resolved paths, so a relative spelling is the same directory", () => {
    const dir = freshDirectory();
    claimWalletDataDirectory(dir);
    expect(() => claimWalletDataDirectory(relative(process.cwd(), dir))).toThrow(
      /already open in this process/,
    );
    expect(() => claimWalletDataDirectory(join(dir, "."))).toThrow(
      /already open in this process/,
    );
  });

  it("follows symlinks, so an alias of a held directory is refused", () => {
    const dir = freshDirectory();
    const alias = join(freshDirectory(), "alias");
    symlinkSync(dir, alias);

    expect(claimWalletDataDirectory(alias)).toBe(realpathSync.native(dir));
    expect(() => claimWalletDataDirectory(dir)).toThrow(/already open in this process/);
  });

  it("creates a missing directory so it can be canonicalized", () => {
    const dir = join(freshDirectory(), "not", "yet");
    expect(claimWalletDataDirectory(dir)).toBe(realpathSync.native(dir));
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses a client on a held directory before opening a wallet", async () => {
    const dir = freshDirectory();
    claimWalletDataDirectory(dir);

    const client = new AztecClient(UNREACHABLE_NODE, KEY, undefined, undefined, {
      dataDirectory: dir,
    });
    await expect(client.connect()).rejects.toThrow(realpathSync.native(dir));
  });

  it("defaults to the SDK's directory, so a single-wallet deploy keeps its stores", async () => {
    expect(DEFAULT_WALLET_DATA_DIRECTORY).toBe("aztec-wallet-data");

    // The claim creates the directory, so run it somewhere disposable rather
    // than in the checkout.
    const cwd = process.cwd();
    process.chdir(freshDirectory());
    try {
      const held = claimWalletDataDirectory(DEFAULT_WALLET_DATA_DIRECTORY);
      const client = new AztecClient(UNREACHABLE_NODE, KEY);
      await expect(client.connect()).rejects.toThrow(held);
    } finally {
      process.chdir(cwd);
    }
  });
});

/**
 * The token address is caller-supplied and a PXE registration is permanent, so
 * only an instance of the standard Token class may be registered.
 */
describe("token instance class check", () => {
  it("admits an instance running the standard Token class", async () => {
    const { id } = await getContractClassFromArtifact(TokenContract.artifact);
    await expect(
      assertStandardTokenInstance(TOKEN_ADDRESS, { currentContractClassId: id }),
    ).resolves.toBeUndefined();
  });

  it("refuses an instance of any other class, naming both classes", async () => {
    const { id: other } = await getContractClassFromArtifact(SponsoredFPCContract.artifact);
    const { id: token } = await getContractClassFromArtifact(TokenContract.artifact);
    const refusal = assertStandardTokenInstance(TOKEN_ADDRESS, { currentContractClassId: other });
    await expect(refusal).rejects.toThrow(/refusing to register it/);
    await expect(refusal).rejects.toThrow(other.toString());
    await expect(refusal).rejects.toThrow(token.toString());
  });
});
