import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { boundedNodeFetch } from "../src/aztec-client.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("boundedNodeFetch", () => {
  it("aborts a hung node request and permits a later observation", async () => {
    let hang = true;
    const server = createServer((_req, res) => {
      if (hang) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ready" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind TCP");
    const url = `http://127.0.0.1:${address.port}`;
    const transport = boundedNodeFetch(1_000);
    await expect(
      transport(url, { jsonrpc: "2.0", id: 1, method: "node_getNodeInfo" }),
    ).rejects.toThrow("Aztec node request timed out");

    hang = false;
    await expect(
      transport(url, { jsonrpc: "2.0", id: 1, method: "node_getNodeInfo" }),
    ).resolves.toMatchObject({
      response: { jsonrpc: "2.0", id: 1, result: "ready" },
    });
  });

  it("preserves JSON-RPC errors returned with a non-success status", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "Existing nullifier\n[audit]\u001b[2J" },
          },
        ]),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind TCP");

    const transport = boundedNodeFetch(1_000);
    await expect(
      transport(`http://127.0.0.1:${address.port}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "node_sendTx",
      }),
    ).rejects.toThrow("Aztec node returned HTTP 400: Existing nullifier?[audit]?[2J");
  });

  it("composes the caller cancellation with its transport deadline", async () => {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind TCP");

    const caller = new AbortController();
    const transport = boundedNodeFetch(60_000, caller.signal);
    const pending = transport(`http://127.0.0.1:${address.port}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "node_getNodeInfo",
    });
    caller.abort(new Error("readiness deadline exceeded"));

    await expect(pending).rejects.toThrow("readiness deadline exceeded");
  });
});
