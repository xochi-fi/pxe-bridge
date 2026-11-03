/**
 * The Oxide v6 mainnet deployment this sender is pinned to (xochi-fi/xochi#737,
 * manifest rev 2), and the checks that refuse to send when the live Oxide
 * manifest or zk.money profile no longer describes it.
 *
 * Every value here was read from the published manifest and profile and, where
 * one exists, from L1 (TeeRegistry, CertManager, OxidePortal) on 2026-11-02.
 * A change upstream is a new deployment, not drift to absorb: the sender stops
 * and an operator re-pins after review.
 */
export const OXIDE_V6_MAINNET = {
  manifestUrl: "https://v6-prod.oxide.zk.money/v6/v6-prod/releases.json",
  profileUrl: "https://cdn.zk.money/profiles/v6/current.json",
  deploymentId: "dep-v6",
  /** Oxide deployment git sha; the profile names the same one as `expectedGitSha`. */
  gitSha: "3d8e29dc359023012a91d75538ed757dc9add937",
  l1ChainId: 1n,
  rollupVersion: 2070860440n,
  rollupAddress: "0xe37a2663cc9c119ba41572c40fab0bbb23a5402f",
  teeRegistry: "0x8b705c3519169f29850d156574ec377b686bd9cd",
  certManager: "0xe3dddf3d4b624f49b4ceb81807338cca14f5dd86",
  /** Raw 48-byte Nitro PCR0 of the approved enclave image. */
  pcr0: "4d28e5b10f51d67b1383f1cf738b567fe9e19efa6043d8470a5dad299d2e30c9e76e7493c0df7bb5e9c2cc2156348b73",
  /** keccak256(pcr0): `TeeRegistry.PCR0_HASH()`, immutable in the registry. */
  pcr0Hash: "0xf8c74ed4c30d08100cf653c802123b07a6880f3e2601e23d6bfd498d9db0423a",
  /** keccak256(AWS Nitro root G1 DER): `CertManager.ROOT_CA_CERT_HASH()`. */
  rootCaCertHash: "0x311d96fcd5c5e0ccf72ef548e2ea7d4c0cd53ad7c4cc49e67471aed41d61f185",
  enclaveUrl: "https://flt-v6.v6-prod.oxide.zk.money/rpc",
  bridge: {
    key: "dai",
    underlying: "0x6b175474e89094c44da98b954eedeac495271d0f",
    portal: "0xcb99c58fe81ae6b2cb4835e46f7b703745879042",
    l2Token: "0x11d2bed21a36289fd6f6a6af93a546b5be7115caf957f0f700f42d56e25fe0a3",
    /**
     * What the deployed token's address commits to. Never derive these from
     * the portal's underlying ERC-20 (upstream `readOxideTokenImmutables`): its
     * name is "Dai Stablecoin", the token's is "Oxide DAI".
     */
    l2TokenImmutables: {
      portal: "0xcb99c58fe81ae6b2cb4835e46f7b703745879042",
      teeRegistry: "0x8b705c3519169f29850d156574ec377b686bd9cd",
      name: "Oxide DAI",
      symbol: "OXDAI",
      decimals: 18,
      /** 5,166 DAI: the token refuses a larger note, and the portal a larger tx. */
      maxNoteAmount: 5_166_000_000_000_000_000_000n,
    },
  },
  /** Class of the deployed OXDAI instance (and of the OxideToken artifact the sender registers). */
  oxideTokenClassId: "0x27df40f914de0e4368b39b4d02821d42573dfe703502c3e7a44f5254345f3949",
} as const;

export type OxidePins = typeof OXIDE_V6_MAINNET;

/** The live manifest or profile no longer describes the pinned deployment. */
export class OxidePinMismatch extends Error {
  constructor(
    readonly source: "manifest" | "profile",
    readonly fields: readonly string[],
  ) {
    super(`Oxide ${source} differs from the pinned v6 deployment: ${fields.join(", ")}`);
    this.name = "OxidePinMismatch";
  }
}

/** The manifest or profile could not be read; nothing is known about the deployment. */
export class OxidePinUnverified extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`Oxide pins unverified: ${detail}`, options);
    this.name = "OxidePinUnverified";
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hex (with or without 0x) compared case-insensitively; everything else exactly, as strings. */
function same(actual: unknown, expected: string | number | bigint): boolean {
  if (typeof expected === "string" && /^(0x)?[0-9a-f]+$/i.test(expected)) {
    return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
  }
  return (typeof actual === "string" || typeof actual === "number") && String(actual) === String(expected);
}

/**
 * The fields of `releases.json` that decide where a send goes and who signs
 * it. Returns the names of every field that differs; empty means pinned.
 */
export function manifestMismatches(manifest: unknown, pins: OxidePins = OXIDE_V6_MAINNET): string[] {
  if (!isObject(manifest) || !Array.isArray(manifest["deployments"])) return ["deployments"];
  const deployments = manifest["deployments"].filter(
    (d): d is Json => isObject(d) && d["deploymentId"] === pins.deploymentId,
  );
  if (deployments.length !== 1) return [`deployments[${pins.deploymentId}]`];
  const d = deployments[0]!;
  const out: string[] = [];
  const check = (name: string, actual: unknown, expected: string | number | bigint) => {
    if (!same(actual, expected)) out.push(name);
  };
  check("gitSha", d["gitSha"], pins.gitSha);
  check("chainId", d["chainId"], pins.l1ChainId);
  check("rollupVersion", d["rollupVersion"], pins.rollupVersion);
  check("teeRegistry", d["teeRegistry"], pins.teeRegistry);
  check("certManager", d["certManager"], pins.certManager);
  check("pcr0", d["pcr0"], pins.pcr0);
  check("enclaveUrl", d["enclaveUrl"], pins.enclaveUrl);

  const bridges = Array.isArray(d["bridges"])
    ? d["bridges"].filter((b): b is Json => isObject(b) && b["key"] === pins.bridge.key)
    : [];
  if (bridges.length !== 1) return [...out, `bridges[${pins.bridge.key}]`];
  const b = bridges[0]!;
  check("bridge.token", b["token"], pins.bridge.underlying);
  check("bridge.underlying", b["underlying"], pins.bridge.underlying);
  check("bridge.portal", b["portal"], pins.bridge.portal);
  check("bridge.l2Token", b["l2Token"], pins.bridge.l2Token);
  const im = b["l2TokenImmutables"];
  if (!isObject(im)) return [...out, "bridge.l2TokenImmutables"];
  const expected = pins.bridge.l2TokenImmutables;
  check("l2TokenImmutables.portal", im["portal"], expected.portal);
  check("l2TokenImmutables.teeRegistry", im["teeRegistry"], expected.teeRegistry);
  check("l2TokenImmutables.name", im["name"], expected.name);
  check("l2TokenImmutables.symbol", im["symbol"], expected.symbol);
  check("l2TokenImmutables.decimals", im["decimals"], expected.decimals);
  check("l2TokenImmutables.maxNoteAmount", im["maxNoteAmount"], expected.maxNoteAmount);
  return out;
}

/**
 * The fields of the zk.money profile that name the Oxide deployment its wallet
 * trusts. Its other contents (wallet git sha, service URLs, contract classes)
 * move with every wallet release and decide nothing about this send.
 */
export function profileMismatches(profile: unknown, pins: OxidePins = OXIDE_V6_MAINNET): string[] {
  if (!isObject(profile) || !isObject(profile["shared"]) || !isObject(profile["versions"])) {
    return ["profile"];
  }
  const out: string[] = [];
  const check = (name: string, actual: unknown, expected: string | number | bigint) => {
    if (!same(actual, expected)) out.push(name);
  };
  check("shared.l1ChainId", profile["shared"]["l1ChainId"], pins.l1ChainId);
  check("shared.rollupVersion", profile["shared"]["rollupVersion"], pins.rollupVersion);
  const current = profile["current"];
  const version = typeof current === "string" ? profile["versions"][current] : undefined;
  if (!isObject(version)) return [...out, "versions[current]"];
  const oxide = version["oxide"];
  if (!isObject(oxide)) return [...out, "oxide"];
  check("oxide.manifestUrl", oxide["manifestUrl"], pins.manifestUrl);
  check("oxide.portal", oxide["portal"], pins.bridge.portal);
  check("oxide.expectedGitSha", oxide["expectedGitSha"], pins.gitSha);
  const assets = Array.isArray(version["assets"])
    ? version["assets"].filter((a): a is Json => isObject(a) && a["symbol"] === "DAI")
    : [];
  if (assets.length !== 1) return [...out, "assets[DAI]"];
  check("assets[DAI].portal", assets[0]!["portal"], pins.bridge.portal);
  check("assets[DAI].expectedGitSha", assets[0]!["expectedGitSha"], pins.gitSha);
  return out;
}

export interface PinCheckerOptions {
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now?: () => number;
  /** How long one successful check is trusted. */
  ttlMs?: number;
  timeoutMs?: number;
  pins?: OxidePins;
}

export const PIN_CHECK_TTL_MS = 5 * 60_000;
const PIN_FETCH_TIMEOUT_MS = 10_000;

/**
 * Reads the manifest and profile and refuses unless both describe the pinned
 * deployment. A success is trusted for `ttlMs`; a failure is never cached, so
 * the next attempt reads again.
 */
export class OxidePinChecker {
  private verifiedAt: number | undefined;
  private readonly fetchImpl: NonNullable<PinCheckerOptions["fetch"]>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly pins: OxidePins;

  constructor(options: PinCheckerOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, { signal: init.signal, redirect: "error" }));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PIN_CHECK_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? PIN_FETCH_TIMEOUT_MS;
    this.pins = options.pins ?? OXIDE_V6_MAINNET;
  }

  /** Throws `OxidePinMismatch` or `OxidePinUnverified`; returns once both match. */
  async assertPinned(): Promise<void> {
    const at = this.now();
    if (this.verifiedAt !== undefined && at - this.verifiedAt < this.ttlMs) return;
    this.verifiedAt = undefined;
    const [manifest, profile] = await Promise.all([
      this.read(this.pins.manifestUrl),
      this.read(this.pins.profileUrl),
    ]);
    const manifestOff = manifestMismatches(manifest, this.pins);
    if (manifestOff.length > 0) throw new OxidePinMismatch("manifest", manifestOff);
    const profileOff = profileMismatches(profile, this.pins);
    if (profileOff.length > 0) throw new OxidePinMismatch("profile", profileOff);
    this.verifiedAt = at;
  }

  private async read(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new OxidePinUnverified(`${url} answered HTTP ${response.status}`);
      return await response.json();
    } catch (cause) {
      if (cause instanceof OxidePinUnverified) throw cause;
      throw new OxidePinUnverified(`${url}: ${(cause as Error).message ?? String(cause)}`, { cause });
    } finally {
      clearTimeout(timer);
    }
  }
}
