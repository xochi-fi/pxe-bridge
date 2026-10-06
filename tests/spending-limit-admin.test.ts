import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  PARAM_APPLY_WINDOW_SECONDS,
  PARAM_TIMELOCK_SECONDS,
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
    expect(() => parseAdminCommand(["status", "--daily", "5"])).toThrow("status takes only");
  });

  it("rejects status flags on other commands", () => {
    expect(() => parseAdminCommand(["unpause", "--expect-paused"])).toThrow("takes no flags");
    expect(() => parseAdminCommand(["propose-limits", "--max-per-tx=1", "--daily=1", "--min-fee-juice=1"])).toThrow(
      "takes only --max-per-tx",
    );
  });

  it("parses status expectations, defaulting to unpaused and unchecked", () => {
    expect(parseAdminCommand(["status"])).toEqual({
      kind: "status",
      expect: { paused: false, allowlistRoot: undefined, minFeeJuice: undefined },
    });
    expect(
      parseAdminCommand(["status", "--expect-paused", `--expect-root=0x${"AB".repeat(32)}`, "--min-fee-juice=7"]),
    ).toEqual({
      kind: "status",
      expect: { paused: true, allowlistRoot: `0x${"ab".repeat(32)}`, minFeeJuice: 7n },
    });
  });

  it("rejects a malformed expected root", () => {
    expect(() => parseAdminCommand(["status", "--expect-root", "0xabc"])).toThrow("32-byte hex");
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

  // An attacker's unpause during an incident must alert.
  it("alerts on unpaused when paused is expected, and not on paused", () => {
    const expectPaused = { paused: true };
    expect(statusExitCode(decodeAccountState(RAW), expectPaused)).toBe(2);
    expect(statusExitCode(decodeAccountState({ ...RAW, paused: 1n }), expectPaused)).toBe(0);
  });

  it("sets 8 when the root is not the expected one", () => {
    const state = decodeAccountState(RAW);
    expect(statusExitCode(state, { paused: false, allowlistRoot: state.allowlistRoot })).toBe(0);
    expect(statusExitCode(state, { paused: false, allowlistRoot: "0x" + "0".repeat(64) })).toBe(8);
  });

  it("sets 16 below the fee juice minimum, or when the balance was not read", () => {
    const state = decodeAccountState(RAW);
    const expect16 = { paused: false, minFeeJuice: 100n };
    expect(statusExitCode(state, expect16, 100n)).toBe(0);
    expect(statusExitCode(state, expect16, 99n)).toBe(16);
    expect(statusExitCode(state, expect16)).toBe(16);
    expect(statusExitCode(state, { paused: false }, 0n)).toBe(0);
  });

  it("ORs every bit", () => {
    const state = decodeAccountState({ ...RAW, pending_change_time: 5n });
    expect(
      statusExitCode(state, { paused: true, allowlistRoot: "0x" + "0".repeat(64), minFeeJuice: 1n }, 0n),
    ).toBe(2 | 4 | 8 | 16);
  });
});

// The contract class the copies of main.nr's `global PARAM_TIMELOCK_SECONDS`
// and `global PARAM_APPLY_WINDOW_SECONDS` were last checked against. Any change
// to main.nr moves CLASS_ID and fails this until the constants are re-checked
// and this is updated to match.
const TIMELOCK_CHECKED_AT_CLASS_ID =
  "0x049106c3c78f32b6650cc50521f43876f00fc97e5d0394541b370a6334235ad8";

describe("timelock constants", () => {
  it("were checked against the pinned contract class", async () => {
    const classId = await readFile(
      new URL("../contracts/spending_limit_account/CLASS_ID", import.meta.url),
      "utf8",
    );
    expect(classId.trim()).toBe(TIMELOCK_CHECKED_AT_CLASS_ID);
    expect(PARAM_TIMELOCK_SECONDS).toBe(86_400n);
    expect(PARAM_APPLY_WINDOW_SECONDS).toBe(86_400n);
  });
});
