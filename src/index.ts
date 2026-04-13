import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AztecClient } from "./aztec-client.js";
import { handleRpcRequest } from "./rpc.js";

const PORT = parseInt(process.env["PXE_BRIDGE_PORT"] ?? "8547", 10);
const AZTEC_NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
const SECRET_KEY = process.env["PXE_BRIDGE_SECRET_KEY"];

if (!SECRET_KEY) {
  console.error("[pxe-bridge] PXE_BRIDGE_SECRET_KEY is required");
  process.exit(1);
}

const client = new AztecClient(AZTEC_NODE_URL, SECRET_KEY);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/status") {
    try {
      const version = await client.getVersion();
      sendJson(res, 200, { status: "ok", version });
    } catch {
      sendJson(res, 503, { status: "starting" });
    }
    return;
  }

  // JSON-RPC endpoint
  if (req.method === "POST" && (req.url === "/" || req.url === "/api/rpc")) {
    try {
      const body = await readBody(req);
      const parsed: unknown = JSON.parse(body);
      const result = await handleRpcRequest(parsed, client);
      sendJson(res, 200, result);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32700, message: `Parse error: ${message}` },
      });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

async function main(): Promise<void> {
  await client.connect();

  server.listen(PORT, () => {
    console.log(`[pxe-bridge] Listening on :${PORT}`);
    console.log(`[pxe-bridge] Node: ${AZTEC_NODE_URL}`);
    console.log(`[pxe-bridge] Endpoints:`);
    console.log(`  POST /           -- JSON-RPC (aztec_createNote, aztec_getVersion)`);
    console.log(`  POST /api/rpc    -- JSON-RPC (alias)`);
    console.log(`  GET  /status     -- Health check`);
  });
}

// Graceful shutdown
function shutdown(): void {
  console.log("[pxe-bridge] Shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  console.error("[pxe-bridge] Fatal:", err);
  process.exit(1);
});
