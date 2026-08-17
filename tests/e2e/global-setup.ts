import { execSync } from "node:child_process";

const COMPOSE_MANAGED = !process.env["AZTEC_NODE_URL"];

export async function setup(): Promise<void> {
  if (COMPOSE_MANAGED) {
    console.log("[e2e] Starting Aztec sandbox via docker compose...");
    // Only the chain services. The e2e suite builds the bridge in-process via
    // createApp(), so the containerised pxe-bridge is redundant here and
    // starting it would only add an image build to every run.
    execSync("docker compose up -d --wait anvil aztec-sandbox", { stdio: "inherit" });
    process.env["AZTEC_NODE_URL"] = "http://localhost:8080";
  }

  const nodeUrl = process.env["AZTEC_NODE_URL"]!;
  console.log(`[e2e] Waiting for Aztec node at ${nodeUrl}...`);

  const start = Date.now();
  const timeout = 180_000;
  const statusUrl = nodeUrl.replace(/\/$/, "") + "/status";

  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(statusUrl);
      if (res.ok) {
        console.log(`[e2e] Aztec node ready (${Date.now() - start}ms)`);
        return;
      }
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  throw new Error(`Aztec node did not become ready within ${timeout}ms`);
}

export async function teardown(): Promise<void> {
  if (COMPOSE_MANAGED) {
    console.log("[e2e] Stopping Aztec sandbox...");
    execSync("docker compose down", { stdio: "inherit" });
  }
}
