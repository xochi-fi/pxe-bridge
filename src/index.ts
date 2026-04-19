import { AztecClient } from "./aztec-client.js";
import { createApp } from "./server.js";
import { FeeJuiceClaimSchema } from "./types.js";

const PORT = parseInt(process.env["PXE_BRIDGE_PORT"] ?? "8547", 10);
if (isNaN(PORT) || PORT < 0 || PORT > 65535) {
  console.error("[pxe-bridge] PXE_BRIDGE_PORT must be 0-65535");
  process.exit(1);
}
const HOST = process.env["PXE_BRIDGE_HOST"] ?? "127.0.0.1";
const AZTEC_NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
const SECRET_KEY = process.env["PXE_BRIDGE_SECRET_KEY"];
const API_KEY = process.env["PXE_BRIDGE_API_KEY"];

if (!SECRET_KEY) {
  console.error("[pxe-bridge] PXE_BRIDGE_SECRET_KEY is required");
  process.exit(1);
}

const keyHex = SECRET_KEY.replace(/^0x/, "");
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
  console.error(
    "[pxe-bridge] PXE_BRIDGE_SECRET_KEY must be 32 bytes (64 hex chars)",
  );
  process.exit(1);
}

if (!API_KEY) {
  console.warn(
    "[pxe-bridge] WARNING: PXE_BRIDGE_API_KEY not set -- RPC endpoint is unauthenticated",
  );
}

let feeJuiceClaim;
const FEE_JUICE_CLAIM_RAW = process.env["FEE_JUICE_CLAIM"];
if (FEE_JUICE_CLAIM_RAW) {
  let json: unknown;
  try {
    json = JSON.parse(FEE_JUICE_CLAIM_RAW);
  } catch {
    console.error("[pxe-bridge] FEE_JUICE_CLAIM is not valid JSON");
    process.exit(1);
  }
  const parsed = FeeJuiceClaimSchema.safeParse(json);
  if (!parsed.success) {
    console.error(
      "[pxe-bridge] FEE_JUICE_CLAIM must be: {claimAmount, claimSecret, messageLeafIndex}",
    );
    process.exit(1);
  }
  feeJuiceClaim = parsed.data;
}

const client = new AztecClient(AZTEC_NODE_URL, SECRET_KEY, feeJuiceClaim);
const server = createApp(client, { apiKey: API_KEY });

async function main(): Promise<void> {
  await client.connect();

  server.listen(PORT, HOST, () => {
    console.log(`[pxe-bridge] Listening on ${HOST}:${PORT}`);
    console.log(`[pxe-bridge] Node: ${AZTEC_NODE_URL}`);
    console.log(`[pxe-bridge] Auth: ${API_KEY ? "enabled" : "DISABLED"}`);
    console.log(`[pxe-bridge] Endpoints:`);
    console.log(
      `  POST /           -- JSON-RPC (aztec_createNote, aztec_getVersion)`,
    );
    console.log(`  POST /api/rpc    -- JSON-RPC (alias)`);
    console.log(`  GET  /status     -- Health check`);
  });
}

function shutdown(): void {
  console.log("[pxe-bridge] Shutting down...");
  const timer = setTimeout(() => process.exit(1), 5000);
  server.close(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  console.error("[pxe-bridge] Fatal:", err);
  process.exit(1);
});
