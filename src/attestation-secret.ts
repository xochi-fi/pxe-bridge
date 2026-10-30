import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "@xochi/signer";

const KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export interface ReadinessSigner {
  readonly address: Hex;
  signDigest(digest: Hex): Promise<Hex>;
}

export interface AttestationSecretResult {
  signer: ReadinessSigner;
  source: "secretsmanager" | "env";
}

export class Secp256k1ReadinessSigner implements ReadinessSigner {
  private readonly account: PrivateKeyAccount;
  readonly address: Hex;

  constructor(key: string) {
    const normalized = validateAttestationKey(key);
    this.account = privateKeyToAccount(`0x${normalized}`);
    this.address = this.account.address.toLowerCase() as Hex;
  }

  async signDigest(digest: Hex): Promise<Hex> {
    return (await this.account.sign({ hash: digest })).toLowerCase() as Hex;
  }
}

export function validateAttestationKey(raw: string): string {
  const normalized = raw.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Attestation secret key must be 32 bytes (64 hex chars)");
  }
  const scalar = BigInt(`0x${normalized}`);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) {
    throw new Error("Attestation secret key must be a nonzero secp256k1 scalar");
  }
  return normalized.toLowerCase();
}

function parseSecret(raw: string): string {
  const trimmed = raw.trim();
  if (KEY_PATTERN.test(trimmed)) return trimmed;
  if (!trimmed.startsWith("{")) {
    throw new Error('Attestation secret must be 32-byte hex or JSON with a "key" field');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Attestation secret looks like JSON but failed to parse");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("key" in parsed) ||
    typeof parsed.key !== "string"
  ) {
    throw new Error('Attestation secret JSON must have a string "key" field');
  }
  return parsed.key;
}

export async function resolveAttestationSecret(
  env: NodeJS.ProcessEnv = process.env,
  forbiddenKeyMaterial: readonly string[] = [],
): Promise<AttestationSecretResult> {
  const arn = env["PXE_BRIDGE_ATTESTATION_SECRET_ARN"];
  const rawEnvKey = env["PXE_BRIDGE_ATTESTATION_SECRET_KEY"];
  if (arn && rawEnvKey) {
    throw new Error(
      "PXE_BRIDGE_ATTESTATION_SECRET_ARN and PXE_BRIDGE_ATTESTATION_SECRET_KEY are mutually exclusive",
    );
  }
  let raw: string;
  let source: AttestationSecretResult["source"];
  if (arn) {
    const response = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    if (!response.SecretString) {
      throw new Error("Attestation secret in Secrets Manager is binary or empty");
    }
    raw = parseSecret(response.SecretString);
    source = "secretsmanager";
  } else {
    if (env["NODE_ENV"] === "production") {
      throw new Error(
        "PXE_BRIDGE_ATTESTATION_SECRET_ARN is required in production; " +
          "PXE_BRIDGE_ATTESTATION_SECRET_KEY is not accepted",
      );
    }
    if (!rawEnvKey) {
      throw new Error(
        "PXE_BRIDGE_ATTESTATION_SECRET_ARN or PXE_BRIDGE_ATTESTATION_SECRET_KEY is required",
      );
    }
    raw = rawEnvKey;
    source = "env";
  }
  const normalized = validateAttestationKey(raw);
  const reused = forbiddenKeyMaterial.some((candidate) => {
    const value = candidate.trim().replace(/^0x/i, "").toLowerCase();
    return /^[0-9a-f]{64}$/.test(value) && value === normalized;
  });
  if (reused) {
    throw new Error(
      "Attestation secret custody must not reuse any spend, admin, allowlist, or bearer secret",
    );
  }
  const signer = new Secp256k1ReadinessSigner(normalized);
  if (source === "env") delete env["PXE_BRIDGE_ATTESTATION_SECRET_KEY"];
  return { signer, source };
}
