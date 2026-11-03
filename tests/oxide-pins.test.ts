import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  manifestMismatches,
  OxidePinChecker,
  OxidePinMismatch,
  OxidePinUnverified,
  OXIDE_V6_MAINNET,
  profileMismatches,
} from "../src/oxide/pins.js";

/** The members these tests move; the fixtures are the files as published on 2026-11-02. */
interface Manifest {
  deployments: {
    deploymentId: string;
    gitSha: string;
    pcr0: string;
    teeRegistry: string;
    enclaveUrl: string;
    bridges: { l2Token: string; l2TokenImmutables: { name: string; maxNoteAmount: string } }[];
  }[];
}
interface Profile {
  current: string;
  publishedAt: string;
  shared: { rollupVersion: string };
  versions: Record<
    string,
    {
      gitSha: string;
      oxide: { expectedGitSha: string; manifestUrl: string; portal: string };
      assets: { symbol: string; portal: string; expectedGitSha: string }[];
    }
  >;
}

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/oxide/${name}`, import.meta.url), "utf8"));
// Unchecked: the fixtures are the published files, which the pin checks under test validate.
const manifestFixture = () => read("releases.json") as Manifest;
const profileFixture = () => read("profile.json") as Profile;
const d0 = (m: Manifest) => m.deployments[0]!;
const b0 = (m: Manifest) => d0(m).bridges[0]!;
const cur = (p: Profile) => p.versions[p.current]!;

describe("Oxide pins", () => {
  it("the published manifest and profile match the pins", () => {
    expect(manifestMismatches(manifestFixture())).toEqual([]);
    expect(profileMismatches(profileFixture())).toEqual([]);
  });

  it.each([
    ["gitSha", (m: Manifest) => (d0(m).gitSha = "ea3459dc835ebc6161a266147cfd45fc9daf09ab")],
    ["pcr0", (m: Manifest) => (d0(m).pcr0 = "00".repeat(48))],
    ["teeRegistry", (m: Manifest) => (d0(m).teeRegistry = "0x" + "11".repeat(20))],
    ["enclaveUrl", (m: Manifest) => (d0(m).enclaveUrl = "https://evil.example/rpc")],
    ["bridge.l2Token", (m: Manifest) => (b0(m).l2Token = "0x" + "11".repeat(32))],
    // What upstream readOxideTokenImmutables would have produced.
    ["l2TokenImmutables.name", (m: Manifest) => (b0(m).l2TokenImmutables.name = "Dai Stablecoin")],
    [
      "l2TokenImmutables.maxNoteAmount",
      (m: Manifest) => (b0(m).l2TokenImmutables.maxNoteAmount = "10000000000000000000000"),
    ],
  ])("refuses a manifest whose %s moved", (field, mutate) => {
    const manifest = manifestFixture();
    mutate(manifest);
    expect(manifestMismatches(manifest)).toContain(field);
  });

  it("refuses a manifest without the pinned deployment or bridge", () => {
    const manifest = manifestFixture();
    d0(manifest).deploymentId = "dep-v7";
    expect(manifestMismatches(manifest)).toEqual(["deployments[dep-v6]"]);
    expect(manifestMismatches({})).toEqual(["deployments"]);
  });

  it.each([
    ["oxide.expectedGitSha", (p: Profile) => (cur(p).oxide.expectedGitSha = "00")],
    ["oxide.manifestUrl", (p: Profile) => (cur(p).oxide.manifestUrl = "https://evil.example/releases.json")],
    ["oxide.portal", (p: Profile) => (cur(p).oxide.portal = "0x" + "11".repeat(20))],
    ["shared.rollupVersion", (p: Profile) => (p.shared.rollupVersion = "1")],
  ])("refuses a profile whose %s moved", (field, mutate) => {
    const profile = profileFixture();
    mutate(profile);
    expect(profileMismatches(profile)).toContain(field);
  });

  it("ignores profile fields that move with every wallet release", () => {
    const profile = profileFixture();
    cur(profile).gitSha = "0".repeat(40);
    profile.publishedAt = "2027-01-01T00:00:00Z";
    expect(profileMismatches(profile)).toEqual([]);
  });

  describe("OxidePinChecker", () => {
    const served = (overrides: { manifest?: unknown; profile?: unknown; status?: number } = {}) => {
      const calls: string[] = [];
      const fetch = async (url: string) => {
        calls.push(url);
        const body = url === OXIDE_V6_MAINNET.manifestUrl ? (overrides.manifest ?? manifestFixture()) : (overrides.profile ?? profileFixture());
        return { ok: (overrides.status ?? 200) === 200, status: overrides.status ?? 200, json: async () => body };
      };
      return { fetch, calls };
    };

    it("caches a success for its TTL and re-reads after", async () => {
      let t = 0;
      const { fetch, calls } = served();
      const checker = new OxidePinChecker({ fetch, now: () => t, ttlMs: 1000 });
      await checker.assertPinned();
      await checker.assertPinned();
      expect(calls).toHaveLength(2);
      t = 1000;
      await checker.assertPinned();
      expect(calls).toHaveLength(4);
    });

    it("refuses a mismatch and never caches a failure", async () => {
      const manifest = manifestFixture();
      d0(manifest).gitSha = "0".repeat(40);
      const { fetch, calls } = served({ manifest });
      const checker = new OxidePinChecker({ fetch });
      await expect(checker.assertPinned()).rejects.toBeInstanceOf(OxidePinMismatch);
      await expect(checker.assertPinned()).rejects.toMatchObject({ source: "manifest", fields: ["gitSha"] });
      expect(calls).toHaveLength(4);
    });

    it("an unreadable file is unverified, not a mismatch", async () => {
      const { fetch } = served({ status: 503 });
      await expect(new OxidePinChecker({ fetch }).assertPinned()).rejects.toBeInstanceOf(OxidePinUnverified);
      const failing = new OxidePinChecker({ fetch: async () => Promise.reject(new Error("ECONNRESET")) });
      await expect(failing.assertPinned()).rejects.toBeInstanceOf(OxidePinUnverified);
    });

    it("a body that is not the file's shape is unverified, never a mismatch", async () => {
      // A mismatch refuses sends permanently, so only a file that describes
      // a deployment may say it moved: a CDN error object served as JSON, an
      // empty document, or a profile whose `current` names no version.
      const malformedManifest = manifestFixture() as unknown as { deployments: unknown[] };
      // The fixture is intentionally corrupted after its checked loader.
      const malformedDeployment = malformedManifest.deployments[0] as { bridges: unknown[] };
      malformedDeployment.bridges = [{ l2Token: OXIDE_V6_MAINNET.bridge.l2Token }];
      for (const manifest of [{}, { error: "upstream timeout" }, [], "ok", malformedManifest]) {
        const { fetch } = served({ manifest });
        await expect(new OxidePinChecker({ fetch }).assertPinned()).rejects.toBeInstanceOf(OxidePinUnverified);
      }
      const halfPublished = profileFixture();
      halfPublished.current = "v999";
      const malformedProfile = profileFixture() as unknown as { current: string; shared: unknown; versions: Record<string, unknown> };
      malformedProfile.versions[malformedProfile.current] = { oxide: { portal: OXIDE_V6_MAINNET.bridge.portal } };
      const emptyAssets = profileFixture();
      cur(emptyAssets).assets = [];
      for (const profile of [{}, { shared: {}, versions: {} }, halfPublished, malformedProfile, emptyAssets]) {
        const { fetch } = served({ profile });
        await expect(new OxidePinChecker({ fetch }).assertPinned()).rejects.toBeInstanceOf(OxidePinUnverified);
      }
      // A well-formed manifest that no longer lists the pinned deployment IS a mismatch.
      const removed = manifestFixture();
      d0(removed).deploymentId = "dep-v7";
      const { fetch } = served({ manifest: removed });
      await expect(new OxidePinChecker({ fetch }).assertPinned()).rejects.toMatchObject({
        source: "manifest",
        fields: ["deployments[dep-v6]"],
      });
    });

    it("an older success cannot cache over a newer mismatch", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let hold = true;
      let mismatch = false;
      let calls = 0;
      const fetch = async (url: string) => {
        calls += 1;
        const thisMismatch = mismatch;
        if (hold) await gate;
        const manifest = manifestFixture();
        if (thisMismatch) d0(manifest).gitSha = "0".repeat(40);
        return {
          ok: true,
          status: 200,
          json: async () => (url === OXIDE_V6_MAINNET.manifestUrl ? manifest : profileFixture()),
        };
      };
      const checker = new OxidePinChecker({ fetch, ttlMs: 60_000 });
      const older = checker.assertPinned();
      await Promise.resolve();
      hold = false;
      mismatch = true;
      await expect(checker.assertPinned()).rejects.toBeInstanceOf(OxidePinMismatch);
      release();
      await expect(older).resolves.toBeUndefined();
      await expect(checker.assertPinned()).rejects.toBeInstanceOf(OxidePinMismatch);
      expect(calls).toBeGreaterThanOrEqual(6);
    });
  });
});
