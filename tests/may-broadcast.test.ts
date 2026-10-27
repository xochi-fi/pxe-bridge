import { describe, it, expect } from "vitest";
import { httpMayBroadcastClient, MAY_BROADCAST_VERSION } from "../src/may-broadcast.js";

const query = { operationId: "op-1", fingerprint: "0x" + "a".repeat(64), txHash: "0x" + "b".repeat(64) };

function respond(status: number, body: unknown): { fetchImpl: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input as string, init));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetchImpl, requests };
}

const client = (fetchImpl: typeof fetch, timeoutMs = 1_000) =>
  httpMayBroadcastClient({ url: "http://riddler.test/may-broadcast", token: "svc", fetchImpl, timeoutMs });

describe("httpMayBroadcastClient", () => {
  it.each(["allow", "deny", "unknown"] as const)("passes through an exact %s", async (decision) => {
    const { fetchImpl, requests } = respond(200, {
      version: MAY_BROADCAST_VERSION,
      operationId: "op-1",
      decision,
    });
    expect((await client(fetchImpl)(query)).decision).toBe(decision);
    const sent = requests[0]!;
    expect(sent.headers.get("authorization")).toBe("Bearer svc");
    expect(await sent.json()).toEqual({ version: MAY_BROADCAST_VERSION, ...query });
  });

  it("never turns a timeout into permission", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const answer = await client(hanging, 20)(query);
    expect(answer.decision).toBe("unknown");
    expect(answer.detail).toMatch(/no answer within 20ms/);
  });

  it.each([
    ["a non-2xx status", 503, { version: MAY_BROADCAST_VERSION, operationId: "op-1", decision: "allow" }],
    ["a 401", 401, { error: "unauthorized" }],
    ["a body that is not JSON", 200, "allow"],
    ["a decision outside the contract", 200, { version: MAY_BROADCAST_VERSION, operationId: "op-1", decision: "yes" }],
    ["another operation's answer", 200, { version: MAY_BROADCAST_VERSION, operationId: "op-2", decision: "allow" }],
    ["another version", 200, { version: "v0", operationId: "op-1", decision: "allow" }],
  ])("answers unknown on %s", async (_name, status, body) => {
    const { fetchImpl } = respond(status, body);
    expect((await client(fetchImpl)(query)).decision).toBe("unknown");
  });

  it("answers unknown when the transport fails", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await client(failing)(query)).decision).toBe("unknown");
  });
});
