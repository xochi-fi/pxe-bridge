import type { FeeJuiceClaim } from "../../src/types.js";
import { FeeJuiceClaimSchema } from "../../src/types.js";

export interface E2EConfig {
  nodeUrl: string;
  secretKey: string;
  bridgePort: number;
  feeJuiceClaim?: FeeJuiceClaim;
}

// Test-only key well under BN254 Fr modulus -- never use with real funds
const DEFAULT_SECRET_KEY =
  "0x000000000000000000000000000000000000000000000000000000000000beef";

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

export async function waitForNode(
  url: string,
  timeoutMs = 120_000,
): Promise<void> {
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

  throw new Error(
    `Aztec node at ${url} did not become ready within ${timeoutMs}ms`,
  );
}

export async function deployTestToken(wallet: unknown): Promise<string> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");

  // Deploy a new token with the wallet as admin
  const deployed = await (
    TokenContract as unknown as {
      deploy: (
        wallet: unknown,
        admin: unknown,
        name: string,
        symbol: string,
        decimals: number,
      ) => { send: () => Promise<{ address: { toString: () => string } }> };
    }
  )
    .deploy(wallet, wallet, "TestToken", "TST", 18)
    .send();

  return deployed.address.toString();
}
