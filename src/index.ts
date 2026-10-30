import {
  AztecClient,
  DEPLOYER_CLAIM_WITHOUT_SPENDING_LIMIT_ERROR,
  DEPLOYER_FEE_JUICE_CLAIM_ENV,
  FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR,
  TX_TIMEOUT_MS,
  sponsoredFpcSetting,
  type SponsoredFpcSetting,
} from "./aztec-client.js";
import { createApp, RESPONSE_TIMEOUT_MS, SETTLEMENT_DEADLINE_MS } from "./server.js";
import {
  AccountDeploymentSchema,
  AllowlistRecipientsSchema,
  FeeJuiceClaimSchema,
  type AccountDeployment,
  type FeeJuiceClaim,
} from "./types.js";
import {
  ACCOUNT_ADDRESS_ENV,
  ALLOW_ACCOUNT_DEPLOY_ENV,
  resolveAccountIdentityConfig,
  type AccountIdentityConfig,
} from "./account-identity.js";
import { TransactionLimits, type LimitsConfig } from "./limits.js";
import { AuditLogger } from "./audit.js";
import { SettlementJournal } from "./journal.js";
import { legacyAuditRefusal } from "./legacy-audit.js";
import { httpMayBroadcastClient, type MayBroadcastClient } from "./may-broadcast.js";
import { CorridorConfigSchema, type CorridorConfig } from "./settlement.js";
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

/**
 * Parses a fee juice claim env var, exiting with a message naming it on any
 * malformation. FEE_JUICE_CLAIM and the deployer claim share one shape, since
 * both are printed by `npm run bridge-fee-juice`.
 */
function parseFeeJuiceClaim(name: string): FeeJuiceClaim | undefined {
  const raw = process.env[name];
  // The claim secret spends the bridged fee juice; keep it out of the
  // environment child processes and crash dumps inherit.
  delete process.env[name];
  if (!raw) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error(`[pxe-bridge] ${name} is not valid JSON`);
    process.exit(1);
  }
  const parsed = FeeJuiceClaimSchema.safeParse(json);
  if (!parsed.success) {
    console.error(`[pxe-bridge] ${name} must be: {claimAmount, claimSecret, messageLeafIndex}`);
    process.exit(1);
  }
  return parsed.data;
}

const feeJuiceClaim = parseFeeJuiceClaim("FEE_JUICE_CLAIM");
const deployerFeeJuiceClaim = parseFeeJuiceClaim(DEPLOYER_FEE_JUICE_CLAIM_ENV);

// SponsoredFPC deployment fee fallback. Validated here so a malformed value is
// named at startup, and announced because otherwise nothing mentions it until
// an undeployed account reaches it. Enforced in AztecClient rather than here:
// whether it is used depends on whether the account is already on chain, and
// refusing on configuration alone would stop every restart of a deployed
// production account that no longer carries a claim. AztecClient reads the
// same env itself, so its log names the variable that decided.
let sponsoredFpc: SponsoredFpcSetting;
try {
  sponsoredFpc = sponsoredFpcSetting(process.env);
} catch (err) {
  console.error(`[pxe-bridge] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (sponsoredFpc.allowed) {
  console.warn(
    "[pxe-bridge] SponsoredFPC deployment fee fallback ENABLED (sandbox and testnet only; " +
      `${sponsoredFpc.reason}): an undeployed account not covered by FEE_JUICE_CLAIM, and a ` +
      `spending-limit account without ${DEPLOYER_FEE_JUICE_CLAIM_ENV}, pay their deployment via SponsoredFPC`,
  );
} else {
  console.log(
    `[pxe-bridge] SponsoredFPC deployment fee fallback disabled (${sponsoredFpc.reason}): an ` +
      "undeployed plain Schnorr account needs FEE_JUICE_CLAIM, and an undeployed spending-limit " +
      `account needs ${DEPLOYER_FEE_JUICE_CLAIM_ENV}`,
  );
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

// Unlike the limits above, a floor on the bridge's own fee juice. The
// spending-limit account cannot refill itself, so running dry means every
// transfer fails; this surfaces it on /status before that happens.
const MIN_FEE_JUICE_RAW = process.env["PXE_BRIDGE_MIN_FEE_JUICE"];
const minFeeJuice = MIN_FEE_JUICE_RAW
  ? parsePositiveBigInt("PXE_BRIDGE_MIN_FEE_JUICE", MIN_FEE_JUICE_RAW)
  : undefined;

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
  // The cooldown is spent BEFORE the send, inside the one settlement deadline
  // that starts when the request is handled (SETTLEMENT_DEADLINE_MS), so it
  // and the transaction share one budget. Past this bound a large transfer --
  // the kind the delay exists for -- would routinely run out of deadline
  // mid-send and answer submitted_unknown instead of its outcome.
  // TODO.md suggests 30s as an example value, one millisecond inside the edge.
  if (limitsConfig.cooldownDelayMs > MAX_COOLDOWN_DELAY_MS) {
    console.error(
      `[pxe-bridge] PXE_BRIDGE_COOLDOWN_DELAY_MS must be at most ${MAX_COOLDOWN_DELAY_MS}ms. ` +
        `The cooldown runs before the send, so it shares the request's settlement deadline ` +
        `with the ${TX_TIMEOUT_MS}ms transaction timeout.`,
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

// Output-only audit log (decided 2026-10-25). Nothing reads it back: the
// settlement journal below is the durable store.
const AUDIT_LOG_PATH = process.env["PXE_BRIDGE_AUDIT_LOG"];
const audit = new AuditLogger(AUDIT_LOG_PATH);

// The settlement journal: operations, exact prepared transactions, the
// may-broadcast mark and the rolling-spend window. Without it there is no
// recovery authority, so createNote and getSettlement refuse (-32004), and a
// production start is refused outright.
const JOURNAL_PATH = process.env["PXE_BRIDGE_JOURNAL"];
if (!JOURNAL_PATH && process.env["NODE_ENV"] === "production") {
  console.error(
    "[pxe-bridge] PXE_BRIDGE_JOURNAL is required when NODE_ENV=production. It is the " +
      "only record of what may have been broadcast.",
  );
  process.exit(1);
}
// `<account>@<journal id>`: one-shot, bound to the fresh journal it adopts
// (D-B). The refusal that asks for it prints the exact value.
const JOURNAL_ADOPT_ACCOUNT = process.env["PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT"];

// The corridor this bridge serves; every value is still open for manifest
// revision 1, so it is configuration and unset refuses createNote.
let corridor: CorridorConfig | undefined;
const CORRIDOR_RAW = process.env["PXE_BRIDGE_SETTLEMENT_CORRIDOR"];
if (CORRIDOR_RAW) {
  let corridorJson: unknown;
  try {
    corridorJson = JSON.parse(CORRIDOR_RAW);
  } catch {
    console.error("[pxe-bridge] PXE_BRIDGE_SETTLEMENT_CORRIDOR is not valid JSON");
    process.exit(1);
  }
  const corridorParsed = CorridorConfigSchema.safeParse(corridorJson);
  if (!corridorParsed.success) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_SETTLEMENT_CORRIDOR must be {corridorId, corridorRevision, " +
        "manifestDigest, genesisOrNetworkDigest}: " +
        corridorParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    process.exit(1);
  }
  corridor = corridorParsed.data;
}

// Riddler's may-broadcast endpoint and the environment-scoped service
// credential for it. Unset refuses createNote: nothing may be marked
// may-broadcast without an answer, and no answer is not "allow".
const MAY_BROADCAST_URL = process.env["PXE_BRIDGE_MAY_BROADCAST_URL"];
const MAY_BROADCAST_TOKEN = process.env["PXE_BRIDGE_MAY_BROADCAST_TOKEN"];
if (Boolean(MAY_BROADCAST_URL) !== Boolean(MAY_BROADCAST_TOKEN)) {
  console.error(
    "[pxe-bridge] PXE_BRIDGE_MAY_BROADCAST_URL and PXE_BRIDGE_MAY_BROADCAST_TOKEN are set together or not at all",
  );
  process.exit(1);
}
// HTTPS, or plain http to loopback only: the bearer token and the allow/deny
// answer cross this link (assertMayBroadcastUrl).
let mayBroadcast: MayBroadcastClient | undefined;
if (MAY_BROADCAST_URL && MAY_BROADCAST_TOKEN) {
  try {
    mayBroadcast = httpMayBroadcastClient({ url: MAY_BROADCAST_URL, token: MAY_BROADCAST_TOKEN });
  } catch (err) {
    console.error(`[pxe-bridge] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

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
// allowlist on-chain. A first deployment takes its limits from the
// application-level ones; after that PXE_BRIDGE_ACCOUNT_DEPLOYMENT pins what it
// was deployed with, and the two are free to diverge.
let spendingLimitConfig: SpendingLimitConfig | undefined;
const SPENDING_LIMIT_ADMIN = process.env["PXE_BRIDGE_SPENDING_LIMIT_ADMIN"];
const SPENDING_LIMIT_TOKEN = process.env["PXE_BRIDGE_SPENDING_LIMIT_TOKEN"];
const ALLOWLIST_SEED = process.env["PXE_BRIDGE_ALLOWLIST_SEED"];
const ALLOWLIST_RECIPIENTS_RAW = process.env["PXE_BRIDGE_ALLOWLIST_RECIPIENTS"];
const ACCOUNT_DEPLOYMENT_RAW = process.env["PXE_BRIDGE_ACCOUNT_DEPLOYMENT"];
// The same flag, and the same meaning, as the first-deploy exemption from the
// recorded address (resolveAccountIdentityConfig): both are a first deployment
// that cannot know its address or record in advance.
const ALLOW_ACCOUNT_DEPLOY = process.env[ALLOW_ACCOUNT_DEPLOY_ENV] === "1";
// A record with nothing to apply it to would otherwise be ignored, and the
// bridge would come up as a plain Schnorr account at a different address.
if (ACCOUNT_DEPLOYMENT_RAW && !SPENDING_LIMIT_ADMIN) {
  console.error(
    "[pxe-bridge] PXE_BRIDGE_ACCOUNT_DEPLOYMENT is set but PXE_BRIDGE_SPENDING_LIMIT_ADMIN " +
      "is not. The record only applies to the spending limit account.",
  );
  process.exit(1);
}
// `0x00...0` satisfies the 32-byte hex pattern, so every address below is
// checked against it separately. The contract asserts all three are non-zero,
// and without this the mistake surfaces as an in-circuit assert part-way
// through a deployment that has already been paid for, rather than as a startup
// error naming the variable that was wrong. An empty-but-present env var
// expanding to zeros is enough to reach it.
const IS_ZERO_ADDRESS = /^0x0{64}$/;
if (SPENDING_LIMIT_ADMIN) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(SPENDING_LIMIT_ADMIN)) {
    console.error("[pxe-bridge] PXE_BRIDGE_SPENDING_LIMIT_ADMIN must be a 32-byte hex address");
    process.exit(1);
  }
  // Worth its own message rather than folding into the check above, because
  // the consequence is not "this deployment fails" but "this deployment
  // succeeds and is permanently unadministrable". `admin` is PublicImmutable
  // with no rotation path, every lever compares msg_sender against it, and
  // msg_sender is never zero: no pause, no revocation, no limit change, ever,
  // and funds can only ever reach the one seeded recipient.
  if (IS_ZERO_ADDRESS.test(SPENDING_LIMIT_ADMIN)) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_SPENDING_LIMIT_ADMIN must not be the zero address -- " +
        "the admin cannot be rotated, so a zero admin permanently disables pause, " +
        "revocation and every limit change",
    );
    process.exit(1);
  }
  // Fixed at construction, no setter, so it must be supplied explicitly.
  if (
    !SPENDING_LIMIT_TOKEN ||
    !/^0x[0-9a-fA-F]{64}$/.test(SPENDING_LIMIT_TOKEN) ||
    IS_ZERO_ADDRESS.test(SPENDING_LIMIT_TOKEN)
  ) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_SPENDING_LIMIT_TOKEN must be a non-zero 32-byte hex address when the spending limit account is enabled",
    );
    process.exit(1);
  }
  // Every leaf salt derives from this. It is what makes the allowlist a secret
  // set rather than an unpublished one: addresses are enumerable, so without a
  // secret salt anyone could recompute a leaf and test candidates against it.
  //
  // Zero is rejected along with the wrong shape. It is a well-formed Fr and
  // would produce a perfectly valid tree, just one whose salts anyone can
  // reproduce, which is the whole failure this variable exists to prevent and
  // is silent on chain.
  if (
    !ALLOWLIST_SEED ||
    !/^0x[0-9a-fA-F]{64}$/.test(ALLOWLIST_SEED) ||
    IS_ZERO_ADDRESS.test(ALLOWLIST_SEED)
  ) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_ALLOWLIST_SEED must be a non-zero 32-byte hex value when the " +
        "spending limit account is enabled -- it is the secret every allowlist leaf salt " +
        "derives from",
    );
    process.exit(1);
  }
  // Warned rather than refused. Unlike the signing key this cannot move funds:
  // leaking it costs recipient privacy, not custody. It is still a secret, and
  // it belongs in the same store the signing key comes from.
  if (process.env["NODE_ENV"] === "production") {
    console.warn(
      "[pxe-bridge] PXE_BRIDGE_ALLOWLIST_SEED is being read from the environment in " +
        "production. It is a secret: anyone holding it can test a candidate address against " +
        "the on-chain allowlist. Environment variables are visible in /proc/pid/environ, " +
        "docker inspect and crash dumps.",
    );
  }

  // The allowlist itself. Losing this and the seed together is unrecoverable:
  // the account stores only a root, so unlike the old public array the set
  // cannot be read back off chain.
  if (!ALLOWLIST_RECIPIENTS_RAW) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_ALLOWLIST_RECIPIENTS is required when the spending limit " +
        'account is enabled. JSON, e.g. [{"address":"0x...","index":137}]',
    );
    process.exit(1);
  }
  let allowlistJson: unknown;
  try {
    allowlistJson = JSON.parse(ALLOWLIST_RECIPIENTS_RAW);
  } catch {
    console.error("[pxe-bridge] PXE_BRIDGE_ALLOWLIST_RECIPIENTS is not valid JSON");
    process.exit(1);
  }
  const allowlistParsed = AllowlistRecipientsSchema.safeParse(allowlistJson);
  if (!allowlistParsed.success) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_ALLOWLIST_RECIPIENTS must be an array of " +
        "{address: 32-byte hex, index: integer in [0, 1023]}: " +
        allowlistParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    process.exit(1);
  }
  // An empty allowlist deploys fine and cannot transfer to anyone. That is a
  // legitimate state to choose, but never one to reach by leaving a variable
  // set to "[]" by accident.
  if (allowlistParsed.data.length === 0) {
    console.error(
      "[pxe-bridge] PXE_BRIDGE_ALLOWLIST_RECIPIENTS is empty, so no transfer could ever " +
        "succeed. Name at least one recipient.",
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
  // The deployment record. Parsed here, checked against the derivation in
  // connect(): only that can say whether it describes this key's account.
  let deployment: AccountDeployment | undefined;
  if (ACCOUNT_DEPLOYMENT_RAW) {
    let deploymentJson: unknown;
    try {
      deploymentJson = JSON.parse(ACCOUNT_DEPLOYMENT_RAW);
    } catch {
      console.error("[pxe-bridge] PXE_BRIDGE_ACCOUNT_DEPLOYMENT is not valid JSON");
      process.exit(1);
    }
    const deploymentParsed = AccountDeploymentSchema.safeParse(deploymentJson);
    if (!deploymentParsed.success) {
      console.error(
        "[pxe-bridge] PXE_BRIDGE_ACCOUNT_DEPLOYMENT must be the record the bridge printed " +
          "after deploying, {address, maxAmountPerTx, dailyLimit, admin, token, " +
          "allowlistRoot}: " +
          deploymentParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
      process.exit(1);
    }
    deployment = deploymentParsed.data;
  } else if (process.env["NODE_ENV"] === "production" && !ALLOW_ACCOUNT_DEPLOY) {
    // Refused rather than warned. Without a record the address derives from
    // the live limits and allowlist, so a production restart after an
    // allowlist update or a limit change deploys an empty account at a new
    // address and serves from it, while the funds sit at the old one. A first
    // deployment is the one legitimate reason to start without a record, and
    // it is rare enough to ask for by name.
    console.error(
      "[pxe-bridge] PXE_BRIDGE_ACCOUNT_DEPLOYMENT is required when NODE_ENV=production. " +
        "For a first deployment set PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1, then persist the " +
        "record the bridge prints and remove the flag.",
    );
    process.exit(1);
  }
  spendingLimitConfig = {
    maxAmountPerTx: limitsConfig.maxAmount,
    dailyLimit: limitsConfig.dailyLimit,
    admin: SPENDING_LIMIT_ADMIN,
    token: SPENDING_LIMIT_TOKEN,
    allowlistSeed: ALLOWLIST_SEED,
    allowlistRecipients: allowlistParsed.data,
    ...(deployment ? { deployment } : {}),
  };
}

// The bridge account's recorded address, checked in connect() against what the
// key derives to before anything is deployed or served. Required in
// production; see resolveAccountIdentityConfig for why and for the first-deploy
// flag. In spending-limit mode the deployment record's `address` records the
// same account, so it satisfies that requirement on its own, and a separately
// set PXE_BRIDGE_ACCOUNT_ADDRESS must equal it.
const recordedAddress = spendingLimitConfig?.deployment?.address;
let accountIdentity: AccountIdentityConfig;
try {
  accountIdentity = resolveAccountIdentityConfig(
    recordedAddress !== undefined && process.env[ACCOUNT_ADDRESS_ENV] === undefined
      ? { ...process.env, [ACCOUNT_ADDRESS_ENV]: recordedAddress }
      : process.env,
  );
} catch (err) {
  console.error(`[pxe-bridge] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
// Two records of one address. Each would fail the derivation check in
// connect() on its own, but refusing here names both, since one of them was
// copied from a different deployment and the derivation alone cannot say
// which.
if (
  recordedAddress !== undefined &&
  accountIdentity.expectedAddress !== undefined &&
  accountIdentity.expectedAddress.toLowerCase() !== recordedAddress.toLowerCase()
) {
  console.error(
    `[pxe-bridge] PXE_BRIDGE_ACCOUNT_DEPLOYMENT names account ${recordedAddress}, but ` +
      `${ACCOUNT_ADDRESS_ENV} is ${accountIdentity.expectedAddress}. Both record the same ` +
      "account; one of them is from another deployment. Refusing to start.",
  );
  process.exit(1);
}

// The deployer exists only to deploy the spending-limit account; see
// DEPLOYER_CLAIM_WITHOUT_SPENDING_LIMIT_ERROR. AztecClient refuses this too,
// but here the message names the cause before the secret key is fetched.
if (deployerFeeJuiceClaim && !spendingLimitConfig) {
  console.error(`[pxe-bridge] ${DEPLOYER_CLAIM_WITHOUT_SPENDING_LIMIT_ERROR}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { key: secretKey, source: keySource } = await resolveSecretKey();
  console.log(`[pxe-bridge] Secret key loaded from ${keySource}`);

  // Opened before the wallet, so a second bridge on the same journal stops
  // here, before it has derived a key or touched the node. Any other defect
  // opens with writes disabled: recovery reads keep working.
  let journal: SettlementJournal | undefined;
  if (JOURNAL_PATH) {
    journal = SettlementJournal.open(JOURNAL_PATH);
    const health = journal.health();
    if (!health.writable && health.reason !== "account_unbound") {
      console.error(
        `[pxe-bridge] Settlement journal opened READ-ONLY (${health.reason}): ${health.detail}`,
      );
    }
    // The rolling window is rebuilt from the journal's spend rows, which are
    // written in the same transaction as each may-broadcast mark. A failure
    // disables journal writes (and readiness) rather than serving with an
    // empty window, which would hand back the daily budget.
    if (limits) {
      const restored = journal.restoreSpendWindow(Date.now() - DAY_MS, (spends) => limits.restore(spends));
      if (restored !== undefined) {
        console.log(`[pxe-bridge] Restored ${restored} spend(s) into the 24h window`);
      }
    }
  } else {
    console.warn(
      "[pxe-bridge] WARNING: PXE_BRIDGE_JOURNAL not set -- aztec_createNote and " +
        "aztec_getSettlement are refused",
    );
  }

  const client = new AztecClient(
    AZTEC_NODE_URL,
    secretKey,
    feeJuiceClaim,
    spendingLimitConfig,
    deployerFeeJuiceClaim,
    {
      ...(accountIdentity.expectedAddress
        ? { expectedAccountAddress: accountIdentity.expectedAddress }
        : {}),
    },
  );
  const server = createApp(client, {
    apiKey: API_KEY,
    adminKey: ADMIN_KEY,
    limits,
    audit,
    ...(journal
      ? {
          settlement: {
            journal,
            mayBroadcast,
            corridor,
            inFlight: new Set<string>(),
            timeoutMs: SETTLEMENT_DEADLINE_MS,
          },
        }
      : {}),
    minFeeJuice,
  });

  await client.connect();
  // Bound only now, because whether this is a lost journal depends on whether
  // the account already existed on chain before this process.
  if (journal) {
    // Adoption also reads the pre-journal audit log, which lives at the same
    // PXE_BRIDGE_AUDIT_LOG path the legacy bridge wrote (legacy-audit.ts).
    journal.bindAccount(client.getAddress()!, client.accountPreexisted(), {
      acknowledgement: JOURNAL_ADOPT_ACCOUNT,
      legacyAuditRefusal: AUDIT_LOG_PATH
        ? () => legacyAuditRefusal(AUDIT_LOG_PATH, Date.now())
        : undefined,
    });
    const health = journal.health();
    console.log(
      health.writable
        ? `[pxe-bridge] Settlement journal ${JOURNAL_PATH} writable; ${journal.unresolved().length} unresolved operation(s)`
        : `[pxe-bridge] SETTLEMENT JOURNAL WRITES DISABLED (${health.reason}): ${health.detail}`,
    );
    if (!mayBroadcast) {
      console.warn("[pxe-bridge] WARNING: may-broadcast endpoint not configured; createNote refused");
    }
    if (!corridor) {
      console.warn("[pxe-bridge] WARNING: PXE_BRIDGE_SETTLEMENT_CORRIDOR not set; createNote refused");
    }
  }

  // Printed on every unrecorded start, not just the first, so a missed first
  // print is not the end of it.
  if (!accountIdentity.expectedAddress) {
    console.warn(
      `[pxe-bridge] WARNING: ${ACCOUNT_ADDRESS_ENV} is not set. Record this account's ` +
        `address as ${ACCOUNT_ADDRESS_ENV}=${client.getAddress()}` +
        (accountIdentity.allowDeploy ? ` and remove ${ALLOW_ACCOUNT_DEPLOY_ENV}` : "") +
        ". Until then a change of key, SDK or account class moves the bridge to a " +
        "different, empty account without an error.",
    );
  }

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
    console.log(`[pxe-bridge] Audit (output only): ${AUDIT_LOG_PATH ?? "stdout"}`);
    console.log(`[pxe-bridge] Journal: ${JOURNAL_PATH ?? "NOT SET"}`);
    console.log(`[pxe-bridge] Endpoints:`);
    console.log(
      `  POST /           -- JSON-RPC (aztec_createNote, aztec_getSettlement, aztec_getVersion)`,
    );
    console.log(`  POST /api/rpc    -- JSON-RPC (alias)`);
    console.log(`  GET  /status     -- Liveness (200 while the node answers; body lists prerequisites)`);
    console.log(`  GET  /ready      -- Readiness (200 only when every settlement prerequisite holds)`);
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
