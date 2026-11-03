import { randomInt } from "node:crypto";
import { encodeAbiParameters, getAddress, keccak256, recoverMessageAddress, type Hex } from "viem";
import { z } from "zod";
import { ALLOWLIST_CAPACITY, type AllowlistRecipient } from "../allowlist-tree.js";
import type { RootUpdatePublisher } from "../attestation.js";
import type { SettlementJournal } from "../journal.js";
import type { CorridorConfig } from "../settlement.js";
import { type OxideAllowlist, type OxideAllowlistReplacement } from "./allowlist.js";
import { type AllowlistControlOperation, OxideJournal } from "./journal.js";

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX65 = /^0x[0-9a-f]{130}$/;
const LOOPBACK: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

const PollResponseSchema = z
  .object({
    operation_id: z.string().min(1).max(128),
    binding_id: z.string().min(1).max(128),
    action: z.enum(["approve", "revoke"]),
    recipient: z.string().regex(HEX32),
    state: z.literal("queued"),
  })
  .strict()
  .or(
    z
      .object({
        operation_id: z.string().min(1).max(128),
        binding_id: z.string().min(1).max(128),
        action: z.enum(["approve", "revoke"]),
        recipient: z.string().regex(HEX32),
        state: z.literal("authorized"),
        sequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
        digest: z.string().regex(HEX32),
        signature: z.string().regex(HEX65),
      })
      .strict(),
  );

type PollResponse = z.infer<typeof PollResponseSchema>;

export interface AllowlistControlConfig {
  url: string;
  token: string;
  admin: `0x${string}`;
  intervalMs: number;
}

export function readAllowlistControlConfig(
  env: NodeJS.ProcessEnv,
  distinctCredentials: readonly (string | undefined)[] = [],
): AllowlistControlConfig | undefined {
  const names = [
    "PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL",
    "PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_TOKEN",
    "PXE_BRIDGE_OXIDE_ALLOWLIST_ADMIN",
  ] as const;
  const values = names.map((name) => env[name]?.trim() ?? "");
  if (values.every((value) => value === "")) {
    if ((env["PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_INTERVAL_MS"] ?? "") !== "") {
      throw new Error("PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_INTERVAL_MS requires the allowlist control plane");
    }
    return undefined;
  }
  const missing = names.filter((_, index) => values[index] === "");
  if (missing.length > 0) throw new Error(`Oxide allowlist control requires ${missing.join(", ")}`);

  let endpoint: URL;
  try {
    endpoint = new URL(values[0]!);
  } catch {
    throw new Error("PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL is not a URL");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL cannot contain credentials or a fragment");
  }
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && LOOPBACK[endpoint.hostname])) {
    throw new Error("PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL must use HTTPS or loopback HTTP");
  }
  if (values[1]!.length < 16) {
    throw new Error("PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_TOKEN must contain at least 16 characters");
  }
  if (distinctCredentials.some((credential) => credential !== undefined && credential === values[1])) {
    throw new Error("Oxide allowlist control token must differ from every other bridge credential");
  }
  let admin: `0x${string}`;
  try {
    admin = getAddress(values[2]!) as `0x${string}`;
  } catch {
    throw new Error("PXE_BRIDGE_OXIDE_ALLOWLIST_ADMIN must be an EVM address");
  }
  const intervalRaw = env["PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_INTERVAL_MS"] ?? "10000";
  if (!/^[1-9][0-9]*$/.test(intervalRaw)) {
    throw new Error("PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_INTERVAL_MS must be a positive integer");
  }
  const intervalMs = Number(intervalRaw);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
    throw new Error("PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_INTERVAL_MS must be between 1000 and 300000");
  }
  return { url: endpoint.toString(), token: values[1]!, admin, intervalMs };
}

export class OxideAllowlistController {
  private active = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly config: AllowlistControlConfig,
    private readonly corridor: CorridorConfig,
    private readonly journal: OxideJournal,
    private readonly attestationJournal: SettlementJournal,
    private readonly allowlist: OxideAllowlist,
    private readonly rootUpdates: RootUpdatePublisher,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (corridor.corridorRevision !== 2) {
      throw new Error("Oxide allowlist control requires corridor revision 2");
    }
  }

  async initialize(): Promise<void> {
    const state = this.journal.initializeAllowlistControl(this.allowlist.root, this.allowlist.snapshot());
    const restored = await this.allowlist.replacement(state.recipients);
    if (restored.root !== state.root) {
      throw new Error("durable allowlist control state does not reproduce its private root");
    }
    this.allowlist.install(restored);
    this.attestationJournal.recordAllowlistSnapshot(state.root, state.recipients);
    this.attestationJournal.pruneAllowlistSnapshots(state.root);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
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
      const response = await this.controlRequest({ kind: "poll" });
      if (response.status === 204) return;
      if (response.status !== 200) throw new Error(`control poll returned HTTP ${response.status}`);
      const command = PollResponseSchema.parse(await response.json());
      if (command.state === "queued") await this.prepare(command);
      else await this.apply(command);
    } catch {
      // Values in this subsystem are private. One stable event is enough for
      // alerting; the operator reconciles the durable operation by id.
      console.error("[pxe-bridge] Oxide allowlist control tick refused");
    } finally {
      this.active = false;
    }
  }

  private async prepare(command: Extract<PollResponse, { state: "queued" }>): Promise<void> {
    let operation = this.journal.allowlistControlOperation(command.operation_id);
    if (!operation) {
      const current = this.journal.allowlistControlState();
      if (!current) throw new Error("allowlist control state is unavailable");
      const recipients = replaceRecipient(current.recipients, command.action, command.recipient);
      const replacement = await this.allowlist.replacement(recipients);
      const sequence = (BigInt(current.sequence) + 1n).toString();
      const digest = allowlistOperationDigest({
        operationId: command.operation_id,
        action: command.action,
        recipient: command.recipient,
        sequence,
        previousRoot: current.root,
        nextRoot: replacement.root,
        corridor: this.corridor,
      });
      operation = this.journal.prepareAllowlistControlOperation({
        operationId: command.operation_id,
        action: command.action,
        recipient: command.recipient,
        sequence,
        previousRoot: current.root,
        root: replacement.root,
        digest,
        recipients: replacement.recipients,
      });
    }
    if (
      operation.action !== command.action ||
      operation.recipient !== command.recipient ||
      operation.state === "applied"
    ) {
      throw new Error("queued command conflicts with its durable operation");
    }
    await this.expectNoContent({
      kind: "proposal",
      operation_id: operation.operationId,
      sequence: operation.sequence,
      digest: operation.digest,
    });
  }

  private async apply(command: Extract<PollResponse, { state: "authorized" }>): Promise<void> {
    const operation = this.journal.allowlistControlOperation(command.operation_id);
    if (
      !operation ||
      operation.action !== command.action ||
      operation.recipient !== command.recipient ||
      operation.sequence !== command.sequence ||
      operation.digest !== command.digest
    ) {
      throw new Error("authorized command does not match a durable proposal");
    }
    const signer = await recoverMessageAddress({
      message: { raw: command.digest as Hex },
      signature: command.signature as Hex,
    });
    if (getAddress(signer) !== this.config.admin) throw new Error("allowlist authorization signer is invalid");

    let applied: AllowlistControlOperation;
    let replacement: OxideAllowlistReplacement;
    if (operation.state === "applied") {
      applied = operation;
      replacement = await this.allowlist.replacement(operation.recipients);
    } else {
      this.journal.authorizeAllowlistControlOperation(
        operation.operationId,
        command.sequence,
        command.digest,
        command.signature,
      );
      replacement = await this.allowlist.replacement(operation.recipients);
      if (replacement.root !== operation.root) throw new Error("prepared replacement no longer reproduces its root");
      applied = this.journal.applyAllowlistControlOperation(operation.operationId);
    }
    this.allowlist.install(replacement);
    this.attestationJournal.recordAllowlistSnapshot(applied.root, applied.recipients);
    this.attestationJournal.pruneAllowlistSnapshots(applied.root);
    await this.rootUpdates.tick();
    await this.expectNoContent({
      kind: "result",
      operation_id: applied.operationId,
      sequence: applied.sequence,
      digest: applied.digest,
      outcome: "applied",
    });
  }

  private async expectNoContent(body: unknown): Promise<void> {
    const response = await this.controlRequest(body);
    if (response.status !== 204) throw new Error(`control update returned HTTP ${response.status}`);
  }

  private controlRequest(body: unknown): Promise<Response> {
    return this.fetchImpl(this.config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(this.config.intervalMs, 20_000)),
    });
  }
}

function replaceRecipient(
  current: readonly AllowlistRecipient[],
  action: "approve" | "revoke",
  recipient: string,
): AllowlistRecipient[] {
  const normalized = recipient.toLowerCase();
  const present = current.some(({ address }) => address.toLowerCase() === normalized);
  if (action === "revoke") {
    if (!present) throw new Error("recipient is not in the private set");
    return current.filter(({ address }) => address.toLowerCase() !== normalized).map((member) => ({ ...member }));
  }
  if (present) throw new Error("recipient is already in the private set");
  const occupied = new Set(current.map(({ index }) => index));
  if (occupied.size >= ALLOWLIST_CAPACITY) throw new Error("private set has no free position");
  let index = randomInt(ALLOWLIST_CAPACITY);
  while (occupied.has(index)) index = (index + 1) % ALLOWLIST_CAPACITY;
  return [...current.map((member) => ({ ...member })), { address: normalized, index }].sort(
    (left, right) => left.index - right.index,
  );
}

export function allowlistOperationDigest(input: {
  operationId: string;
  action: "approve" | "revoke";
  recipient: string;
  sequence: string;
  previousRoot: string;
  nextRoot: string;
  corridor: CorridorConfig;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "bytes32" },
      ],
      [
        input.operationId,
        input.action,
        input.recipient as Hex,
        BigInt(input.sequence),
        input.previousRoot as Hex,
        input.nextRoot as Hex,
        input.corridor.corridorId as Hex,
        input.corridor.corridorRevision,
        input.corridor.manifestDigest as Hex,
      ],
    ),
  );
}
