/**
 * Shared plumbing for the live half of the spike. The sender and the recipient
 * are separate PROCESSES, each with its own EmbeddedWallet, its own PXE and its
 * own LMDB data directory, so nothing in one can be read by the other except
 * through the node. The only file both touch is `public.json`, which holds
 * nothing but public material (addresses, the descriptor, a signature).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { Fr } from "@aztec/aztec.js/fields";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { MinedTxStatuses, TxExecutionResult, type TxStatus } from "@aztec/stdlib/tx";

import { headroomGasSettings } from "../../src/aztec-client.js";

export const NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
export const STATE_DIR = process.env["SPIKE_STATE_DIR"] ?? join(tmpdir(), "spike-633");
const PUBLIC_FILE = join(STATE_DIR, "public.json");

/** A private directory for one party: its PXE store and its secrets. */
export function partyDir(party: "sender" | "recipient"): string {
  const dir = join(STATE_DIR, party);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function openWallet(party: "sender" | "recipient"): Promise<EmbeddedWallet> {
  const dataDirectory = join(partyDir(party), "pxe");
  console.log(`[${party}] EmbeddedWallet dataDirectory=${dataDirectory}`);
  return EmbeddedWallet.create(NODE_URL, { pxe: { proverEnabled: true, dataDirectory } });
}

export function readPublic(): Record<string, unknown> {
  return existsSync(PUBLIC_FILE) ? JSON.parse(readFileSync(PUBLIC_FILE, "utf8")) : {};
}

export function writePublic(patch: Record<string, unknown>): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PUBLIC_FILE, JSON.stringify({ ...readPublic(), ...patch }, null, 2));
}

/** SponsoredFPC payment plus the bridge's predicted-fee headroom, for sends. */
export async function sponsoredFee(wallet: EmbeddedWallet) {
  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(0),
  });
  await wallet.registerContract(instance, SponsoredFPCContract.artifact);
  return {
    paymentMethod: new SponsoredFeePaymentMethod(instance.address),
    gasSettings: await headroomGasSettings(NODE_URL),
  };
}

/** Headroom but no payment method, for simulate() (see tests/e2e/helpers.ts). */
export async function simulateFee() {
  return { gasSettings: await headroomGasSettings(NODE_URL) };
}

export function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

/** Enforces one observed value: the first mismatch throws, failing the step. */
export function assertEq(label: string, actual: unknown, expected: unknown): void {
  if (String(actual) !== String(expected)) {
    throw new Error(`FAIL ${label}: got ${String(actual)}, expected ${String(expected)}`);
  }
  console.log(`PASS ${label}  ${String(actual)}`);
}

/** A tx that is in a block and did not revert. */
export function assertTxSucceeded(
  label: string,
  receipt: { status: TxStatus; executionResult?: TxExecutionResult | undefined },
): void {
  assertEq(`${label} executionResult`, receipt.executionResult, TxExecutionResult.SUCCESS);
  const mined = (MinedTxStatuses as readonly TxStatus[]).includes(receipt.status);
  assertEq(`${label} status is mined (${receipt.status})`, mined, true);
}
