import type { FeeJuiceClaim } from "../../src/types.js";
import { FeeJuiceClaimSchema } from "../../src/types.js";

export interface E2EConfig {
  nodeUrl: string;
  secretKey: string;
  bridgePort: number;
  feeJuiceClaim?: FeeJuiceClaim;
}

// Test-only key well under BN254 Fr modulus -- never use with real funds
const DEFAULT_SECRET_KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";

export function getTestConfig(): E2EConfig {
  let feeJuiceClaim: FeeJuiceClaim | undefined;
  const raw = process.env["FEE_JUICE_CLAIM"];
  if (raw) {
    const parsed = FeeJuiceClaimSchema.safeParse(JSON.parse(raw));
    if (parsed.success) feeJuiceClaim = parsed.data;
  }

  return {
    nodeUrl: process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080",
    secretKey: process.env["PXE_BRIDGE_SECRET_KEY"] ?? DEFAULT_SECRET_KEY,
    bridgePort: 0, // let OS pick
    feeJuiceClaim,
  };
}

export async function waitForNode(url: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  const statusUrl = url.replace(/\/$/, "") + "/status";

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(statusUrl);
      if (res.ok) return;
    } catch {
      // node not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Aztec node at ${url} did not become ready within ${timeoutMs}ms`);
}

/**
 * SponsoredFPC payment method, so a test account with no fee juice can still
 * send transactions. The bridge uses the same mechanism for its own account
 * deployment; without it every send() fails with "Not enough balance for fee
 * payer to pay for transaction".
 */
export async function sponsoredFee(wallet: unknown): Promise<unknown> {
  const { SponsoredFPCContract } = await import("@aztec/noir-contracts.js/SponsoredFPC");
  const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee/testing");
  const { getContractInstanceFromInstantiationParams } = await import("@aztec/stdlib/contract");
  const { Fr } = await import("@aztec/aztec.js/fields");

  const instance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await (wallet as {
    registerContract: (i: unknown, a: unknown) => Promise<unknown>;
  }).registerContract(instance, SponsoredFPCContract.artifact);
  return new SponsoredFeePaymentMethod(instance.address);
}

/**
 * Deploys an 18-decimal test token with `admin` as its minter.
 *
 * v5.1.0 requires an explicit `from` on send(), and send() resolves to
 * { contract, instance, receipt } after waiting -- not to the contract itself.
 * This helper had never been called (the note tests skip without
 * E2E_TOKEN_ADDRESS) so both mismatches went unnoticed.
 */
export async function deployTestToken(wallet: unknown, admin: string): Promise<string> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const adminAddress = AztecAddress.fromStringUnsafe(admin);

  const { contract } = await (
    TokenContract as unknown as {
      deploy: (
        wallet: unknown,
        admin: unknown,
        name: string,
        symbol: string,
        decimals: number,
      ) => {
        send: (o: { from: unknown; fee: unknown }) => Promise<{
          contract: { address: { toString: () => string } };
        }>;
      };
    }
  )
    .deploy(wallet, adminAddress, "TestToken", "TST", 18)
    .send({ from: adminAddress, fee: { paymentMethod: await sponsoredFee(wallet) } });

  return contract.address.toString();
}
