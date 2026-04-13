export interface E2EConfig {
  nodeUrl: string;
  secretKey: string;
  bridgePort: number;
}

// Well-known Hardhat/Anvil test key #0 -- never use with real funds
const DEFAULT_SECRET_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function getTestConfig(): E2EConfig {
  return {
    nodeUrl: process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080",
    secretKey: process.env["PXE_BRIDGE_SECRET_KEY"] ?? DEFAULT_SECRET_KEY,
    bridgePort: 0, // let OS pick
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
