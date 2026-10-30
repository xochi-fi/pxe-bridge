/**
 * Shared plumbing for the live half of the testnet spike. The recipient runs
 * in its own process with its own EmbeddedWallet, PXE and LMDB data
 * directory; `public.json` holds nothing but public material (address,
 * descriptor, tx hashes).
 *
 * Everything here imports the @aztec-labs 6.0.0 SDK from this directory's own
 * node_modules. Nothing imports ../../src, whose @aztec 5.2.0 runtime would
 * otherwise mix two SDKs in one process.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee/testing";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { type AztecNodeClientOptions, createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC";
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract";
import { GasFees, ManaUsageEstimate } from "@aztec-labs/stdlib/gas";
import { MinedTxStatuses, TxExecutionResult, type TxStatus } from "@aztec-labs/stdlib/tx";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import { z } from "zod";

import { TESTNET_NODE_URL, TESTNET_SPONSORED_FPC } from "./expected.js";

export const NODE_URL = process.env["AZTEC_NODE_URL"] ?? TESTNET_NODE_URL;
/** Required (run.sh makes a fresh one per run). Empty would resolve to the cwd. */
export const STATE_DIR = process.env["SPIKE_STATE_DIR"] ?? "";
/**
 * The documented public endpoint (drpc.org) refuses a JSON-RPC batch of more
 * than 3 calls on its free plan ("Batch of more than 3 requests are not
 * allowed on free plan", HTTP 500), and the SDK client batches up to 100 by
 * default, which failed the PXE's kernel-hint prefetch. Cap it; a transport
 * setting only, no call changes.
 */
const NODE_CLIENT_OPTIONS: AztecNodeClientOptions = {
  maxBatchSize: Number(process.env["SPIKE_RPC_MAX_BATCH"] ?? "3"),
};
export function nodeClient() {
  return createAztecNodeClient(NODE_URL, NODE_CLIENT_OPTIONS);
}
const PUBLIC_FILE = join(STATE_DIR, "public.json");

function stateDir(): string {
  if (STATE_DIR === "") throw new Error("SPIKE_STATE_DIR must be set to a non-empty directory");
  return STATE_DIR;
}

/** The recipient's private directory: its PXE store and its secrets. */
export function partyDir(party: "recipient"): string {
  const dir = join(stateDir(), party);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function openWallet(party: "recipient"): Promise<EmbeddedWallet> {
  const dataDirectory = join(partyDir(party), "pxe");
  console.log(`[${party}] EmbeddedWallet node=${NODE_URL} dataDirectory=${dataDirectory} proverEnabled=true`);
  return EmbeddedWallet.create(NODE_URL, {
    pxe: { proverEnabled: true, dataDirectory },
    nodeClientOptions: NODE_CLIENT_OPTIONS,
  });
}

export function readPublic(): Record<string, unknown> {
  stateDir();
  return existsSync(PUBLIC_FILE) ? JSON.parse(readFileSync(PUBLIC_FILE, "utf8")) : {};
}

export function writePublic(patch: Record<string, unknown>): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(PUBLIC_FILE, JSON.stringify({ ...readPublic(), ...patch }, null, 2));
}

/** The SponsoredFPC the SDK derives (salt 0), held to the documented testnet address. */
export async function sponsoredFpcInstance() {
  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(0),
  });
  assertEq("SponsoredFPC address derived by the 6.0.0 SDK == documented testnet address", instance.address, TESTNET_SPONSORED_FPC);
  return instance;
}

/**
 * Fee ceiling with headroom over every predicted slot, mirroring the bridge's
 * `headroomGasSettings` (src/aztec-client.ts) on the 6.0.0 SDK. A ceiling,
 * not a charge: undershooting fails the send.
 */
const FEE_HEADROOM = 10n;
export async function headroomGasSettings(): Promise<{ maxFeesPerGas: GasFees }> {
  const predicted = await nodeClient().getPredictedMinFees(ManaUsageEstimate.Limit);
  const worst = predicted.reduce(
    (acc, fees) => ({
      da: fees.feePerDaGas > acc.da ? fees.feePerDaGas : acc.da,
      l2: fees.feePerL2Gas > acc.l2 ? fees.feePerL2Gas : acc.l2,
    }),
    { da: 0n, l2: 0n },
  );
  return { maxFeesPerGas: new GasFees(worst.da * FEE_HEADROOM, worst.l2 * FEE_HEADROOM) };
}

/** SponsoredFPC payment plus fee headroom, for sends. */
export async function sponsoredFee(wallet: EmbeddedWallet) {
  const instance = await sponsoredFpcInstance();
  await wallet.registerContract(instance, SponsoredFPCContract.artifact);
  return {
    paymentMethod: new SponsoredFeePaymentMethod(instance.address),
    gasSettings: await headroomGasSettings(),
  };
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

/** The node client takes no abort signal; race each call against a bound. */
export const RPC_TIMEOUT_MS = 30_000;
export async function bounded<T>(what: string, call: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${RPC_TIMEOUT_MS} ms`)), RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The L2 block the node says a class was published in, or undefined if it
 * has no record. Raw JSON-RPC: the node returns `l2BlockNumber` with the
 * class, but the SDK's ContractClassPublic schema strips it.
 */
const ClassRecordResponse = z.object({
  result: z.object({ id: z.string(), l2BlockNumber: z.number().int() }).nullable(),
});
export async function classRecordBlock(classId: string): Promise<number | undefined> {
  const res = await fetch(NODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getContractClass", params: [classId] }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`node_getContractClass(${classId}): HTTP ${res.status}`);
  const { result } = ClassRecordResponse.parse(await res.json());
  if (result === null) return undefined;
  if (result.id.toLowerCase() !== classId.toLowerCase()) {
    throw new Error(`node_getContractClass(${classId}) answered for class ${result.id}`);
  }
  return result.l2BlockNumber;
}
