import type { JournalHealth } from "../journal.js";
import type { ReadinessFact, ReadinessReason } from "../readiness.js";
import type { CorridorConfig } from "../settlement.js";
import type { NodeNetwork } from "../types.js";
import type { OxideAllowlist } from "./allowlist.js";
import { WINDOW_MS, type OxideCapsConfig } from "./caps.js";
import { EnclaveTrustRefused, enclaveRefusalPermanent, type EnclaveRefusal } from "./enclave.js";
import { OxidePinMismatch } from "./pins.js";
import { oxideFeeRunwayReasons, type OxideFeeRunway } from "./sender.js";

/**
 * Oxide-mode readiness (xochi-fi/pxe-bridge#84, OX-7/OX-11): authenticated
 * `/ready` in Oxide mode and the admission verdict the Oxide settlement path
 * asks before a FRESH send. Its JSON shape is a published contract
 * (pxe-bridge#84, docs/settlement-operations.md "Oxide readiness") that
 * Riddler reads (axol-io/Riddler#1437).
 *
 * Two questions, kept apart (integration decision on pxe-bridge#88):
 * - `ready` / `reasons`: SERVING HEALTH. Can the bridge carry out what it
 *   already admitted (pins, L1, portal not frozen, enclave, node, journal,
 *   attestation configured)? Riddler gates payouts of already-admitted,
 *   already-pulled orders on this alone, so capacity can never stall them.
 * - `admission.freshSend` / `admission.reasons`: CAPACITY for one more new
 *   order (private balance, fee runway, the 24h window). It gates quotes,
 *   new reservations and the bridge's own fresh-send admission (transient).
 *   Resends and already-prepared operations never consult it.
 *
 * Every fact is `{state: "known", ...}` or `{state: "unknown", reason}`:
 * an unreadable value is never reported as zero. Nothing here exposes the
 * private allowlist, its root or its size, and failures are logged by error
 * class only: an RPC error message can carry its URL and API key.
 */

/** Known facts are flat objects; unknown ones carry only the reason. */
export type OxideFact<T extends object> = ({ state: "known" } & T) | { state: "unknown"; reason: ReadinessReason };

export interface OxideReadinessProjection {
  /** Serving health only; never capacity. */
  ready: boolean;
  /** Serving-health reasons. */
  reasons: ReadinessReason[];
  /** Capacity for one more fresh send: `ready` and no capacity reason. */
  admission: { freshSend: boolean; reasons: ReadinessReason[] };
  /** Unix seconds. */
  observedAt: number;
  sendMode: "oxide";
  accountMode: "standard";
  accountAddress: string;
  token: string;
  oxide: {
    /** The corridor this bridge serves (`PXE_BRIDGE_SETTLEMENT_CORRIDOR`), for Riddler's pre-pull recheck. */
    corridor: OxideFact<{ corridorId: string; corridorRevision: number; manifestDigest: string }>;
    /** The network it serves: the node's identity plus the corridor's genesis/network digest. */
    network: OxideFact<{
      aztecChainId: string;
      protocolVersion: string;
      rollupAddress: string;
      l1ChainId: string;
      genesisOrNetworkDigest: string;
    }>;
    /** OXDAI base units (18 decimals), decimal strings. */
    privateBalance: OxideFact<{
      observed: string;
      syncedBlock: string;
      /** Unix seconds of the balance read (a snapshot may be served while the PXE is busy proving). */
      readAt: number;
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
    /** OXDAI base units, decimal strings; the window is the rolling 24h of durable (marked) spends. */
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
    /** Whether readiness attestations (Membership/RootUpdate over the private root) are configured. */
    attestation: { configured: boolean };
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
  /** The published Oxide manifest and zk.money profile (`OxidePinChecker.assertPinned`, itself cached 5 minutes). */
  manifestPins: { assertPinned(): Promise<void> };
  l1Pins: OxideL1PinSource;
  enclave: { attestEnclave(): Promise<void> };
  node: { isReady(): Promise<boolean> };
  /** `AztecClient.networkIdentity` (the node's chain, protocol, rollup, L1 chain). */
  network: { networkIdentity(): Promise<NodeNetwork> };
  /** `PXE_BRIDGE_SETTLEMENT_CORRIDOR`; absent is not ready (`corridor_unconfigured`). */
  corridor: CorridorConfig | undefined;
  /** Whether the attestation producer and RootUpdate publisher run (index.ts). */
  attestationConfigured: boolean;
  /** Milliseconds. */
  now?: () => number;
  /** How long a successful manifest, L1 or enclave check is reused on `/ready`; failures are never reused. */
  externalCheckTtlMs?: number;
  /** How long one call waits for a fresh private balance before serving the last snapshot. */
  balanceWaitMs?: number;
  /** The oldest private balance snapshot still served. */
  balanceMaxAgeMs?: number;
}

/**
 * A call waits this long for the PXE's balance read. `balance_of` and the
 * synced header share the PXE's serial queue with `proveTx`, so while a send
 * is proving the read waits minutes; readiness must not.
 */
export const OXIDE_BALANCE_WAIT_MS = 2_000;
/**
 * The oldest balance snapshot served (PROPOSED). Serving an older read is
 * conservative: every spend is a journaled attempt, and `committedPrincipal`
 * is recomputed against the snapshot's own synced block on every call, so
 * whatever landed after it is still counted as committed.
 */
export const OXIDE_BALANCE_MAX_AGE_MS = 10 * 60_000;

/** Successful pin/L1/enclave checks are reused this long on `/ready`: each costs several L1 and HTTPS reads. */
export const OXIDE_EXTERNAL_CHECK_TTL_MS = 60_000;

/** Capacity reasons: they move to `admission.reasons` and never touch `ready`. */
const CAPACITY_REASONS: Partial<Record<ReadinessReason, true>> = {
  private_balance_unknown: true,
  private_balance_insufficient: true,
  journal_unreadable: true,
  fee_runway_unknown: true,
  fee_runway_insufficient: true,
  spend_window_unknown: true,
  spend_window_exhausted: true,
};

const known = <T extends object>(value: T): OxideFact<T> => ({ state: "known", ...value });
const unknown = <T extends object>(reason: ReadinessReason): OxideFact<T> => ({ state: "unknown", reason });

/**
 * The error's class (and a refusal's typed reason) for a log line. Never the
 * message: viem and node errors embed the request URL, and an L1 RPC URL
 * carries its API key.
 */
function errorClass(cause: unknown): string {
  if (cause instanceof EnclaveTrustRefused) return `${cause.name}(${cause.reason})`;
  if (cause instanceof OxidePinMismatch) return `${cause.name}(${cause.source})`;
  return cause instanceof Error ? cause.name : typeof cause;
}

/** A cached successful check; a failure is never cached, so the next call reads again. */
class SuccessCache<T> {
  private value: { at: number; result: T } | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  async get(read: () => Promise<T>, keep: (result: T) => boolean, fresh = false): Promise<T> {
    const at = this.now();
    if (!fresh && this.value !== undefined && at - this.value.at < this.ttlMs) return this.value.result;
    this.value = undefined;
    const result = await read();
    if (keep(result)) this.value = { at, result };
    return result;
  }
}

export class OxideReadiness {
  private readonly now: () => number;
  private balanceSnapshot: { observed: bigint; syncedBlock: number; atMs: number } | undefined;
  private balanceRefresh: Promise<void> | undefined;
  private readonly manifestCache: SuccessCache<OxideFact<{ pinned: boolean }>>;
  private readonly l1Cache: SuccessCache<OxideFact<{ pinned: boolean; portalFrozen: boolean }>>;
  private readonly enclaveCache: SuccessCache<OxideFact<{ attested: boolean }>>;
  /** Why the last enclave check refused, so admission can tell a structural refusal from a transient one. */
  private lastEnclaveRefusal: EnclaveRefusal | undefined;

  constructor(private readonly options: OxideReadinessOptions) {
    this.now = options.now ?? Date.now;
    const ttl = options.externalCheckTtlMs ?? OXIDE_EXTERNAL_CHECK_TTL_MS;
    this.manifestCache = new SuccessCache(ttl, this.now);
    this.l1Cache = new SuccessCache(ttl, this.now);
    this.enclaveCache = new SuccessCache(ttl, this.now);
  }

  /**
   * The admission verdict for one fresh send of `amount`:
   * - a recipient outside the private allowlist, a non-positive amount or one
   *   above `maxPerTx` is refused permanently (requote);
   * - a bridge whose live deployment is no longer the pinned one -- the
   *   manifest or profile moved (`oxide_pin_mismatch`, #744), L1 is not the
   *   pinned chain/registry/portal (`oxide_l1_not_pinned`), or the enclave's
   *   PCR0 is not the pinned image hashing to `TeeRegistry.PCR0_HASH()`
   *   (`enclave_attestation_refused`) -- refuses permanently too (OX-6): no
   *   retry of this process clears it, only a reviewed re-pin;
   * - otherwise it is admitted iff `ready`, `admission.freshSend`, and
   *   `amount <= privateBalance.available` and `amount <= caps.windowHeadroom`;
   *   anything else is `not_ready` (transient).
   * L1 and the portal's frozen flag are read fresh here, never from the
   * `/ready` cache. Neither answer names the allowlist's contents.
   */
  async admit(terms: { recipient: string; amount: string }): Promise<OxideAdmissionVerdict> {
    if (!this.options.allowlist.admits(terms.recipient.toLowerCase())) {
      return { kind: "refused", reason: "recipient_not_allowlisted", retryable: false };
    }
    let amount: bigint;
    try {
      amount = BigInt(terms.amount);
    } catch {
      return { kind: "refused", reason: "amount_invalid", retryable: false };
    }
    if (amount <= 0n) return { kind: "refused", reason: "amount_invalid", retryable: false };
    if (amount > this.options.caps.maxPerTx) {
      return { kind: "refused", reason: "amount_over_per_tx_cap", retryable: false };
    }
    const readiness = await this.observe({ freshL1: true });
    if (!readiness.ready) {
      const structural = readiness.reasons.find((reason) => this.structural(reason));
      if (structural !== undefined) return { kind: "refused", reason: structural, retryable: false };
      return { kind: "not_ready", reasons: readiness.reasons };
    }
    if (!readiness.admission.freshSend) return { kind: "not_ready", reasons: readiness.admission.reasons };
    const { privateBalance, caps } = readiness.oxide;
    // freshSend implies both are known; narrowed for the compiler.
    if (privateBalance.state !== "known" || caps.state !== "known") {
      return { kind: "not_ready", reasons: ["readiness_observation_failed"] };
    }
    const reasons: ReadinessReason[] = [];
    if (amount > BigInt(privateBalance.available)) reasons.push("private_balance_insufficient");
    if (amount > BigInt(caps.windowHeadroom)) reasons.push("spend_window_exhausted");
    return reasons.length === 0 ? { kind: "admitted" } : { kind: "not_ready", reasons };
  }

  /** A health reason no cycle of this process clears: the deployment is not the pinned one. */
  private structural(reason: ReadinessReason): boolean {
    if (reason === "oxide_pin_mismatch" || reason === "oxide_l1_not_pinned") return true;
    return (
      reason === "enclave_attestation_refused" &&
      this.lastEnclaveRefusal !== undefined &&
      enclaveRefusalPermanent(this.lastEnclaveRefusal)
    );
  }

  /** The projection `/ready` serves. `freshL1` bypasses the L1/portal cache (admission). */
  async observe(options: { freshL1?: boolean } = {}): Promise<OxideReadinessProjection> {
    const nowMs = this.now();
    const nowSeconds = Math.floor(nowMs / 1_000);
    const [privateBalance, runway, manifest, l1, enclave, node, network] = await Promise.all([
      this.privateBalance(nowMs),
      this.feeRunway(),
      this.manifestCache.get(() => this.manifestPins(), (fact) => fact.state === "known" && fact.pinned),
      this.l1Cache.get(
        () => this.l1Pins(),
        (fact) => fact.state === "known" && fact.pinned && !fact.portalFrozen,
        options.freshL1 === true,
      ),
      this.enclaveCache.get(() => this.enclave(), (fact) => fact.state === "known" && fact.attested),
      this.node(),
      this.network(),
    ]);
    const caps = this.caps(nowMs);
    const corridor = this.corridor();
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
    if (!this.options.attestationConfigured) reasons.add("attestation_unconfigured");
    add(corridor);
    add(network);

    const health = [...reasons].filter((reason) => CAPACITY_REASONS[reason] !== true);
    const capacity = [...reasons].filter((reason) => CAPACITY_REASONS[reason] === true);
    const ready = health.length === 0;
    return {
      ready,
      reasons: health,
      admission: { freshSend: ready && capacity.length === 0, reasons: capacity },
      observedAt: nowSeconds,
      sendMode: "oxide",
      accountMode: "standard",
      accountAddress: this.options.account.toLowerCase(),
      token: this.options.token.toLowerCase(),
      oxide: {
        corridor,
        network,
        privateBalance,
        feeRunway,
        caps,
        pins: { manifest, l1 },
        enclave,
        node,
        journal: { writable: journal.writable, ...(journal.writable ? {} : { reason: journal.reason }) },
        attestation: { configured: this.options.attestationConfigured },
      },
    };
  }

  /**
   * The private balance, net of in-flight principal. The PXE read runs in the
   * background (one at a time); a call waits `balanceWaitMs` for it, then
   * serves the newest snapshot no older than `balanceMaxAgeMs`, with the
   * committed principal recomputed against that snapshot's synced block.
   */
  private async privateBalance(nowMs: number): Promise<OxideReadinessProjection["oxide"]["privateBalance"]> {
    if (this.balanceRefresh === undefined) {
      const refresh = this.options.balance.privateBalance().then(
        (read) => {
          this.balanceSnapshot = { ...read, atMs: this.now() };
        },
        (cause: unknown) => {
          console.error(`[oxide] Private balance read failed: ${errorClass(cause)}`);
        },
      );
      this.balanceRefresh = refresh;
      void refresh.finally(() => {
        if (this.balanceRefresh === refresh) this.balanceRefresh = undefined;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `Promise.withResolvers` is outside this project's ES lib target.
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.balanceWaitMs ?? OXIDE_BALANCE_WAIT_MS);
    });
    try {
      await Promise.race([this.balanceRefresh, waited]);
    } finally {
      clearTimeout(timer);
    }
    const snapshot = this.balanceSnapshot;
    if (snapshot === undefined || nowMs - snapshot.atMs > (this.options.balanceMaxAgeMs ?? OXIDE_BALANCE_MAX_AGE_MS)) {
      return unknown("private_balance_unknown");
    }
    let committed: { total: bigint; sends: number };
    try {
      committed = this.options.journal.committedPrincipal(Math.floor(nowMs / 1_000), snapshot.syncedBlock);
    } catch (cause) {
      console.error(`[oxide] Committed principal read failed: ${errorClass(cause)}`);
      return unknown("journal_unreadable");
    }
    return known({
      observed: snapshot.observed.toString(),
      syncedBlock: String(snapshot.syncedBlock),
      readAt: Math.floor(snapshot.atMs / 1_000),
      committed: committed.total.toString(),
      committedSends: committed.sends,
      available: (snapshot.observed > committed.total ? snapshot.observed - committed.total : 0n).toString(),
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
      console.error(`[oxide] Fee runway read failed: ${errorClass(cause)}`);
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
      console.error(`[oxide] Spend window read failed: ${errorClass(cause)}`);
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
      console.error(`[oxide] Manifest/profile pin check: ${errorClass(cause)}`);
      return cause instanceof OxidePinMismatch ? known({ pinned: false }) : unknown("oxide_pins_unknown");
    }
  }

  private async l1Pins(): Promise<OxideFact<{ pinned: boolean; portalFrozen: boolean }>> {
    try {
      await this.options.l1Pins.assertPinned();
      return known({ pinned: true, portalFrozen: false });
    } catch (cause) {
      console.error(`[oxide] L1 pin check: ${errorClass(cause)}`);
      if (!(cause instanceof EnclaveTrustRefused)) return unknown("oxide_l1_unknown");
      if (cause.reason === "portal_frozen") return known({ pinned: true, portalFrozen: true });
      if (cause.reason !== "l1_not_pinned") return unknown("oxide_l1_unknown");
    }
    // Not pinned: the frozen flag is read on its own rather than assumed.
    try {
      return known({ pinned: false, portalFrozen: await this.options.l1Pins.portalFrozen() });
    } catch (cause) {
      console.error(`[oxide] Portal frozen read failed: ${errorClass(cause)}`);
      return unknown("oxide_l1_unknown");
    }
  }

  private async enclave(): Promise<OxideFact<{ attested: boolean }>> {
    try {
      await this.options.enclave.attestEnclave();
      this.lastEnclaveRefusal = undefined;
      return known({ attested: true });
    } catch (cause) {
      console.error(`[oxide] Enclave attestation check: ${errorClass(cause)}`);
      if (!(cause instanceof EnclaveTrustRefused)) return unknown("enclave_unreachable");
      this.lastEnclaveRefusal = cause.reason;
      return known({ attested: false });
    }
  }

  private corridor(): OxideReadinessProjection["oxide"]["corridor"] {
    const corridor = this.options.corridor;
    if (corridor === undefined) return unknown("corridor_unconfigured");
    return known({
      corridorId: corridor.corridorId.toLowerCase(),
      corridorRevision: corridor.corridorRevision,
      manifestDigest: corridor.manifestDigest.toLowerCase(),
    });
  }

  private async network(): Promise<OxideReadinessProjection["oxide"]["network"]> {
    const corridor = this.options.corridor;
    if (corridor === undefined) return unknown("corridor_unconfigured");
    try {
      const node = await this.options.network.networkIdentity();
      return known({
        aztecChainId: node.aztecChainId,
        protocolVersion: node.protocolVersion,
        rollupAddress: node.rollupAddress.toLowerCase(),
        l1ChainId: node.l1ChainId,
        genesisOrNetworkDigest: corridor.genesisOrNetworkDigest.toLowerCase(),
      });
    } catch (cause) {
      console.error(`[oxide] Network identity read failed: ${errorClass(cause)}`);
      return unknown("network_identity_unknown");
    }
  }

  private async node(): Promise<OxideFact<{ acceptingTransactions: boolean }>> {
    try {
      return known({ acceptingTransactions: await this.options.node.isReady() });
    } catch (cause) {
      console.error(`[oxide] Node readiness read failed: ${errorClass(cause)}`);
      return unknown("node_readiness_unknown");
    }
  }
}
