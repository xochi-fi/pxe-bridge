import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AZTEC_RECIPIENT_PROFILES,
  RecipientEncodingError,
  hashRecipientDescriptor,
  readinessDigest,
  readinessDomain,
  recipientMessage,
  verifyRecipientDescriptor,
  verifyRecipientSchnorr,
  type Hex,
  type MembershipAttestation,
  type NetworkIdentity,
  type RecipientDeploymentAttestation,
  type RecipientDescriptor,
  type RootUpdateAttestation,
} from "@xochi/signer";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { rootFromSiblingPath } from "./allowlist-tree.js";
import type { AllowlistTree } from "./allowlist-tree.js";
import type { SettlementJournal } from "./journal.js";
import { CorridorSchema, NetworkIdentitySchema } from "./settlement.js";
import type { ReadinessSigner } from "./attestation-secret.js";
import { finalizedTimeReason } from "./readiness.js";


const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX64 = /^0x[0-9a-fA-F]{128}$/;
const HEX65 = /^0x[0-9a-fA-F]{130}$/;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const ROOT_UPDATE_RELAY_TIMEOUT_MS = 10_000;

const Hex32Schema = z.string().regex(HEX32).transform((value) => value.toLowerCase());

export const RecipientDescriptorSchema = z
  .object({
    aztecAddress: Hex32Schema,
    classId: Hex32Schema,
    salt: Hex32Schema,
    deployer: Hex32Schema,
    signingPublicKeyX: Hex32Schema,
    signingPublicKeyY: Hex32Schema,
    npkMHash: Hex32Schema,
    ivpkMX: Hex32Schema,
    ivpkMY: Hex32Schema,
    ovpkMHash: Hex32Schema,
    tpkMHash: Hex32Schema,
    mspkMHash: Hex32Schema,
    fbpkMHash: Hex32Schema,
    network: NetworkIdentitySchema,
  })
  .strict();

export const RecipientAuthorizationSchema = z
  .object({
    digest: Hex32Schema,
    signature: z.string().regex(HEX64).transform((value) => value.toLowerCase()),
  })
  .strict();

export const AttestationParamsSchema = z
  .object({
    descriptor: RecipientDescriptorSchema,
    descriptorDigest: Hex32Schema,
    recipient: Hex32Schema,
    network: NetworkIdentitySchema,
    corridor: CorridorSchema,
    recipientAuthorization: RecipientAuthorizationSchema,
  })
  .strict();

export const AttestationMethodSchema = z.enum([
  "aztec_attestRecipientMembership",
  "aztec_attestRecipientDeployment",
]);

const RpcIdSchema = z.union([z.string(), z.number().finite(), z.null()]);

export const AttestationRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: RpcIdSchema,
    method: AttestationMethodSchema,
    params: AttestationParamsSchema,
  })
  .strict();

export const MembershipRecordSchema = z
  .object({
    descriptorDigest: Hex32Schema,
    root: Hex32Schema,
    member: z.boolean(),
    rootBlock: z.string().regex(POSITIVE_DECIMAL),
    attestedAt: z.number().int().nonnegative(),
    signature: z.string().regex(HEX65).transform((value) => value.toLowerCase()),
  })
  .strict();

export const RecipientDeploymentRecordSchema = z
  .object({
    descriptorDigest: Hex32Schema,
    recipient: Hex32Schema,
    classId: Hex32Schema,
    deployed: z.boolean(),
    finalBlock: z.string().regex(POSITIVE_DECIMAL),
    attestedAt: z.number().int().nonnegative(),
    signature: z.string().regex(HEX65).transform((value) => value.toLowerCase()),
  })
  .strict();

export const RootUpdateRecordSchema = z
  .object({
    root: Hex32Schema,
    rootBlock: z.string().regex(POSITIVE_DECIMAL),
    attestedAt: z.number().int().nonnegative(),
    signature: z.string().regex(HEX65).transform((value) => value.toLowerCase()),
  })
  .strict();

export const RootUpdateEnvelopeSchema = z
  .object({
    corridor_id: Hex32Schema,
    corridor_revision: z.number().int().min(0).max(0xffffffff),
    record: RootUpdateRecordSchema,
  })
  .strict();

export const AttestationRefusalReasonSchema = z.enum([
  "invalid_descriptor",
  "descriptor_digest_mismatch",
  "recipient_mismatch",
  "profile_mismatch",
  "class_mismatch",
  "corridor_mismatch",
  "network_mismatch",
  "binding_authorization_invalid",
  "finalized_history_unavailable",
  "finalized_reference_invalid",
  "finalized_tip_stale",
  "finalized_tip_from_future",
  "account_address_mismatch",
  "account_class_mismatch",
  "account_not_initialized",
  "allowlist_snapshot_unavailable",
  "allowlist_root_mismatch",
  "membership_uncertain",
  "deployment_uncertain",
  "journal_unavailable",
  "signer_failed",
  "internal_error",
]);

export const AttestationRefusalSchema = z
  .object({ status: z.literal("refused"), reason: AttestationRefusalReasonSchema })
  .strict();

export const MembershipResultSchema = z.union([
  MembershipRecordSchema,
  AttestationRefusalSchema,
]);

export const RecipientDeploymentResultSchema = z.union([
  RecipientDeploymentRecordSchema,
  AttestationRefusalSchema,
]);

export const AttestationRpcResultSchema = z.union([
  MembershipRecordSchema,
  RecipientDeploymentRecordSchema,
]);

export const AttestationRefusalDataSchema = z
  .object({
    signed: z.literal(false),
    refusal: AttestationRefusalReasonSchema,
  })
  .strict();

export const AttestationRpcRefusalResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: RpcIdSchema,
    error: z
      .object({
        code: z.literal(-32010),
        message: z.literal("Readiness attestation refused"),
        data: AttestationRefusalDataSchema,
      })
      .strict(),
  })
  .strict();

export const AttestationRpcResponseSchema = z.union([
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: RpcIdSchema,
      result: AttestationRpcResultSchema,
    })
    .strict(),
  AttestationRpcRefusalResponseSchema,
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: RpcIdSchema,
      error: z
        .object({ code: z.number().int(), message: z.string() })
        .strict(),
    })
    .strict(),
]);


export type SdkNetworkIdentity = NetworkIdentity;
export type SdkRecipientDescriptor = RecipientDescriptor;
export type SdkMembershipAttestation = MembershipAttestation;
export type SdkRecipientDeploymentAttestation = RecipientDeploymentAttestation;
export type SdkRootUpdateAttestation = RootUpdateAttestation;
export type RecipientDescriptorInput = z.infer<typeof RecipientDescriptorSchema>;
export type RecipientAuthorization = z.infer<typeof RecipientAuthorizationSchema>;
export type AttestationParams = z.infer<typeof AttestationParamsSchema>;
export type AttestationMethod = z.infer<typeof AttestationMethodSchema>;
export type AttestationRpcRequest = z.infer<typeof AttestationRpcRequestSchema>;
export type MembershipRecord = z.infer<typeof MembershipRecordSchema>;
export type RecipientDeploymentRecord = z.infer<typeof RecipientDeploymentRecordSchema>;
export type RootUpdateRecord = z.infer<typeof RootUpdateRecordSchema>;
export type RootUpdateEnvelope = z.infer<typeof RootUpdateEnvelopeSchema>;
export type AttestationRefusalReason = z.infer<typeof AttestationRefusalReasonSchema>;
export type AttestationRefusal = z.infer<typeof AttestationRefusalSchema>;
export type MembershipResult = z.infer<typeof MembershipResultSchema>;
export type RecipientDeploymentResult = z.infer<typeof RecipientDeploymentResultSchema>;
export type AttestationRpcResult = z.infer<typeof AttestationRpcResultSchema>;
export type AttestationRpcResponse = z.infer<typeof AttestationRpcResponseSchema>;

export interface FinalizedAttestationObservation {
  network: NetworkIdentity;
  finalized: { blockNumber: string; blockHash: string; timestamp: string };
  allowlistRoot: string;
  recipientDeployment?:
    | { state: "absent" }
    | { state: "present"; classId: string; initialized: boolean };
}

export type AttestationObservation =
  | { state: "known"; value: FinalizedAttestationObservation }
  | {
      state: "unknown";
      reason:
        | "finalized_history_unavailable"
        | "finalized_reference_invalid"
        | "finalized_tip_stale"
        | "finalized_tip_from_future"
        | "account_address_mismatch"
        | "account_class_mismatch"
        | "account_not_initialized";
    };

export interface AttestationChainProbe {
  observeAttestationChain(
    recipient: string | undefined,
    genesisOrNetworkDigest: string,
  ): Promise<AttestationObservation>;
}

export interface AttestationDomainConfig {
  sourceChainId: string;
  environment: string;
  corridorId: string;
  corridorRevision: number;
  manifestDigest: string;
  genesisOrNetworkDigest: string;
}

export interface AttestationEnvironmentConfig {
  apiKey: string;
  secretConfigured: true;
  domain: { sourceChainId: string; environment: string };
  relay: { url: string; token: string };
}

const ATTESTATION_ENV_KEYS = [
  "PXE_BRIDGE_ATTESTATION_API_KEY",
  "PXE_BRIDGE_ATTESTATION_SECRET_ARN",
  "PXE_BRIDGE_ATTESTATION_SECRET_KEY",
  "PXE_BRIDGE_ATTESTATION_SOURCE_CHAIN_ID",
  "PXE_BRIDGE_ATTESTATION_ENVIRONMENT",
  "PXE_BRIDGE_ATTESTATION_RELAY_URL",
  "PXE_BRIDGE_ATTESTATION_RELAY_TOKEN",
] as const;

export function readAttestationEnvironment(
  env: NodeJS.ProcessEnv,
  otherCredentials: readonly (string | undefined)[],
): AttestationEnvironmentConfig | undefined {
  const present = ATTESTATION_ENV_KEYS.filter((key) => env[key] !== undefined);
  if (present.length === 0) return undefined;
  const apiKey = env["PXE_BRIDGE_ATTESTATION_API_KEY"];
  const arn = env["PXE_BRIDGE_ATTESTATION_SECRET_ARN"];
  const secretKey = env["PXE_BRIDGE_ATTESTATION_SECRET_KEY"];
  const sourceChainId = env["PXE_BRIDGE_ATTESTATION_SOURCE_CHAIN_ID"];
  const environment = env["PXE_BRIDGE_ATTESTATION_ENVIRONMENT"];
  const relayUrl = env["PXE_BRIDGE_ATTESTATION_RELAY_URL"];
  const relayToken = env["PXE_BRIDGE_ATTESTATION_RELAY_TOKEN"];
  if (
    !apiKey ||
    Boolean(arn) === Boolean(secretKey) ||
    !sourceChainId ||
    !POSITIVE_DECIMAL.test(sourceChainId) ||
    !environment ||
    !relayUrl ||
    !relayToken
  ) {
    throw new Error(
      "Attestation configuration is partial: set the API key, exactly one attestation " +
        "secret source, source chain id, environment, relay URL and relay token together",
    );
  }
  const normalizeKeyMaterial = (value: string): string => {
    const trimmed = value.trim();
    return /^(?:0x)?[0-9a-fA-F]{64}$/.test(trimmed)
      ? trimmed.replace(/^0x/i, "").toLowerCase()
      : trimmed;
  };
  const custodyValues = [
    env["PXE_BRIDGE_SECRET_KEY"],
    env["SPENDING_LIMIT_ADMIN_KEY"],
    env["PXE_BRIDGE_ALLOWLIST_SEED"],
  ]
    .filter((value): value is string => value !== undefined)
    .map(normalizeKeyMaterial);
  const credentials = [apiKey, relayToken, ...otherCredentials].filter(
    (value): value is string => value !== undefined,
  );
  if (
    (secretKey !== undefined &&
      [...custodyValues, ...credentials.map(normalizeKeyMaterial)].includes(
        normalizeKeyMaterial(secretKey),
      )) ||
    (arn !== undefined && arn === env["PXE_BRIDGE_SECRET_ARN"])
  ) {
    throw new Error(
      "Attestation secret custody must not reuse any spend, admin, allowlist, or bearer secret",
    );
  }
  assertRelayUrl(relayUrl);
  if (new Set(credentials).size !== credentials.length) {
    throw new Error(
      "Attestation API, relay, main RPC, admin and outbound credentials must all differ",
    );
  }
  return {
    apiKey,
    secretConfigured: true,
    domain: { sourceChainId, environment },
    relay: { url: relayUrl, token: relayToken },
  };
}


export interface AttestationAuditEvent {
  method: AttestationMethod | "RootUpdate";
  outcome: "signed" | "refused" | "delivered" | "retry";
  reason?: AttestationRefusalReason | "relay_unavailable";
}

export interface AttestationProducerOptions {
  probe: AttestationChainProbe;
  journal: SettlementJournal;
  allowlistTree: AllowlistTree;
  signer: ReadinessSigner;
  domain: AttestationDomainConfig;
  now?: () => number;
  audit?: (event: AttestationAuditEvent) => void;
}

function sameNetwork(left: NetworkIdentity, right: NetworkIdentity): boolean {
  return (
    left.aztecChainId === right.aztecChainId &&
    left.protocolVersion === right.protocolVersion &&
    left.rollupAddress.toLowerCase() === right.rollupAddress.toLowerCase() &&
    left.l1ChainId === right.l1ChainId &&
    left.genesisOrNetworkDigest.toLowerCase() === right.genesisOrNetworkDigest.toLowerCase()
  );
}

function refusal(reason: AttestationRefusalReason): AttestationRefusal {
  return { status: "refused", reason };
}

export class AttestationProducer {
  private readonly now: () => number;
  private readonly profile = AZTEC_RECIPIENT_PROFILES["aztec-6.0.0"];

  constructor(private readonly options: AttestationProducerOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  get domainConfig(): AttestationDomainConfig {
    return this.options.domain;
  }

  async attestMembership(params: AttestationParams): Promise<MembershipResult> {
    const validated = await this.validateRequest(params, "aztec_attestRecipientMembership");
    if (validated.status === "refused") return validated;
    const { observation, descriptorDigest } = validated;
    const root = observation.allowlistRoot.toLowerCase();
    const localRoot = this.options.allowlistTree.root.toString().toLowerCase();
    if (root !== localRoot) {
      return this.refuse("aztec_attestRecipientMembership", "allowlist_root_mismatch");
    }

    let snapshot;
    try {
      snapshot = this.options.journal.allowlistSnapshot(root);
    } catch {
      return this.refuse("aztec_attestRecipientMembership", "journal_unavailable");
    }
    if (!snapshot) {
      return this.refuse("aztec_attestRecipientMembership", "allowlist_snapshot_unavailable");
    }
    if (!this.options.allowlistTree.matchesRecipients(snapshot.recipients)) {
      return this.refuse("aztec_attestRecipientMembership", "membership_uncertain");
    }

    const listed = snapshot.recipients.some(
      ({ address }) => address.toLowerCase() === params.recipient.toLowerCase(),
    );
    const witness = this.options.allowlistTree.witnessFor(params.recipient);
    if (witness) {
      try {
        const reproduced = await rootFromSiblingPath(
          Fr.fromString(params.recipient),
          witness.leafSalt,
          witness.leafIndex,
          witness.siblingPath,
        );
        if (reproduced.toString().toLowerCase() !== root) {
          return this.refuse("aztec_attestRecipientMembership", "membership_uncertain");
        }
      } catch {
        return this.refuse("aztec_attestRecipientMembership", "membership_uncertain");
      }
    }

    const attestation: MembershipAttestation = {
      descriptorDigest,
      root: root as Hex,
      member: listed,
      rootBlock: BigInt(observation.finalized.blockNumber),
      attestedAt: this.now(),
    };
    const record = await this.sign("Membership", attestation, observation.network);
    if (!record) return this.refuse("aztec_attestRecipientMembership", "signer_failed");
    this.audit({ method: "aztec_attestRecipientMembership", outcome: "signed" });
    return record;
  }

  async attestRecipientDeployment(
    params: AttestationParams,
  ): Promise<RecipientDeploymentResult> {
    const validated = await this.validateRequest(params, "aztec_attestRecipientDeployment");
    if (validated.status === "refused") return validated;
    const deployment = validated.observation.recipientDeployment;
    if (!deployment) {
      return this.refuse("aztec_attestRecipientDeployment", "deployment_uncertain");
    }
    if (
      deployment.state === "present" &&
      deployment.classId.toLowerCase() !== this.profile.pinnedClassId
    ) {
      return this.refuse("aztec_attestRecipientDeployment", "class_mismatch");
    }
    const deployed = deployment.state === "present" && deployment.initialized;
    const attestation: RecipientDeploymentAttestation = {
      descriptorDigest: validated.descriptorDigest,
      recipient: params.recipient as Hex,
      classId: this.profile.pinnedClassId,
      deployed,
      finalBlock: BigInt(validated.observation.finalized.blockNumber),
      attestedAt: this.now(),
    };
    const record = await this.sign(
      "RecipientDeployment",
      attestation,
      validated.observation.network,
    );
    if (!record) return this.refuse("aztec_attestRecipientDeployment", "signer_failed");
    this.audit({ method: "aztec_attestRecipientDeployment", outcome: "signed" });
    return record;
  }

  async rootUpdate(observation: FinalizedAttestationObservation): Promise<RootUpdateRecord | null> {
    try {
      if (
        !POSITIVE_DECIMAL.test(observation.finalized.blockNumber) ||
        !HEX32.test(observation.finalized.blockHash) ||
        BigInt(observation.finalized.blockHash) === 0n ||
        !NONNEGATIVE_DECIMAL.test(observation.finalized.timestamp) ||
        finalizedTimeReason(BigInt(observation.finalized.timestamp), this.now()) !== undefined ||
        observation.network.genesisOrNetworkDigest.toLowerCase() !==
          this.options.domain.genesisOrNetworkDigest.toLowerCase()
      ) {
        return null;
      }
    } catch {
      return null;
    }
    const attestation: RootUpdateAttestation = {
      root: observation.allowlistRoot.toLowerCase() as Hex,
      rootBlock: BigInt(observation.finalized.blockNumber),
      attestedAt: this.now(),
    };
    return this.sign("RootUpdate", attestation, observation.network);
  }

  domainFor(network: NetworkIdentity) {
    return readinessDomain(
      this.options.domain.sourceChainId,
      this.options.domain.environment,
      network,
      this.options.domain.manifestDigest,
    );
  }

  private async validateRequest(
    params: AttestationParams,
    method: AttestationMethod,
  ): Promise<
    | { status: "ok"; observation: FinalizedAttestationObservation; descriptorDigest: Hex }
    | AttestationRefusal
  > {
    let descriptorDigest: Hex;
    try {
      verifyRecipientDescriptor(params.descriptor as RecipientDescriptor, this.profile);
      descriptorDigest = hashRecipientDescriptor(params.descriptor as RecipientDescriptor);
    } catch (cause) {
      const reason =
        cause instanceof RecipientEncodingError && cause.code === "class_not_pinned"
          ? "class_mismatch"
          : "invalid_descriptor";
      return this.refuse(method, reason);
    }
    if (descriptorDigest !== params.descriptorDigest.toLowerCase()) {
      return this.refuse(method, "descriptor_digest_mismatch");
    }
    if (
      params.descriptor.aztecAddress.toLowerCase() !== params.recipient.toLowerCase()
    ) {
      return this.refuse(method, "recipient_mismatch");
    }
    if (
      params.corridor.corridorId.toLowerCase() !==
        this.options.domain.corridorId.toLowerCase() ||
      params.corridor.corridorRevision !== this.options.domain.corridorRevision ||
      params.corridor.manifestDigest.toLowerCase() !==
        this.options.domain.manifestDigest.toLowerCase()
    ) {
      return this.refuse(method, "corridor_mismatch");
    }
    if (!sameNetwork(params.descriptor.network, params.network)) {
      return this.refuse(method, "network_mismatch");
    }
    try {
      const wrapped = recipientMessage(params.recipientAuthorization.digest);
      if (
        !verifyRecipientSchnorr(
          {
            x: params.descriptor.signingPublicKeyX,
            y: params.descriptor.signingPublicKeyY,
          },
          wrapped.messageField,
          params.recipientAuthorization.signature,
        )
      ) {
        return this.refuse(method, "binding_authorization_invalid");
      }
    } catch {
      return this.refuse(method, "binding_authorization_invalid");
    }

    let observed: AttestationObservation;
    try {
      observed = await this.options.probe.observeAttestationChain(
        params.recipient,
        this.options.domain.genesisOrNetworkDigest,
      );
    } catch {
      return this.refuse(method, "finalized_history_unavailable");
    }
    if (observed.state === "unknown") return this.refuse(method, observed.reason);
    const { finalized } = observed.value;
    let finalizedTimestamp: bigint;
    try {
      if (
        !POSITIVE_DECIMAL.test(finalized.blockNumber) ||
        !HEX32.test(finalized.blockHash) ||
        BigInt(finalized.blockHash) === 0n ||
        !NONNEGATIVE_DECIMAL.test(finalized.timestamp)
      ) {
        return this.refuse(method, "finalized_reference_invalid");
      }
      finalizedTimestamp = BigInt(finalized.timestamp);
    } catch {
      return this.refuse(method, "finalized_reference_invalid");
    }
    const timeReason = finalizedTimeReason(finalizedTimestamp, this.now());
    if (timeReason !== undefined) return this.refuse(method, timeReason);
    if (
      !sameNetwork(params.network, observed.value.network) ||
      observed.value.network.genesisOrNetworkDigest.toLowerCase() !==
        this.options.domain.genesisOrNetworkDigest.toLowerCase()
    ) {
      return this.refuse(method, "network_mismatch");
    }
    return { status: "ok", observation: observed.value, descriptorDigest };
  }

  private async sign(
    primaryType: "Membership",
    attestation: MembershipAttestation,
    network: NetworkIdentity,
  ): Promise<MembershipRecord | null>;
  private async sign(
    primaryType: "RecipientDeployment",
    attestation: RecipientDeploymentAttestation,
    network: NetworkIdentity,
  ): Promise<RecipientDeploymentRecord | null>;
  private async sign(
    primaryType: "RootUpdate",
    attestation: RootUpdateAttestation,
    network: NetworkIdentity,
  ): Promise<RootUpdateRecord | null>;
  private async sign(
    primaryType: "Membership" | "RecipientDeployment" | "RootUpdate",
    attestation:
      | MembershipAttestation
      | RecipientDeploymentAttestation
      | RootUpdateAttestation,
    network: NetworkIdentity,
  ): Promise<MembershipRecord | RecipientDeploymentRecord | RootUpdateRecord | null> {
    try {
      const digest = readinessDigest(primaryType, attestation as never, this.domainFor(network));
      const signature = await this.options.signer.signDigest(digest);
      const wire = {
        ...attestation,
        ...(primaryType === "RecipientDeployment"
          ? { finalBlock: (attestation as RecipientDeploymentAttestation).finalBlock.toString() }
          : {
              rootBlock: (
                attestation as MembershipAttestation | RootUpdateAttestation
              ).rootBlock.toString(),
            }),
        signature,
      };
      if (primaryType === "Membership") return MembershipRecordSchema.parse(wire);
      if (primaryType === "RecipientDeployment") {
        return RecipientDeploymentRecordSchema.parse(wire);
      }
      return RootUpdateRecordSchema.parse(wire);
    } catch {
      return null;
    }
  }

  private refuse(method: AttestationMethod, reason: AttestationRefusalReason): AttestationRefusal {
    this.audit({ method, outcome: "refused", reason });
    return refusal(reason);
  }

  private audit(event: AttestationAuditEvent): void {
    this.options.audit?.(event);
  }
}

export interface RootUpdateRelayOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

function assertRelayUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new Error("Attestation relay URL must not contain credentials");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Attestation relay URL must use HTTPS or loopback HTTP");
  }
  return url.toString();
}

export class RootUpdatePublisher {
  private readonly relayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly runId = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;
  private lastFinalizedRoot: string | undefined;

  constructor(
    private readonly producer: AttestationProducer,
    private readonly probe: AttestationChainProbe,
    private readonly journal: SettlementJournal,
    private readonly relay: RootUpdateRelayOptions,
    private readonly audit?: (event: AttestationAuditEvent) => void,
  ) {
    this.relayUrl = assertRelayUrl(relay.url);
    this.fetchImpl = relay.fetch ?? fetch;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      const observation = await this.probe.observeAttestationChain(
        undefined,
        this.producer.domainConfig.genesisOrNetworkDigest,
      );
      if (observation.state === "known") {
        const identity = observation.value.allowlistRoot.toLowerCase();
        const pendingCurrent = this.journal
          .pendingRootUpdates()
          .some((entry) => entry.root.toLowerCase() === identity);
        if (pendingCurrent) {
          // A crash may have left the current root's exact signed payload
          // uncertain. Retry it and its idempotency key; never replace it with
          // a freshly signed startup payload.
          this.lastFinalizedRoot = identity;
        } else if (identity !== this.lastFinalizedRoot) {
          const record = await this.producer.rootUpdate(observation.value);
          if (record) {
            const digest = readinessDigest(
              "RootUpdate",
              {
                root: record.root as Hex,
                rootBlock: BigInt(record.rootBlock),
                attestedAt: record.attestedAt,
              },
              this.producer.domainFor(observation.value.network),
            );
            const payload = RootUpdateEnvelopeSchema.parse({
              corridor_id: this.producer.domainConfig.corridorId,
              corridor_revision: this.producer.domainConfig.corridorRevision,
              record,
            });
            this.journal.enqueueRootUpdate({
              id: `${this.runId}:${identity}:${record.rootBlock}`,
              root: record.root,
              rootBlock: record.rootBlock,
              payload,
              idempotencyKey: digest,
            });
            this.lastFinalizedRoot = identity;
          } else {
            this.audit?.({
              method: "RootUpdate",
              outcome: "retry",
              reason: "signer_failed",
            });
          }
        }
      } else {
        this.audit?.({
          method: "RootUpdate",
          outcome: "retry",
          reason: observation.reason,
        });
      }
      await this.deliverPending();
    } catch {
      this.audit?.({ method: "RootUpdate", outcome: "retry", reason: "internal_error" });
    } finally {
      this.active = false;
    }
  }

  private async deliverPending(): Promise<void> {
    for (const entry of this.journal.pendingRootUpdates()) {
      try {
        const response = await this.fetchImpl(this.relayUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.relay.token}`,
            "content-type": "application/json",
            "idempotency-key": entry.idempotencyKey,
          },
          body: JSON.stringify(RootUpdateEnvelopeSchema.parse(entry.payload)),
          signal: AbortSignal.timeout(ROOT_UPDATE_RELAY_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`relay returned ${response.status}`);
        this.journal.recordRootUpdateAttempt(entry.id, { delivered: true });
        this.audit?.({ method: "RootUpdate", outcome: "delivered" });
      } catch {
        this.journal.recordRootUpdateAttempt(entry.id, {
          delivered: false,
          error: "relay unavailable",
        });
        this.audit?.({ method: "RootUpdate", outcome: "retry", reason: "relay_unavailable" });
      }
    }
  }
}

export function attestationAudit(event: AttestationAuditEvent): void {
  console.log(`[attestation] ${JSON.stringify(event)}`);
}

export function attestationRpcError(
  id: string | number | null,
  code: number,
  message: string,
): { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } } {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
export function attestationRpcRefusal(
  id: string | number | null,
  refusalReason: AttestationRefusalReason,
): z.infer<typeof AttestationRpcRefusalResponseSchema> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32010,
      message: "Readiness attestation refused",
      data: { signed: false, refusal: refusalReason },
    },
  };
}

export function attestationHttpStatus(response: unknown): 200 | 503 {
  return AttestationRpcRefusalResponseSchema.safeParse(response).success ? 503 : 200;
}


export async function handleAttestationRpc(
  raw: unknown,
  producer: AttestationProducer,
): Promise<AttestationRpcResponse> {
  const parsed = AttestationRpcRequestSchema.safeParse(raw);
  if (!parsed.success) return attestationRpcError(null, -32600, "Invalid request");
  const { id, method, params } = parsed.data;
  const result =
    method === "aztec_attestRecipientMembership"
      ? await producer.attestMembership(params)
      : await producer.attestRecipientDeployment(params);
  return "status" in result
    ? attestationRpcRefusal(id, result.reason)
    : { jsonrpc: "2.0", id, result };
}
