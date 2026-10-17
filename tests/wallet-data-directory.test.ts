import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  AztecClient,
  DEFAULT_WALLET_DATA_DIRECTORY,
  claimWalletDataDirectory,
} from "../src/aztec-client.js";

// Test-only key well under the BN254 Fr modulus -- never use with real funds.
const KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";

// Nothing listens here. Every connect() below must refuse before it is dialled.
const UNREACHABLE_NODE = "http://127.0.0.1:1";

function freshDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pxe-bridge-wallet-dir-test-"));
}

/**
 * xochi-fi/xochi#513: two EmbeddedWallets on one LMDB directory in one process
 * fail with `mdb_txn_begin: 22` once either is garbage-collected. These pin the
 * refusal that replaces that late, unexplained failure.
 */
describe("wallet data directory (xochi-fi/xochi#513)", () => {
  it("lets distinct directories be claimed", () => {
    const a = freshDirectory();
    const b = freshDirectory();
    expect(claimWalletDataDirectory(a)).toBe(resolve(a));
    expect(claimWalletDataDirectory(b)).toBe(resolve(b));
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

  it("refuses a client on a held directory before opening a wallet", async () => {
    const dir = freshDirectory();
    claimWalletDataDirectory(dir);

    const client = new AztecClient(UNREACHABLE_NODE, KEY, undefined, undefined, {
      dataDirectory: dir,
    });
    await expect(client.connect()).rejects.toThrow(resolve(dir));
  });

  it("defaults to the SDK's directory, so a single-wallet deploy keeps its stores", async () => {
    expect(DEFAULT_WALLET_DATA_DIRECTORY).toBe("aztec-wallet-data");

    claimWalletDataDirectory(DEFAULT_WALLET_DATA_DIRECTORY);
    const client = new AztecClient(UNREACHABLE_NODE, KEY);
    await expect(client.connect()).rejects.toThrow(resolve(DEFAULT_WALLET_DATA_DIRECTORY));
  });
});
