import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { mkdtempSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { AllowlistTree } from "../../src/allowlist-tree.js";
import type { AccountDeployment } from "../../src/types.js";
import { AztecClient } from "../../src/aztec-client.js";
import { SETTLEMENT_VERSION } from "../../src/settlement.js";
import { SettlementJournal } from "../../src/journal.js";
import { MAY_BROADCAST_VERSION } from "../../src/may-broadcast.js";
import {
  advanceFinalizedTip,
  FUNDER_KEY,
  fundFeeJuice,
  getTestConfig,
  mintOne,
  mintTo,
  registerPublished,
  requireTestToken,
  walletDataDirectory,
} from "./helpers.js";

/**
 * HARD-CRASH SMOKE (xochi-fi/pxe-bridge#45). A real bridge process, a real
 * sandbox, and a SIGKILL in the middle of the broadcast; then a restart on the
 * same journal and a retry of the same operation. The account's public token
 * balance is the credit evidence: `transfer_to_private` debits it exactly once
 * per landed transfer, so "one credit" is "debited by exactly the amount".
 *
 * The kill is placed by a proxy between the bridge and the node, on the one
 * call that broadcasts (`aztec_sendTx`):
 *   - `after_node_accepts`: the node has the transaction, the bridge dies
 *     before it hears so. Recovery must find it, never send a second one.
 *   - `before_node_sees`: the bridge has marked may-broadcast and dies before
 *     the node has anything. Recovery must re-broadcast the journaled bytes,
 *     never prove a new transaction.
 */

const config = getTestConfig();
const REPO = resolve(import.meta.dirname, "../..");
const AMOUNT = "777";
const CORRIDOR = {
  corridorId: "0x" + "c1".repeat(32),
  corridorRevision: 1,
  manifestDigest: "0x" + "d1".repeat(32),
  genesisOrNetworkDigest: "0x" + "e1".repeat(32),
};
const SERVICE_TOKEN = "smoke-service-credential";
const RPC_KEY = "smoke-rpc-key";
const MAX_PER_TX = 1_000_000n;
const DAILY_LIMIT = 10_000_000n;
const INVENTORY = 100_000_000n;
const ALLOWLIST_SEED = "0x" + "07".repeat(32);
const FEE_JUICE_AMOUNT = 1_000_000_000_000_000_000_000n;
const RECIPIENT = "0x" + "08".repeat(32);

type KillPoint = "after_node_accepts" | "before_node_sees";

interface Bridge {
  child: ChildProcess;
  url: string;
  exited: Promise<number | null>;
}

function listen(server: Server): Promise<number> {
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      done(addr && typeof addr === "object" ? addr.port : 0);
    }),
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

function sendsTx(raw: Buffer, encoding: string | undefined): boolean {
  try {
    const text = (encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
    const body = JSON.parse(text) as { method?: string } | { method?: string }[];
    return (Array.isArray(body) ? body : [body]).some((c) => c.method === "aztec_sendTx");
  } catch {
    return false;
  }
}

describe("hard crash mid-broadcast (e2e)", () => {
  let observer: AztecClient;
  let account: string;
  let token: string;
  let admin: string;
  let deployment: AccountDeployment;
  let proxy: Server;
  let proxyUrl: string;
  let gate: Server;
  let gateUrl: string;
  const gateCalls: string[] = [];
  let killPoint: KillPoint | undefined;
  // Kill the bridge while its may-broadcast query is in flight: prepared and
  // journaled, never marked.
  let killOnGate = false;
  let bridge: Bridge | undefined;
  let killed = 0;

  async function publicBalance(): Promise<bigint> {
    const { TokenContract } = await import("@aztec-labs/noir-contracts.js/Token");
    const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses");
    const wallet = (observer as unknown as { wallet: unknown }).wallet;
    await registerPublished(wallet, token, TokenContract.artifact);
    const contract = await (
      TokenContract as unknown as {
        at: (a: unknown, w: unknown) => Promise<{
          methods: Record<string, (...a: unknown[]) => { simulate: (o?: unknown) => Promise<unknown> }>;
        }>;
      }
    ).at(AztecAddress.fromStringUnsafe(token), wallet);
    const raw = await contract.methods["balance_of_public"]!(AztecAddress.fromStringUnsafe(account)).simulate({
      from: AztecAddress.fromStringUnsafe(account),
    });
    const value = (raw as { result?: unknown })?.result ?? raw;
    return BigInt((value as { toString(): string }).toString());
  }

  async function startBridge(
    workDir: string,
    journal: string,
    corridor: typeof CORRIDOR = CORRIDOR,
  ): Promise<Bridge> {
    // A port the OS just handed out, released for the bridge to bind.
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((done) => probe.close(() => done()));
    const child = spawn(process.execPath, [join(REPO, "dist/index.js")], {
      cwd: workDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        AZTEC_NODE_URL: proxyUrl,
        PXE_BRIDGE_SECRET_KEY: config.secretKey,
        PXE_BRIDGE_ACCOUNT_ADDRESS: account,
        PXE_BRIDGE_SPENDING_LIMIT_ADMIN: admin,
        PXE_BRIDGE_SPENDING_LIMIT_TOKEN: token,
        PXE_BRIDGE_ALLOWLIST_SEED: ALLOWLIST_SEED,
        PXE_BRIDGE_ALLOWLIST_RECIPIENTS: JSON.stringify([{ address: RECIPIENT, index: 347 }]),
        PXE_BRIDGE_ACCOUNT_DEPLOYMENT: JSON.stringify(deployment),
        PXE_BRIDGE_MAX_AMOUNT: MAX_PER_TX.toString(),
        PXE_BRIDGE_DAILY_LIMIT: DAILY_LIMIT.toString(),
        PXE_BRIDGE_API_KEY: RPC_KEY,
        PXE_BRIDGE_PORT: String(port),
        PXE_BRIDGE_JOURNAL: journal,
        PXE_BRIDGE_SETTLEMENT_CORRIDOR: JSON.stringify(corridor),
        PXE_BRIDGE_MAY_BROADCAST_URL: gateUrl,
        PXE_BRIDGE_MAY_BROADCAST_TOKEN: SERVICE_TOKEN,
        PXE_BRIDGE_AUDIT_LOG: join(workDir, "audit.jsonl"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout?.on("data", (c: Buffer) => (log += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (log += c.toString()));
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 170_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`bridge exited during startup:\n${log}`);
      try {
        const res = await fetch(`${url}/status`);
        if (res.status === 200) return { child, url, exited };
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    child.kill("SIGKILL");
    throw new Error(`bridge did not become ready:\n${log}`);
  }

  async function rpc(url: string, method: string, params: unknown, operationId?: string) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${RPC_KEY}`,
        ...(operationId ? { "idempotency-key": operationId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [params] }),
    });
    return (await res.json()) as {
      result?: Record<string, unknown> & { observation: { state: string; txHash?: string } };
      error?: { code: number; data?: { observation?: { state: string } } };
    };
  }

  async function terms(operationId: string) {
    const network = await observer.networkIdentity();
    return {
      version: SETTLEMENT_VERSION,
      operationId,
      network: { ...network, genesisOrNetworkDigest: CORRIDOR.genesisOrNetworkDigest },
      corridor: {
        corridorId: CORRIDOR.corridorId,
        corridorRevision: CORRIDOR.corridorRevision,
        manifestDigest: CORRIDOR.manifestDigest,
      },
      accountMode: "spending_limit",
      recipient: RECIPIENT,
      recipientDescriptorDigest: "0x" + "ab".repeat(32),
      token,
      amount: AMOUNT,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  beforeAll(async () => {
    execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "inherit" });
    token = requireTestToken();
    const funder = new AztecClient(
      config.nodeUrl,
      FUNDER_KEY,
      undefined,
      undefined,
      undefined,
      walletDataDirectory("crash-funder"),
    );
    await funder.connect();
    admin = funder.getAddress()!;
    // Test access to the SDK wallet is unavailable on AztecClient's public API.
    const funderInternal = funder as unknown as { wallet: unknown };
    const funderWallet = funderInternal.wallet;
    observer = new AztecClient(
      config.nodeUrl,
      config.secretKey,
      undefined,
      {
        maxAmountPerTx: MAX_PER_TX,
        dailyLimit: DAILY_LIMIT,
        admin,
        token,
        allowlistSeed: ALLOWLIST_SEED,
        allowlistRecipients: [{ address: RECIPIENT, index: 347 }],
      },
      undefined,
      walletDataDirectory("crash-observer"),
    );
    await observer.connect();
    account = observer.getAddress()!;
    const { TokenContract } = await import("@aztec-labs/noir-contracts.js/Token");
    await registerPublished(funderWallet, token, TokenContract.artifact);
    await mintTo(funderWallet, token, account, INVENTORY, admin);
    await fundFeeJuice(
      config.nodeUrl,
      funderWallet,
      admin,
      account,
      FEE_JUICE_AMOUNT,
      () => mintOne(funderWallet, token, admin),
    );
    await advanceFinalizedTip(
      config.nodeUrl,
      () => mintOne(funderWallet, token, admin),
    );
    const tree = await AllowlistTree.build(ALLOWLIST_SEED, [
      { address: RECIPIENT, index: 347 },
    ]);
    deployment = {
      address: account,
      maxAmountPerTx: MAX_PER_TX.toString(),
      dailyLimit: DAILY_LIMIT.toString(),
      admin,
      token,
      allowlistRoot: tree.root.toString(),
    };

    // The may-broadcast endpoint Riddler would serve: allow, authenticated.
    gate = createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)).toString("utf8")) as { operationId: string };
      const ok = req.headers["authorization"] === `Bearer ${SERVICE_TOKEN}`;
      gateCalls.push(body.operationId);
      if (killOnGate) {
        killOnGate = false;
        killed += 1;
        bridge?.child.kill("SIGKILL");
        res.destroy();
        return;
      }
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ version: MAY_BROADCAST_VERSION, operationId: body.operationId, decision: "allow" }),
      );
    });
    gateUrl = `http://127.0.0.1:${await listen(gate)}/xochi/aztec/may-broadcast`;

    // Node proxy that kills the bridge around its one broadcasting call.
    const node = new URL(config.nodeUrl);
    proxy = createServer(async (req, res) => {
      const raw = await readBody(req);
      const encoding = req.headers["content-encoding"];
      const broadcasting = killPoint !== undefined && sendsTx(raw, encoding as string | undefined);
      if (broadcasting && killPoint === "before_node_sees") {
        killPoint = undefined;
        killed += 1;
        bridge?.child.kill("SIGKILL");
        res.destroy();
        return;
      }
      const upstream = httpRequest(
        {
          hostname: node.hostname,
          port: node.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: node.host },
        },
        (up) => {
          const chunks: Buffer[] = [];
          up.on("data", (c: Buffer) => chunks.push(c));
          up.on("end", () => {
            if (broadcasting && killPoint === "after_node_accepts") {
              killPoint = undefined;
              killed += 1;
              bridge?.child.kill("SIGKILL");
              res.destroy();
              return;
            }
            res.writeHead(up.statusCode ?? 502, up.headers);
            res.end(Buffer.concat(chunks));
          });
        },
      );
      upstream.on("error", () => res.destroy());
      upstream.end(raw);
    });
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  }, 600_000);

  afterAll(async () => {
    bridge?.child.kill("SIGKILL");
    await new Promise<void>((done) => proxy?.close(() => done()));
    await new Promise<void>((done) => gate?.close(() => done()));
  });

  /**
   * The shared account predates every journal here, so each one is adopted
   * before the bridge first opens it -- with the one-shot acknowledgement
   * bound to THIS journal's id (D-B), exactly as an operator would.
   */
  function adoptedJournal(workDir: string): string {
    const path = join(workDir, "journal.sqlite");
    const journal = SettlementJournal.open(path);
    journal.bindAccount(account, true, { acknowledgement: `${account}@${journal.meta().journalId}` });
    expect(journal.health()).toEqual({ writable: true });
    journal.close();
    return path;
  }

  it.each(["after_node_accepts", "before_node_sees"] as const)(
    "credits exactly once after a SIGKILL %s and a restart",
    async (point) => {
      const workDir = mkdtempSync(join(tmpdir(), "pxe-crash-"));
      const journal = adoptedJournal(workDir);
      const operationId = `crash-${point}-${randomBytes(4).toString("hex")}`;
      const params = await terms(operationId);
      const before = await publicBalance();
      bridge = await startBridge(workDir, journal);
      killPoint = point;
      const first = await rpc(bridge.url, "aztec_createNote", params, operationId).catch(
        (err: unknown) => err,
      );
      expect(first, "the first response must be lost to the kill").toBeInstanceOf(Error);
      expect(await bridge.exited).toBeNull();
      expect(killed).toBeGreaterThan(0);

      // Restart on the same journal. The operation is marked, so recovery must
      // resolve it, not prepare a new transaction.
      bridge = await startBridge(workDir, journal);
      const recovered = await rpc(bridge.url, "aztec_getSettlement", {
        version: SETTLEMENT_VERSION,
        operationId,
      });
      expect(recovered.result).toMatchObject({ found: true, state: "may_broadcast" });
      const attempts = recovered.result!["attempts"] as { mayBroadcast: boolean }[];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.mayBroadcast).toBe(true);

      const retry = await rpc(bridge.url, "aztec_createNote", params, operationId);
      expect(["pending", "included", "finalized"]).toContain(retry.result?.observation.state);

      // Poll until the node has it mined, then check the one credit.
      const deadline = Date.now() + 120_000;
      let state = retry.result?.observation.state;
      while (state === "pending" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_000));
        state = (
          await rpc(bridge.url, "aztec_getSettlement", { version: SETTLEMENT_VERSION, operationId })
        ).result?.observation.state;
      }
      expect(["included", "finalized"]).toContain(state);
      expect(before - (await publicBalance())).toBe(BigInt(AMOUNT));

      // A further retry still sends nothing.
      const again = await rpc(bridge.url, "aztec_createNote", params, operationId);
      expect(again.result?.observation.txHash).toBe(retry.result?.observation.txHash);
      expect(before - (await publicBalance())).toBe(BigInt(AMOUNT));
      expect(gateCalls.filter((id) => id === operationId)).toHaveLength(1);

      bridge.child.kill("SIGTERM");
      await bridge.exited;
      bridge = undefined;
    },
    600_000,
  );

  it("resumes the exact prepared bytes after a SIGKILL at may-broadcast, with new admission closed", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pxe-crash-gate-"));
    const journal = adoptedJournal(workDir);
    const operationId = `crash-gate-${randomBytes(4).toString("hex")}`;
    const params = await terms(operationId);
    const before = await publicBalance();
    bridge = await startBridge(workDir, journal);
    killOnGate = true;
    const first = await rpc(bridge.url, "aztec_createNote", params, operationId).catch(
      (err: unknown) => err,
    );
    expect(first, "the first response must be lost to the kill").toBeInstanceOf(Error);
    expect(await bridge.exited).toBeNull();

    // Restart under another corridor revision: the operation's own corridor no
    // longer admits new work, which must not stop its recovery.
    bridge = await startBridge(workDir, journal, { ...CORRIDOR, corridorRevision: 2 });
    const held = await rpc(bridge.url, "aztec_getSettlement", {
      version: SETTLEMENT_VERSION,
      operationId,
    });
    expect(held.result).toMatchObject({ found: true, state: "prepared" });
    const preparedAttempts = held.result!["attempts"] as { txHash: string; mayBroadcast: boolean }[];
    expect(preparedAttempts).toHaveLength(1);
    expect(preparedAttempts[0]!.mayBroadcast).toBe(false);

    const freshId = `crash-gate-fresh-${randomBytes(4).toString("hex")}`;
    const fresh = await rpc(bridge.url, "aztec_createNote", await terms(freshId), freshId);
    expect(fresh.error?.data?.observation).toMatchObject({
      state: "not_submitted",
      reason: "corridor_mismatch",
    });

    const retry = await rpc(bridge.url, "aztec_createNote", params, operationId);
    expect(retry.result?.observation.txHash).toBe(preparedAttempts[0]!.txHash);
    const deadline = Date.now() + 120_000;
    let state = retry.result?.observation.state;
    while (state === "pending" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      state = (
        await rpc(bridge.url, "aztec_getSettlement", { version: SETTLEMENT_VERSION, operationId })
      ).result?.observation.state;
    }
    expect(["included", "finalized"]).toContain(state);
    expect(before - (await publicBalance())).toBe(BigInt(AMOUNT));
    const settled = await rpc(bridge.url, "aztec_getSettlement", {
      version: SETTLEMENT_VERSION,
      operationId,
    });
    expect(settled.result!["attempts"]).toHaveLength(1);
    expect(gateCalls.filter((id) => id === operationId)).toHaveLength(2);

    bridge.child.kill("SIGTERM");
    await bridge.exited;
    bridge = undefined;
  }, 600_000);

  it("halts writes visibly on a corrupt journal and keeps serving status", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pxe-corrupt-"));
    const journal = adoptedJournal(workDir);
    bridge = await startBridge(workDir, journal);
    bridge.child.kill("SIGKILL");
    await bridge.exited;
    const fd = openSync(journal, "r+");
    writeSync(fd, Buffer.alloc(100, 0x5a), 0, 100, 0);
    closeSync(fd);

    bridge = await startBridge(workDir, journal);
    expect(await (await fetch(`${bridge.url}/status`)).json()).toEqual({ status: "ok" });
    const readiness = await fetch(`${bridge.url}/ready`, {
      headers: { authorization: `Bearer ${RPC_KEY}` },
    });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      ready: false,
      reasons: expect.arrayContaining(["journal_unwritable"]),
    });
    const params = await terms("corrupt-op");
    const refused = await rpc(bridge.url, "aztec_createNote", params, "corrupt-op");
    expect(refused.error?.code).toBe(-32004);
    bridge.child.kill("SIGTERM");
    await bridge.exited;
    bridge = undefined;
  }, 600_000);
});
