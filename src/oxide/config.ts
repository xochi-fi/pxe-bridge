import { resolve } from "node:path";
import { capsFromEnv, type OxideCapsConfig } from "./caps.js";

/**
 * Which send mode this process serves (pxe-bridge#84), from
 * `PXE_BRIDGE_SEND_MODE`: unset or `spending_limit` is the design-A bridge
 * exactly as before 0.4.0; `oxide` serves only `sendMode: "oxide"` through
 * the Oxide sender on the standard account. Every inconsistency is refused at
 * startup, naming the variable, before a key is fetched or a node touched.
 */
export const SEND_MODE_ENV = "PXE_BRIDGE_SEND_MODE";

export type SendModeConfig =
  | { mode: "spending_limit" }
  | {
      mode: "oxide";
      journalPath: string;
      l1RpcUrl: string;
      tokenArtifactPath: string;
      caps: OxideCapsConfig;
    };

/** Read only in Oxide mode; set in spending_limit mode they would be silently ignored. */
const OXIDE_ONLY = [
  "PXE_BRIDGE_OXIDE_JOURNAL",
  "PXE_BRIDGE_OXIDE_L1_RPC_URL",
  "PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT",
  "PXE_BRIDGE_OXIDE_MAX_PER_TX",
  "PXE_BRIDGE_OXIDE_DAILY_LIMIT",
  "PXE_BRIDGE_OXIDE_ALLOWLIST_SEED",
  "PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS",
] as const;

/**
 * The spending-limit account and the generic limits. Oxide mode pays from the
 * standard account and enforces its own caps (`PXE_BRIDGE_OXIDE_MAX_PER_TX`,
 * `_DAILY_LIMIT`), so each of these would be ignored or would deploy the
 * wrong account.
 */
const SPENDING_LIMIT_ONLY = [
  "PXE_BRIDGE_SPENDING_LIMIT_ADMIN",
  "PXE_BRIDGE_SPENDING_LIMIT_TOKEN",
  "PXE_BRIDGE_ACCOUNT_DEPLOYMENT",
  "PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM",
  "PXE_BRIDGE_ALLOWLIST_RECIPIENTS",
  "PXE_BRIDGE_MAX_AMOUNT",
  "PXE_BRIDGE_DAILY_LIMIT",
  "PXE_BRIDGE_COOLDOWN_THRESHOLD",
  "PXE_BRIDGE_COOLDOWN_DELAY_MS",
] as const;

/** Oxide mode serves createNote only with all of these. */
const OXIDE_REQUIRED = [
  "PXE_BRIDGE_JOURNAL",
  "PXE_BRIDGE_OXIDE_JOURNAL",
  "PXE_BRIDGE_OXIDE_L1_RPC_URL",
  "PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT",
  "PXE_BRIDGE_SETTLEMENT_CORRIDOR",
  "PXE_BRIDGE_MAY_BROADCAST_URL",
] as const;

const set = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? "") !== "";

export function resolveSendModeConfig(env: NodeJS.ProcessEnv): SendModeConfig {
  const mode = env[SEND_MODE_ENV];
  if (mode === undefined || mode === "" || mode === "spending_limit") {
    const stray = OXIDE_ONLY.filter((name) => set(env, name));
    if (stray.length > 0) {
      throw new Error(`${stray.join(", ")} set without ${SEND_MODE_ENV}=oxide; refusing to ignore it`);
    }
    return { mode: "spending_limit" };
  }
  if (mode !== "oxide") {
    throw new Error(`${SEND_MODE_ENV} must be "spending_limit" or "oxide", not ${JSON.stringify(mode)}`);
  }
  const conflicting = SPENDING_LIMIT_ONLY.filter((name) => set(env, name));
  if (conflicting.length > 0) {
    throw new Error(
      `${SEND_MODE_ENV}=oxide pays from the standard account under the Oxide caps; unset ${conflicting.join(", ")}`,
    );
  }
  const missing = OXIDE_REQUIRED.filter((name) => !set(env, name));
  if (missing.length > 0) throw new Error(`${SEND_MODE_ENV}=oxide requires ${missing.join(", ")}`);
  const journalPath = env["PXE_BRIDGE_OXIDE_JOURNAL"]!;
  if (resolve(journalPath) === resolve(env["PXE_BRIDGE_JOURNAL"]!)) {
    throw new Error("PXE_BRIDGE_OXIDE_JOURNAL must be its own file, not PXE_BRIDGE_JOURNAL");
  }
  const l1RpcUrl = env["PXE_BRIDGE_OXIDE_L1_RPC_URL"]!;
  let url: URL;
  try {
    url = new URL(l1RpcUrl);
  } catch {
    throw new Error("PXE_BRIDGE_OXIDE_L1_RPC_URL is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PXE_BRIDGE_OXIDE_L1_RPC_URL must be http(s)");
  }
  return {
    mode: "oxide",
    journalPath,
    l1RpcUrl,
    tokenArtifactPath: env["PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT"]!,
    caps: capsFromEnv(env),
  };
}
