import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_DAILY_LIMIT, DEFAULT_MAX_PER_TX } from "../src/oxide/caps.js";
import { readAllowlistControlConfig } from "../src/oxide/allowlist-control.js";
import { resolveSendModeConfig } from "../src/oxide/config.js";

/** A complete Oxide-mode environment. */
const OXIDE_ENV: NodeJS.ProcessEnv = {
  PXE_BRIDGE_SEND_MODE: "oxide",
  PXE_BRIDGE_JOURNAL: "/var/lib/pxe-bridge/journal.sqlite",
  PXE_BRIDGE_OXIDE_JOURNAL: "/var/lib/pxe-bridge/oxide.sqlite",
  PXE_BRIDGE_OXIDE_L1_RPC_URL: "https://eth.example",
  PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT: "/app/contracts/oxide/oxide_token_contract/target/oxide_token_contract-OxideToken.json",
  PXE_BRIDGE_SETTLEMENT_CORRIDOR: "{}",
  PXE_BRIDGE_MAY_BROADCAST_URL: "https://riddler.example/may-broadcast",
};

describe("resolveSendModeConfig (PXE_BRIDGE_SEND_MODE)", () => {
  it("keeps the spending_limit bridge when unset or named", () => {
    expect(resolveSendModeConfig({})).toEqual({ mode: "spending_limit" });
    expect(resolveSendModeConfig({ PXE_BRIDGE_SEND_MODE: "spending_limit" })).toEqual({ mode: "spending_limit" });
  });

  it("refuses an unknown mode", () => {
    expect(() => resolveSendModeConfig({ PXE_BRIDGE_SEND_MODE: "OXIDE" })).toThrow(/must be "spending_limit" or "oxide"/);
  });

  it("refuses Oxide variables a spending_limit bridge would ignore", () => {
    expect(() => resolveSendModeConfig({ PXE_BRIDGE_OXIDE_JOURNAL: "/tmp/oxide.sqlite" })).toThrow(
      /PXE_BRIDGE_OXIDE_JOURNAL set without PXE_BRIDGE_SEND_MODE=oxide/,
    );
    expect(() => resolveSendModeConfig({ PXE_BRIDGE_OXIDE_ALLOWLIST_SEED: "0x01" })).toThrow(/ALLOWLIST_SEED/);
    expect(() => resolveSendModeConfig({ PXE_BRIDGE_OXIDE_ALLOWLIST_SEED_FILE: "/run/secrets/seed" })).toThrow(
      /ALLOWLIST_SEED_FILE/,
    );
    expect(() =>
      resolveSendModeConfig({ PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS_FILE: "/run/secrets/recipients" }),
    ).toThrow(/ALLOWLIST_RECIPIENTS_FILE/);
    expect(() =>
      resolveSendModeConfig({
        PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL: "https://api.example/control",
      }),
    ).toThrow(/CONTROL_URL/);
  });

  it("resolves a complete Oxide environment with the default caps", () => {
    expect(resolveSendModeConfig(OXIDE_ENV)).toEqual({
      mode: "oxide",
      journalPath: OXIDE_ENV["PXE_BRIDGE_OXIDE_JOURNAL"],
      initializeJournal: false,
      l1RpcUrl: "https://eth.example",
      tokenArtifactPath: OXIDE_ENV["PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT"],
      caps: expect.objectContaining({ maxPerTx: DEFAULT_MAX_PER_TX, dailyLimit: DEFAULT_DAILY_LIMIT }),
    });
  });

  it("passes only an explicit journal initialization acknowledgement", () => {
    expect(resolveSendModeConfig({ ...OXIDE_ENV, PXE_BRIDGE_OXIDE_JOURNAL_INITIALIZE: "true" })).toMatchObject({
      mode: "oxide",
      initializeJournal: true,
    });
    expect(() =>
      resolveSendModeConfig({ ...OXIDE_ENV, PXE_BRIDGE_OXIDE_JOURNAL_INITIALIZE: "TRUE" }),
    ).toThrow(/must be "true" or "false"/);
    expect(() =>
      resolveSendModeConfig({
        PXE_BRIDGE_SEND_MODE: "spending_limit",
        PXE_BRIDGE_OXIDE_JOURNAL_INITIALIZE: "true",
      }),
    ).toThrow(/set without PXE_BRIDGE_SEND_MODE=oxide/);
  });

  it.each([
    "PXE_BRIDGE_JOURNAL",
    "PXE_BRIDGE_OXIDE_JOURNAL",
    "PXE_BRIDGE_OXIDE_L1_RPC_URL",
    "PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT",
    "PXE_BRIDGE_SETTLEMENT_CORRIDOR",
    "PXE_BRIDGE_MAY_BROADCAST_URL",
  ])("refuses Oxide mode without %s", (name) => {
    expect(() => resolveSendModeConfig({ ...OXIDE_ENV, [name]: "" })).toThrow(new RegExp(`requires ${name}`));
  });

  it.each([
    "PXE_BRIDGE_SPENDING_LIMIT_ADMIN",
    "PXE_BRIDGE_ACCOUNT_DEPLOYMENT",
    "PXE_BRIDGE_MAX_AMOUNT",
    "PXE_BRIDGE_DAILY_LIMIT",
    "PXE_BRIDGE_COOLDOWN_DELAY_MS",
  ])("refuses Oxide mode alongside %s", (name) => {
    expect(() => resolveSendModeConfig({ ...OXIDE_ENV, [name]: "1" })).toThrow(new RegExp(`unset ${name}`));
  });

  it("refuses one file for both journals, however the path is spelled", () => {
    expect(() =>
      resolveSendModeConfig({ ...OXIDE_ENV, PXE_BRIDGE_OXIDE_JOURNAL: "/var/lib/pxe-bridge/../pxe-bridge/journal.sqlite" }),
    ).toThrow(/its own file/);
  });

  it("refuses an L1 RPC that is not an http(s) URL, and caps above the token's note cap", () => {
    expect(() => resolveSendModeConfig({ ...OXIDE_ENV, PXE_BRIDGE_OXIDE_L1_RPC_URL: "eth.example" })).toThrow(/not a URL/);
    expect(() => resolveSendModeConfig({ ...OXIDE_ENV, PXE_BRIDGE_OXIDE_L1_RPC_URL: "ws://eth.example" })).toThrow(/http/);
    expect(() =>
      resolveSendModeConfig({ ...OXIDE_ENV, PXE_BRIDGE_OXIDE_MAX_PER_TX: "2", PXE_BRIDGE_OXIDE_DAILY_LIMIT: "1" }),
    ).toThrow(/cannot exceed/);
  });
});

describe("readAllowlistControlConfig", () => {
  const control = {
    PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL: "https://api.example/control",
    PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_TOKEN: "dedicated-control-token-value-12345",
    PXE_BRIDGE_OXIDE_ALLOWLIST_ADMIN: `0x${"11".repeat(20)}`,
  };

  it("is absent by default and requires every gate together", () => {
    expect(readAllowlistControlConfig({})).toBeUndefined();
    expect(() =>
      readAllowlistControlConfig({ PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL: control.PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL }),
    ).toThrow(/requires/);
    expect(() =>
      readAllowlistControlConfig({ PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_INTERVAL_MS: "1000" }),
    ).toThrow(/requires/);
  });

  it("accepts HTTPS or loopback HTTP and refuses credential aliasing", () => {
    expect(readAllowlistControlConfig(control)).toMatchObject({
      url: "https://api.example/control",
      token: "dedicated-control-token-value-12345",
      intervalMs: 10_000,
    });
    expect(
      readAllowlistControlConfig({
        ...control,
        PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL: "http://127.0.0.1:8787/control",
      }),
    ).toMatchObject({ url: "http://127.0.0.1:8787/control" });
    expect(() =>
      readAllowlistControlConfig(
        { ...control, PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_URL: "http://api.example/control" },
      ),
    ).toThrow(/HTTPS/);
    expect(() =>
      readAllowlistControlConfig(control, ["dedicated-control-token-value-12345"]),
    ).toThrow(/differ/);
  });

  it.each([16, 24, 31])("refuses a %i-character control token", (length) => {
    expect(() =>
      readAllowlistControlConfig({
        ...control,
        PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_TOKEN: "x".repeat(length),
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("accepts a dedicated 32-character control token", () => {
    expect(
      readAllowlistControlConfig({
        ...control,
        PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_TOKEN: "x".repeat(32),
      }),
    ).toMatchObject({ token: "x".repeat(32) });
  });

  it.each(["K1", "readiness"])(
    "refuses alternate hex encoding of the %s credential",
    () => {
      const key = `0x${"ab".repeat(32)}`;
      const alternateEncoding = "AB".repeat(32);
      expect(() =>
        readAllowlistControlConfig(
          {
            ...control,
            PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_TOKEN: alternateEncoding,
          },
          [key],
        ),
      ).toThrow(/credential or private key/);
    },
  );

  it("refuses a control token equal to the private allowlist seed", () => {
    const seed = `0x${"aB".repeat(32)}`;
    const seedDigest = createHash("sha256")
      .update(seed.slice(2).toLowerCase())
      .digest("hex");
    expect(() =>
      readAllowlistControlConfig(
        { ...control, PXE_BRIDGE_OXIDE_ALLOWLIST_CONTROL_TOKEN: seed },
        [],
        [seedDigest],
      ),
    ).toThrow(/credential or private key/);
  });
});
