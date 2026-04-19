import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

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
    throw new Error(
      "PXE_BRIDGE_SECRET_KEY or PXE_BRIDGE_SECRET_ARN is required",
    );
  }

  const normalized = validateKey(envKey);
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
    throw new Error(
      "Secret in Secrets Manager is binary or empty -- expected a hex string",
    );
  }

  // Support both plain hex and JSON {"key": "hex"} formats
  const value = parseSecretValue(raw);
  return validateKey(value);
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
      throw new Error(
        "Secret value looks like JSON but failed to parse",
      );
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "key" in parsed &&
      typeof (parsed as Record<string, unknown>)["key"] === "string"
    ) {
      return (parsed as Record<string, unknown>)["key"] as string;
    }
    throw new Error(
      'Secret JSON must have a "key" field containing the hex secret',
    );
  }

  throw new Error(
    "Secret value must be a 32-byte hex string or JSON with a \"key\" field",
  );
}

function validateKey(raw: string): string {
  const normalized = raw.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      "Secret key must be 32 bytes (64 hex chars)",
    );
  }
  return normalized;
}
