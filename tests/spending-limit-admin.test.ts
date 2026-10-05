import { describe, it, expect } from "vitest";
import {
  PARAM_APPLY_WINDOW_SECONDS,
  U128_MAX,
  decodeAccountState,
  parseAdminCommand,
  proposalWindow,
  statusExitCode,
} from "../scripts/spending-limit-admin.js";
import type { StatusField } from "../scripts/spending-limit-admin.js";

const propose = (max: string, daily: string) =>
  parseAdminCommand(["propose-limits", `--max-per-tx=${max}`, `--daily=${daily}`]);

describe("parseAdminCommand", () => {
  it("accepts u128 max and daily equal to per-tx", () => {
    expect(propose(String(U128_MAX), String(U128_MAX))).toEqual({
      kind: "propose-limits",
      maxPerTx: U128_MAX,
      dailyLimit: U128_MAX,
    });
  });

  it("rejects values above u128", () => {
    expect(() => propose("1", String(U128_MAX + 1n))).toThrow("exceeds u128 max");
  });

  // assert_limits_valid in main.nr; propose_limits reverts on each.
  it.each([
    ["0", "5", "Per-tx limit must be non-zero"],
    ["5", "0", "Daily limit must be non-zero"],
    ["10", "9", "Daily limit must be >= per-tx max"],
  ])("rejects max %s daily %s as the contract does", (max, daily, message) => {
    expect(() => propose(max, daily)).toThrow(message);
  });

  it.each(["-1", "010", "1e3", "0x10", "1.0", " 1", ""])("rejects non-decimal %j", (value) => {
    expect(() => propose(value, "100")).toThrow("decimal integer");
  });

  it("requires both limit flags", () => {
    expect(() => parseAdminCommand(["propose-limits", "--max-per-tx", "1"])).toThrow(
      "--max-per-tx <n> and --daily <n>",
    );
  });

  it("rejects limit flags on other commands", () => {
    expect(() => parseAdminCommand(["pause", "--daily", "5"])).toThrow("takes no flags");
  });

  it("rejects unknown options, commands and extra positionals", () => {
    expect(() => parseAdminCommand(["pause", "--force"])).toThrow("Unknown option");
    expect(() => parseAdminCommand(["drain"])).toThrow('unknown command "drain"');
    expect(() => parseAdminCommand(["pause", "unpause"])).toThrow("exactly one command");
    expect(() => parseAdminCommand([])).toThrow("exactly one command");
  });
});

describe("proposalWindow", () => {
  const t = 1_000_000n;
  const closes = t + PARAM_APPLY_WINDOW_SECONDS;

  it("is none when pending_change_time is zero", () => {
    expect(proposalWindow(0n, t)).toEqual({ state: "none" });
  });

  // apply_limits: now >= change_time && now < change_time + window.
  it.each([
    [t - 1n, "timelocked"],
    [t, "open"],
    [closes - 1n, "open"],
    [closes, "expired"],
  ])("at %s is %s", (now, state) => {
    expect(proposalWindow(t, now)).toEqual({ state, opensAt: t, closesAt: closes });
  });
});

const RAW: Record<StatusField, bigint> = {
  initialized: 1n,
  paused: 0n,
  max_amount_per_tx: 10n,
  daily_limit: 100n,
  pending_max_amount: 0n,
  pending_daily_limit: 0n,
  pending_change_time: 0n,
  allowlist_root: 0xabcn,
  admin: 1n,
  permitted_token: 2n,
};

describe("decodeAccountState", () => {
  it("renders addresses and the root as 32-byte hex", () => {
    const state = decodeAccountState(RAW);
    expect(state.admin).toBe("0x" + "0".repeat(63) + "1");
    expect(state.allowlistRoot).toBe("0x" + "0".repeat(61) + "abc");
  });

  it("rejects a non-canonical bool", () => {
    expect(() => decodeAccountState({ ...RAW, paused: 2n })).toThrow("not a bool");
  });

  it("rejects a limit wider than u128", () => {
    expect(() => decodeAccountState({ ...RAW, daily_limit: U128_MAX + 1n })).toThrow(
      "out of range",
    );
  });
});

describe("statusExitCode", () => {
  it.each([
    [{}, 0],
    [{ paused: 1n }, 2],
    [{ pending_change_time: 5n }, 4],
    [{ paused: 1n, pending_change_time: 5n }, 6],
  ])("%o exits %i", (overrides, code) => {
    expect(statusExitCode(decodeAccountState({ ...RAW, ...overrides }))).toBe(code);
  });
});
