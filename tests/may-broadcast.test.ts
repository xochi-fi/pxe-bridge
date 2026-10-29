import { describe, it, expect } from "vitest";
import { assertMayBroadcastUrl, httpMayBroadcastClient, MAY_BROADCAST_VERSION } from "../src/may-broadcast.js";

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
  httpMayBroadcastClient({ url: "https://riddler.test/shielded/may-broadcast", token: "svc", fetchImpl, timeoutMs });
const allow = { version: MAY_BROADCAST_VERSION, operationId: "op-1", decision: "allow" };

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
    ["a 503", 503, allow],
    // Only exactly 200 is the contract's answer: a 2xx that is not 200 is a
    // proxy or a stub speaking, and its "allow" was never Riddler's.
    ["a 201", 201, allow],
    ["a 202", 202, allow],
    ["a 203", 203, allow],
    ["a 206", 206, allow],
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

describe("assertMayBroadcastUrl", () => {
  it.each([
    "https://riddler.axol.io/shielded/may-broadcast",
    "https://10.0.0.5:4443/shielded/may-broadcast",
    "http://127.0.0.1:4000/shielded/may-broadcast",
    "http://127.9.9.9/shielded/may-broadcast",
    "http://localhost:4000/shielded/may-broadcast",
    "http://[::1]:4000/shielded/may-broadcast",
  ])("accepts %s", (url) => {
    expect(() => assertMayBroadcastUrl(url)).not.toThrow();
  });

  it.each([
    ["plain http off loopback", "http://riddler.axol.io/shielded/may-broadcast", /must be https/],
    ["plain http to a private address", "http://10.0.0.5:4000/shielded/may-broadcast", /must be https/],
    ["plain http to a lookalike host", "http://127.0.0.1.evil.test/x", /must be https/],
    ["another scheme", "ftp://riddler.test/x", /must be https/],
    ["credentials in the URL", "https://svc:secret@riddler.test/x", /must not carry credentials/],
    ["not a URL", "riddler.test/x", /not a URL/],
  ])("refuses %s", (_name, url, message) => {
    expect(() => assertMayBroadcastUrl(url)).toThrow(message);
  });

  it("is enforced when the client is built, before any query", () => {
    expect(() =>
      httpMayBroadcastClient({ url: "http://riddler.test/shielded/may-broadcast", token: "svc" }),
    ).toThrow(/must be https/);
  });
});
