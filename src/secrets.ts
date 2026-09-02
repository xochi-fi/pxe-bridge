import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

export interface SecretKeyResult {
  key: string; // 64 hex chars, no 0x prefix
  source: "secretsmanager" | "env";
}

/**
 * Resolve the secret key from AWS Secrets Manager or environment variable.
 *
 * Resolution order:
 *   1. PXE_BRIDGE_SECRET_ARN -- fetch from Secrets Manager
 *   2. PXE_BRIDGE_SECRET_KEY -- raw hex from env (dev only)
 *
 * In production (NODE_ENV=production), env var is rejected.
 */
export async function resolveSecretKey(): Promise<SecretKeyResult> {
  const arn = process.env["PXE_BRIDGE_SECRET_ARN"];
  const envKey = process.env["PXE_BRIDGE_SECRET_KEY"];
  const isProduction = process.env["NODE_ENV"] === "production";

  if (arn) {
    if (envKey) {
      console.warn(
        "[pxe-bridge] PXE_BRIDGE_SECRET_ARN set -- ignoring PXE_BRIDGE_SECRET_KEY env var",
      );
    }
    const key = await fetchFromSecretsManager(arn);
    return { key, source: "secretsmanager" };
  }

  if (isProduction) {
    throw new Error(
      "PXE_BRIDGE_SECRET_ARN is required in production. " +
        "Env var PXE_BRIDGE_SECRET_KEY is not accepted when NODE_ENV=production.",
    );
  }

  if (!envKey) {
    throw new Error("PXE_BRIDGE_SECRET_KEY or PXE_BRIDGE_SECRET_ARN is required");
  }

  const normalized = await validateKey(envKey);

  // Drop it from the environment now that it has been read. It stays visible
  // in /proc/self/environ and `docker inspect` for as long as it is there,
  // which is the exposure the ARN path exists to avoid; leaving it set means
  // the dev path keeps it readable for the life of the process long after the
  // wallet is derived. Both operator scripts already do this. Not a substitute
  // for the ARN, and it cannot unpublish the value from whatever set it.
  delete process.env["PXE_BRIDGE_SECRET_KEY"];

  return { key: normalized, source: "env" };
}

async function fetchFromSecretsManager(secretId: string): Promise<string> {
  const client = new SecretsManagerClient({});
  const command = new GetSecretValueCommand({ SecretId: secretId });

  let response;
  try {
    response = await client.send(command);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch secret from Secrets Manager: ${msg}`);
  }

  const raw = response.SecretString;
  if (!raw) {
    throw new Error("Secret in Secrets Manager is binary or empty -- expected a hex string");
  }

  // Support both plain hex and JSON {"key": "hex"} formats
  const value = parseSecretValue(raw);
  return await validateKey(value);
}

function parseSecretValue(raw: string): string {
  const trimmed = raw.trim();

  // Plain hex string
  if (KEY_PATTERN.test(trimmed)) {
    return trimmed;
  }

  // JSON object with a "key" field
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Secret value looks like JSON but failed to parse");
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "key" in parsed &&
      typeof (parsed as Record<string, unknown>)["key"] === "string"
    ) {
      return (parsed as Record<string, unknown>)["key"] as string;
    }
    throw new Error('Secret JSON must have a "key" field containing the hex secret');
  }

  throw new Error('Secret value must be a 32-byte hex string or JSON with a "key" field');
}

/**
 * Checks the key is 32 bytes AND a valid BN254 field element.
 *
 * The range check is here rather than at connect(), where an out-of-range key
 * surfaces as "Value 0x... is greater or equal to field modulus" thrown from
 * inside the SDK, naming neither the variable nor the env var that supplied it.
 * Roughly 81% of 32-byte values are out of range, so this is the common case
 * for anyone generating a key with `openssl rand -hex 32`, not an edge case.
 *
 * The key is rejected, never reduced: reducing operator-supplied key material
 * would map distinct keys onto one account and silently accept a typo.
 */
async function validateKey(raw: string): Promise<string> {
  const normalized = raw.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Secret key must be 32 bytes (64 hex chars)");
  }

  const { Fr } = await import("@aztec/aztec.js/fields");
  if (BigInt(`0x${normalized}`) >= Fr.MODULUS) {
    throw new Error(
      "Secret key is not a valid BN254 field element: it must be below the Fr " +
        "modulus (0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001). " +
        "Generate one by retrying until the value is in range.",
    );
  }

  return normalized;
}
