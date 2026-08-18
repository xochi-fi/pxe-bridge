import { AztecClient, FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR, TX_TIMEOUT_MS } from "./aztec-client.js";
import { createApp, RESPONSE_TIMEOUT_MS } from "./server.js";
import { FeeJuiceClaimSchema } from "./types.js";
import { TransactionLimits, type LimitsConfig } from "./limits.js";
import { AuditLogger, replayAuditLog } from "./audit.js";
import { IdempotencyStore } from "./idempotency.js";
import { resolveSecretKey } from "./secrets.js";
import type { SpendingLimitConfig } from "./spending-limit-account.js";

// Must match WINDOW_MS in limits.ts: it bounds the same rolling window.
const DAY_MS = 24 * 60 * 60 * 1000;

// What a pre-send delay can spend without pushing the transaction past the
// response deadline. Derived rather than written down, so moving either
// timeout moves this with it.
const MAX_COOLDOWN_DELAY_MS = RESPONSE_TIMEOUT_MS - TX_TIMEOUT_MS;

const PORT = parseInt(process.env["PXE_BRIDGE_PORT"] ?? "8547", 10);
if (isNaN(PORT) || PORT < 0 || PORT > 65535) {
  console.error("[pxe-bridge] PXE_BRIDGE_PORT must be 0-65535");
  process.exit(1);
}
const HOST = process.env["PXE_BRIDGE_HOST"] ?? "127.0.0.1";
const AZTEC_NODE_URL = process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080";
const API_KEY = process.env["PXE_BRIDGE_API_KEY"];

// Production refuses to boot unauthenticated, the same way secrets.ts refuses
// the env-var secret key. The asymmetry it replaces was hard to defend: one
// NODE_ENV gate protected the key material and nothing protected the auth that
// guards spending it, while the image sets NODE_ENV=production, so the shipped
// default was a money-moving endpoint whose only protection was an operator
// reading a warning. The 127.0.0.1 default is not that protection either --
// anything serving traffic sets PXE_BRIDGE_HOST, and inside a container the
// default is not reachable at all.
if (!API_KEY) {
  if (process.env["NODE_ENV"] === "production") {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_API_KEY is required when NODE_ENV=production. " +
        "Refusing to start an unauthenticated RPC endpoint.",
    );
    process.exit(1);
  }
  console.warn(
    "[pxe-bridge] WARNING: PXE_BRIDGE_API_KEY not set -- RPC endpoint is unauthenticated",
  );
}

let feeJuiceClaim: import("./types.js").FeeJuiceClaim | undefined;
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

// Transaction limits
const limitsConfig: LimitsConfig = {};

function parsePositiveBigInt(name: string, raw: string): bigint {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    console.error(`[pxe-bridge] ${name} must be a valid integer`);
    process.exit(1);
  }
  if (value <= 0n) {
    console.error(`[pxe-bridge] ${name} must be positive`);
    process.exit(1);
  }
  return value;
}

const MAX_AMOUNT_RAW = process.env["PXE_BRIDGE_MAX_AMOUNT"];
if (MAX_AMOUNT_RAW) {
  limitsConfig.maxAmount = parsePositiveBigInt("PXE_BRIDGE_MAX_AMOUNT", MAX_AMOUNT_RAW);
}

const DAILY_LIMIT_RAW = process.env["PXE_BRIDGE_DAILY_LIMIT"];
if (DAILY_LIMIT_RAW) {
  limitsConfig.dailyLimit = parsePositiveBigInt("PXE_BRIDGE_DAILY_LIMIT", DAILY_LIMIT_RAW);
}

const COOLDOWN_THRESHOLD_RAW = process.env["PXE_BRIDGE_COOLDOWN_THRESHOLD"];
const COOLDOWN_DELAY_RAW = process.env["PXE_BRIDGE_COOLDOWN_DELAY_MS"];
if (COOLDOWN_THRESHOLD_RAW && COOLDOWN_DELAY_RAW) {
  limitsConfig.cooldownThreshold = parsePositiveBigInt(
    "PXE_BRIDGE_COOLDOWN_THRESHOLD",
    COOLDOWN_THRESHOLD_RAW,
  );
  limitsConfig.cooldownDelayMs = parseInt(COOLDOWN_DELAY_RAW, 10);
  if (isNaN(limitsConfig.cooldownDelayMs) || limitsConfig.cooldownDelayMs <= 0) {
    console.error("[pxe-bridge] PXE_BRIDGE_COOLDOWN_DELAY_MS must be a positive integer");
    process.exit(1);
  }
  // The cooldown is spent BEFORE the send, so it and the transaction share one
  // response budget. Only the lower bound was checked, and the 150s response
  // deadline is justified as being above the 120s tx timeout "so a legitimate
  // transfer is never cut off by it" -- which stops being true at 30s of
  // cooldown. Past that the caller gets a bare 504 with no txHash while the
  // transfer proceeds, and it is large amounts specifically that wait, so the
  // ambiguous outcome would land on exactly the transfers the delay protects.
  // TODO.md suggests 30s as an example value, one millisecond inside the edge.
  if (limitsConfig.cooldownDelayMs > MAX_COOLDOWN_DELAY_MS) {
    console.error(
      `[pxe-bridge] PXE_BRIDGE_COOLDOWN_DELAY_MS must be at most ${MAX_COOLDOWN_DELAY_MS}ms. ` +
        `The cooldown runs before the send, so it shares the ${RESPONSE_TIMEOUT_MS}ms response ` +
        `deadline with the ${TX_TIMEOUT_MS}ms transaction timeout.`,
    );
    process.exit(1);
  }
} else if (COOLDOWN_THRESHOLD_RAW || COOLDOWN_DELAY_RAW) {
  console.error(
    "[pxe-bridge] PXE_BRIDGE_COOLDOWN_THRESHOLD and PXE_BRIDGE_COOLDOWN_DELAY_MS must both be set",
  );
  process.exit(1);
}

const hasLimits =
  limitsConfig.maxAmount !== undefined ||
  limitsConfig.dailyLimit !== undefined ||
  limitsConfig.cooldownThreshold !== undefined;
const limits = hasLimits ? new TransactionLimits(limitsConfig) : undefined;

// Audit log. Doubles as the rolling window's durable store: main() replays it
// into `limits` before listening.
const AUDIT_LOG_PATH = process.env["PXE_BRIDGE_AUDIT_LOG"];
const audit = new AuditLogger(AUDIT_LOG_PATH);

// Replay store for the Idempotency-Key header. Always on: it only does
// anything for callers that send the header, and the alternative is a knob
// whose "off" position silently reintroduces double transfers.
const idempotency = new IdempotencyStore();

// Key for POST /admin/resume. Separate from the RPC key on purpose; see
// ServerOptions.adminKey.
const ADMIN_KEY = process.env["PXE_BRIDGE_ADMIN_KEY"];
if (limits && !ADMIN_KEY) {
  console.warn(
    "[pxe-bridge] WARNING: PXE_BRIDGE_ADMIN_KEY not set -- a tripped circuit " +
      "breaker can only be cleared by restarting the process",
  );
}

// On-chain spending limit account (Phase 2).
// When PXE_BRIDGE_SPENDING_LIMIT_ADMIN is set, deploys a custom Noir account
// contract that enforces per-tx caps, daily volume limits, and a recipient
// allowlist on-chain. Uses the same limit values as application-level limits.
let spendingLimitConfig: SpendingLimitConfig | undefined;
const SPENDING_LIMIT_ADMIN = process.env["PXE_BRIDGE_SPENDING_LIMIT_ADMIN"];
const SPENDING_LIMIT_TOKEN = process.env["PXE_BRIDGE_SPENDING_LIMIT_TOKEN"];
const SPENDING_LIMIT_SEED = process.env["PXE_BRIDGE_SPENDING_LIMIT_SEED_RECIPIENT"];
// Defaults to 1 (no floor), which is the only value a freshly seeded
// single-entry allowlist can satisfy. Raise it as the allowlist grows.
const SPENDING_LIMIT_MIN_ANON = Number(
  process.env["PXE_BRIDGE_SPENDING_LIMIT_MIN_ANONYMITY"] ?? "1",
);
if (SPENDING_LIMIT_ADMIN) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(SPENDING_LIMIT_ADMIN)) {
    console.error("[pxe-bridge] PXE_BRIDGE_SPENDING_LIMIT_ADMIN must be a 32-byte hex address");
    process.exit(1);
  }
  // Fixed at construction, no setter, so it must be supplied explicitly.
  if (!SPENDING_LIMIT_TOKEN || !/^0x[0-9a-fA-F]{64}$/.test(SPENDING_LIMIT_TOKEN)) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_SPENDING_LIMIT_TOKEN must be a 32-byte hex address when the spending limit account is enabled",
    );
    process.exit(1);
  }
  // Seeded into allowlist slot 0 by the constructor. Without it the account
  // cannot transfer until an addition clears the 24h timelock.
  if (!SPENDING_LIMIT_SEED || !/^0x[0-9a-fA-F]{64}$/.test(SPENDING_LIMIT_SEED)) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_SPENDING_LIMIT_SEED_RECIPIENT must be a 32-byte hex address when the spending limit account is enabled",
    );
    process.exit(1);
  }
  if (
    !Number.isInteger(SPENDING_LIMIT_MIN_ANON) ||
    SPENDING_LIMIT_MIN_ANON < 1 ||
    SPENDING_LIMIT_MIN_ANON > 8
  ) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_SPENDING_LIMIT_MIN_ANONYMITY must be an integer in [1, 8]",
    );
    process.exit(1);
  }
  // The contract's assert_limits_valid rejects zero in either slot, so
  // defaulting these to 0n produced a config that could only fail, and it
  // failed as an in-circuit assert during deployment rather than as a startup
  // error naming the variable that was missing.
  if (limitsConfig.maxAmount === undefined || limitsConfig.dailyLimit === undefined) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_MAX_AMOUNT and PXE_BRIDGE_DAILY_LIMIT are both required " +
        "when the spending limit account is enabled -- the contract rejects a zero limit",
    );
    process.exit(1);
  }
  // Mirrors the contract's own check, so the mismatch is caught before paying
  // for a deployment that cannot succeed.
  if (limitsConfig.dailyLimit < limitsConfig.maxAmount) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_DAILY_LIMIT must be >= PXE_BRIDGE_MAX_AMOUNT",
    );
    process.exit(1);
  }
  // Refused at startup rather than at deployment. The claim would be attached
  // to an account the deploy is not sent from, which leaves the transaction
  // with no fee payer at all; see FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR.
  if (feeJuiceClaim) {
    console.error(`[pxe-bridge] ${FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR}`);
    process.exit(1);
  }
  spendingLimitConfig = {
    maxAmountPerTx: limitsConfig.maxAmount,
    dailyLimit: limitsConfig.dailyLimit,
    admin: SPENDING_LIMIT_ADMIN,
    token: SPENDING_LIMIT_TOKEN,
    seedRecipient: SPENDING_LIMIT_SEED,
    minAnonymitySet: SPENDING_LIMIT_MIN_ANON,
  };
}

async function main(): Promise<void> {
  const { key: secretKey, source: keySource } = await resolveSecretKey();
  console.log(`[pxe-bridge] Secret key loaded from ${keySource}`);

  // Rebuild both pieces of durable state before serving. Skipping this gave
  // every restart a fresh daily budget and forgot every idempotency key, so a
  // retry that straddled a restart transferred a second time.
  if (AUDIT_LOG_PATH) {
    const { spends, keys } = await replayAuditLog(AUDIT_LOG_PATH, Date.now() - DAY_MS);
    if (limits) {
      console.log(`[pxe-bridge] Restored ${limits.restore(spends)} spend(s) into the 24h window`);
    }
    console.log(`[pxe-bridge] Restored ${idempotency.restore(keys)} idempotency key(s)`);
  } else {
    console.warn(
      "[pxe-bridge] WARNING: PXE_BRIDGE_AUDIT_LOG not set -- the 24h volume window " +
        "and idempotency keys are in-memory only and reset on every restart",
    );
  }

  const client = new AztecClient(AZTEC_NODE_URL, secretKey, feeJuiceClaim, spendingLimitConfig);
  const server = createApp(client, {
    apiKey: API_KEY,
    adminKey: ADMIN_KEY,
    limits,
    audit,
    idempotency,
  });

  await client.connect();

  server.listen(PORT, HOST, () => {
    console.log(`[pxe-bridge] Listening on ${HOST}:${PORT}`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
      console.warn(
        "[pxe-bridge] WARNING: Binding to non-localhost address. " +
          "Deploy behind a TLS-terminating reverse proxy (nginx, AWS ELB, etc.)",
      );
    }
    console.log(`[pxe-bridge] Node: ${AZTEC_NODE_URL}`);
    console.log(`[pxe-bridge] Auth: ${API_KEY ? "enabled" : "DISABLED"}`);
    if (limits) {
      if (limitsConfig.maxAmount !== undefined)
        console.log(`[pxe-bridge] Max amount: ${limitsConfig.maxAmount}`);
      if (limitsConfig.dailyLimit !== undefined)
        console.log(`[pxe-bridge] Daily limit: ${limitsConfig.dailyLimit}`);
      if (limitsConfig.cooldownThreshold !== undefined)
        console.log(
          `[pxe-bridge] Cooldown: ${limitsConfig.cooldownDelayMs}ms above ${limitsConfig.cooldownThreshold}`,
        );
    }
    console.log(`[pxe-bridge] Audit: ${AUDIT_LOG_PATH ?? "stdout"}`);
    console.log(`[pxe-bridge] Endpoints:`);
    console.log(`  POST /           -- JSON-RPC (aztec_createNote, aztec_getVersion)`);
    console.log(`  POST /api/rpc    -- JSON-RPC (alias)`);
    console.log(`  GET  /status     -- Health check`);
    console.log(
      `  POST /admin/resume -- Clear the circuit breaker (${ADMIN_KEY ? "enabled" : "DISABLED"})`,
    );
  });

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
}

main().catch((err) => {
  console.error("[pxe-bridge] Fatal:", err);
  process.exit(1);
});
