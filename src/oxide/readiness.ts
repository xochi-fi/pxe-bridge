import type { JournalHealth } from "../journal.js";
import type { ReadinessFact, ReadinessReason } from "../readiness.js";
import type { OxideAllowlist } from "./allowlist.js";
import { WINDOW_MS, type OxideCapsConfig } from "./caps.js";
import { EnclaveTrustRefused } from "./enclave.js";
import { OxidePinMismatch } from "./pins.js";
import { oxideFeeRunwayReasons, type OxideFeeRunway } from "./sender.js";

/**
 * Oxide-mode readiness (xochi-fi/pxe-bridge#84, OX-7/OX-11): the one
 * predicate behind authenticated `/ready` in Oxide mode and the admission
 * verdict the Oxide settlement path asks before a FRESH send. Its JSON shape
 * is a published contract (pxe-bridge#84, docs/settlement-operations.md
 * "Oxide readiness"); Riddler reserves against `privateBalance.available`.
 *
 * Every fact is `{state: "known", ...}` or `{state: "unknown", reason}`:
 * an unreadable value is never reported as zero. Nothing here exposes the
 * private allowlist, its root or its size.
 */

/** Known facts are flat objects; unknown ones carry only the reason. */
export type OxideFact<T extends object> = ({ state: "known" } & T) | { state: "unknown"; reason: ReadinessReason };

export interface OxideReadinessProjection {
  ready: boolean;
  reasons: ReadinessReason[];
  /** Unix seconds. */
  observedAt: number;
  sendMode: "oxide";
  accountMode: "standard";
  accountAddress: string;
  token: string;
  oxide: {
    /** OXDAI base units (18 decimals), decimal strings. */
    privateBalance: OxideFact<{
      observed: string;
      syncedBlock: string;
      committed: string;
      committedSends: number;
      available: string;
    }>;
    /** Fee juice base units, decimal strings. */
    feeRunway: OxideFact<{
      observed: string;
      committed: string;
      committedSends: number;
      perSendFeeLimit: string;
    }>;
    /** OXDAI base units, decimal strings; the window is the rolling 24h of durable spends. */
    caps: OxideFact<{
      maxPerTx: string;
      dailyLimit: string;
      windowSpent: string;
      windowHeadroom: string;
    }>;
    pins: {
      manifest: OxideFact<{ pinned: boolean }>;
      l1: OxideFact<{ pinned: boolean; portalFrozen: boolean }>;
    };
    enclave: OxideFact<{ attested: boolean }>;
    node: OxideFact<{ acceptingTransactions: boolean }>;
    journal: { writable: boolean; reason?: string };
  };
}

/** The settlement path's admission verdict for one fresh send. */
export type OxideAdmissionVerdict =
  | { kind: "admitted" }
  | { kind: "not_ready"; reasons: ReadinessReason[] }
  | { kind: "refused"; reason: string; retryable: boolean };

/** The L1 pin check: the pinned chain/registry/portal, and the portal's frozen flag. */
export interface OxideL1PinSource {
  /** `assertL1Pinned`: throws `EnclaveTrustRefused` (`l1_not_pinned` / `portal_frozen`), anything else when unread. */
  assertPinned(): Promise<void>;
  /** `OxidePortal.$frozen()`. */
  portalFrozen(): Promise<boolean>;
}

export interface OxideReadinessOptions {
  allowlist: OxideAllowlist;
  /** The sending account and the OXDAI token, lowercase 0x hex. */
  account: string;
  token: string;
  caps: OxideCapsConfig;
  journal: {
    health(): JournalHealth;
    committedPrincipal(nowSeconds: number, syncedBlock: number): { total: bigint; sends: number };
    spentSince(sinceMs: number): bigint;
  };
  balance: { privateBalance(): Promise<{ observed: bigint; syncedBlock: number }> };
  feeRunway: () => Promise<ReadinessFact<OxideFeeRunway>>;
  /** The published Oxide manifest and zk.money profile (`OxidePinChecker.assertPinned`). */
  manifestPins: { assertPinned(): Promise<void> };
  l1Pins: OxideL1PinSource;
  enclave: { attestEnclave(): Promise<void> };
  node: { isReady(): Promise<boolean> };
  /** Milliseconds. */
  now?: () => number;
  /** How long a successful pin, L1 or enclave check is reused; failures are never reused. */
  externalCheckTtlMs?: number;
}

/** Successful pin/L1/enclave checks are reused this long: each costs several L1 and HTTPS reads. */
export const OXIDE_EXTERNAL_CHECK_TTL_MS = 60_000;

const known = <T extends object>(value: T): OxideFact<T> => ({ state: "known", ...value });
const unknown = <T extends object>(reason: ReadinessReason): OxideFact<T> => ({ state: "unknown", reason });

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A cached successful check; a failure is never cached, so the next call reads again. */
class SuccessCache<T> {
  private value: { at: number; result: T } | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  async get(read: () => Promise<T>, keep: (result: T) => boolean): Promise<T> {
    const at = this.now();
    if (this.value !== undefined && at - this.value.at < this.ttlMs) return this.value.result;
    this.value = undefined;
    const result = await read();
    if (keep(result)) this.value = { at, result };
    return result;
  }
}

export class OxideReadiness {
  private readonly now: () => number;
  private readonly manifestCache: SuccessCache<OxideFact<{ pinned: boolean }>>;
  private readonly l1Cache: SuccessCache<OxideFact<{ pinned: boolean; portalFrozen: boolean }>>;
  private readonly enclaveCache: SuccessCache<OxideFact<{ attested: boolean }>>;

  constructor(private readonly options: OxideReadinessOptions) {
    this.now = options.now ?? Date.now;
    const ttl = options.externalCheckTtlMs ?? OXIDE_EXTERNAL_CHECK_TTL_MS;
    this.manifestCache = new SuccessCache(ttl, this.now);
    this.l1Cache = new SuccessCache(ttl, this.now);
    this.enclaveCache = new SuccessCache(ttl, this.now);
  }

  /**
   * The admission verdict for one fresh send. A recipient outside the private
   * allowlist is a permanent refusal (requote to an approved recipient); a
   * bridge that is not ready, or whose available private balance does not
   * cover `amount`, answers `not_ready` (transient). Neither answer names the
   * allowlist's contents.
   */
  async admit(terms: { recipient: string; amount: string }): Promise<OxideAdmissionVerdict> {
    if (!this.options.allowlist.admits(terms.recipient.toLowerCase())) {
      return { kind: "refused", reason: "recipient_not_allowlisted", retryable: false };
    }
    const readiness = await this.observe();
    if (!readiness.ready) return { kind: "not_ready", reasons: readiness.reasons };
    const balance = readiness.oxide.privateBalance;
    if (balance.state !== "known") return { kind: "not_ready", reasons: [balance.reason] };
    let amount: bigint;
    try {
      amount = BigInt(terms.amount);
    } catch {
      return { kind: "refused", reason: "amount_invalid", retryable: false };
    }
    if (amount <= 0n) return { kind: "refused", reason: "amount_invalid", retryable: false };
    if (amount > BigInt(balance.available)) {
      return { kind: "not_ready", reasons: ["private_balance_insufficient"] };
    }
    return { kind: "admitted" };
  }

  async observe(): Promise<OxideReadinessProjection> {
    const nowMs = this.now();
    const nowSeconds = Math.floor(nowMs / 1_000);
    const [privateBalance, runway, manifest, l1, enclave, node] = await Promise.all([
      this.privateBalance(nowSeconds),
      this.feeRunway(),
      this.manifestCache.get(() => this.manifestPins(), (fact) => fact.state === "known" && fact.pinned),
      this.l1Cache.get(
        () => this.l1Pins(),
        (fact) => fact.state === "known" && fact.pinned && !fact.portalFrozen,
      ),
      this.enclaveCache.get(() => this.enclave(), (fact) => fact.state === "known" && fact.attested),
      this.node(),
    ]);
    const caps = this.caps(nowMs);
    const journal = this.options.journal.health();

    const reasons = new Set<ReadinessReason>();
    const add = (fact: { state: "known" } | { state: "unknown"; reason: ReadinessReason }): fact is { state: "known" } => {
      if (fact.state === "unknown") {
        reasons.add(fact.reason);
        return false;
      }
      return true;
    };
    if (add(privateBalance) && privateBalance.available === "0") reasons.add("private_balance_insufficient");
    // The sender's own predicate (`oxideFeeRunwayReasons`): unread, or short of one more send.
    for (const reason of runway.reasons) reasons.add(reason);
    const feeRunway = runway.projected;
    if (add(caps) && caps.windowHeadroom === "0") reasons.add("spend_window_exhausted");
    if (add(manifest) && !manifest.pinned) reasons.add("oxide_pin_mismatch");
    if (add(l1)) {
      if (!l1.pinned) reasons.add("oxide_l1_not_pinned");
      if (l1.portalFrozen) reasons.add("oxide_portal_frozen");
    }
    if (add(enclave) && !enclave.attested) reasons.add("enclave_attestation_refused");
    if (add(node) && !node.acceptingTransactions) reasons.add("node_not_ready");
    if (!journal.writable) reasons.add("journal_unwritable");

    return {
      ready: reasons.size === 0,
      reasons: [...reasons],
      observedAt: nowSeconds,
      sendMode: "oxide",
      accountMode: "standard",
      accountAddress: this.options.account.toLowerCase(),
      token: this.options.token.toLowerCase(),
      oxide: {
        privateBalance,
        feeRunway,
        caps,
        pins: { manifest, l1 },
        enclave,
        node,
        journal: { writable: journal.writable, ...(journal.writable ? {} : { reason: journal.reason }) },
      },
    };
  }

  private async privateBalance(nowSeconds: number): Promise<OxideReadinessProjection["oxide"]["privateBalance"]> {
    let read: { observed: bigint; syncedBlock: number };
    try {
      read = await this.options.balance.privateBalance();
    } catch (cause) {
      console.error(`[oxide] Private balance read failed: ${errorText(cause)}`);
      return unknown("private_balance_unknown");
    }
    let committed: { total: bigint; sends: number };
    try {
      committed = this.options.journal.committedPrincipal(nowSeconds, read.syncedBlock);
    } catch (cause) {
      console.error(`[oxide] Committed principal read failed: ${errorText(cause)}`);
      return unknown("journal_unreadable");
    }
    return known({
      observed: read.observed.toString(),
      syncedBlock: String(read.syncedBlock),
      committed: committed.total.toString(),
      committedSends: committed.sends,
      available: (read.observed > committed.total ? read.observed - committed.total : 0n).toString(),
    });
  }

  private async feeRunway(): Promise<{
    projected: OxideReadinessProjection["oxide"]["feeRunway"];
    reasons: ReadinessReason[];
  }> {
    let fact: ReadinessFact<OxideFeeRunway>;
    try {
      fact = await this.options.feeRunway();
    } catch (cause) {
      console.error(`[oxide] Fee runway read failed: ${errorText(cause)}`);
      fact = { state: "unknown", reason: "fee_runway_unknown" };
    }
    const reasons = oxideFeeRunwayReasons(fact);
    if (fact.state === "unknown") return { projected: unknown(fact.reason), reasons };
    const { observed, committed, committedSends, perSendFeeLimit } = fact.value;
    return {
      projected: known({
        observed: observed.toString(),
        committed: committed.toString(),
        committedSends,
        perSendFeeLimit: perSendFeeLimit.toString(),
      }),
      reasons,
    };
  }

  private caps(nowMs: number): OxideReadinessProjection["oxide"]["caps"] {
    const { maxPerTx, dailyLimit } = this.options.caps;
    let spent: bigint;
    try {
      spent = this.options.journal.spentSince(nowMs - WINDOW_MS);
    } catch (cause) {
      console.error(`[oxide] Spend window read failed: ${errorText(cause)}`);
      return unknown("spend_window_unknown");
    }
    return known({
      maxPerTx: maxPerTx.toString(),
      dailyLimit: dailyLimit.toString(),
      windowSpent: spent.toString(),
      windowHeadroom: (dailyLimit > spent ? dailyLimit - spent : 0n).toString(),
    });
  }

  private async manifestPins(): Promise<OxideFact<{ pinned: boolean }>> {
    try {
      await this.options.manifestPins.assertPinned();
      return known({ pinned: true });
    } catch (cause) {
      console.error(`[oxide] Manifest/profile pin check: ${errorText(cause)}`);
      return cause instanceof OxidePinMismatch ? known({ pinned: false }) : unknown("oxide_pins_unknown");
    }
  }

  private async l1Pins(): Promise<OxideFact<{ pinned: boolean; portalFrozen: boolean }>> {
    try {
      await this.options.l1Pins.assertPinned();
      return known({ pinned: true, portalFrozen: false });
    } catch (cause) {
      console.error(`[oxide] L1 pin check: ${errorText(cause)}`);
      if (!(cause instanceof EnclaveTrustRefused)) return unknown("oxide_l1_unknown");
      if (cause.reason === "portal_frozen") return known({ pinned: true, portalFrozen: true });
      if (cause.reason !== "l1_not_pinned") return unknown("oxide_l1_unknown");
    }
    // Not pinned: the frozen flag is read on its own rather than assumed.
    try {
      return known({ pinned: false, portalFrozen: await this.options.l1Pins.portalFrozen() });
    } catch (cause) {
      console.error(`[oxide] Portal frozen read failed: ${errorText(cause)}`);
      return unknown("oxide_l1_unknown");
    }
  }

  private async enclave(): Promise<OxideFact<{ attested: boolean }>> {
    try {
      await this.options.enclave.attestEnclave();
      return known({ attested: true });
    } catch (cause) {
      console.error(`[oxide] Enclave attestation check: ${errorText(cause)}`);
      return cause instanceof EnclaveTrustRefused ? known({ attested: false }) : unknown("enclave_unreachable");
    }
  }

  private async node(): Promise<OxideFact<{ acceptingTransactions: boolean }>> {
    try {
      return known({ acceptingTransactions: await this.options.node.isReady() });
    } catch (cause) {
      console.error(`[oxide] Node readiness read failed: ${errorText(cause)}`);
      return unknown("node_readiness_unknown");
    }
  }
}
