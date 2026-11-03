import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OxideAllowlist } from "../src/oxide/allowlist.js";
import { openBoundJournal, tempJournalPath } from "./settlement-fixtures.js";

const SCRIPT = fileURLToPath(new URL("../scripts/oxide-allowlist.ts", import.meta.url));
const SEED = "0x" + "12".repeat(32);
const MEMBER = "0x" + "0c".repeat(32);
const NEWCOMER = "0x" + "0d".repeat(32);
const CURRENT = [{ address: MEMBER, index: 3 }];

function run(env: Record<string, string>, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A journal whose newest RootUpdate is for `root`, closed so the script can read it. */
function journalAttesting(root: string | undefined): string {
  const path = tempJournalPath();
  const journal = openBoundJournal(path);
  if (root !== undefined) {
    journal.enqueueRootUpdate({ id: "run:1", root, rootBlock: "7", payload: {}, idempotencyKey: "0x01" });
  }
  journal.close();
  return path;
}

function env(journal: string, recipients: unknown = CURRENT): Record<string, string> {
  return {
    PXE_BRIDGE_OXIDE_ALLOWLIST_SEED: SEED,
    PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS: JSON.stringify(recipients),
    PXE_BRIDGE_JOURNAL: journal,
  };
}

// Spawning tsx takes seconds.
describe("oxide-allowlist", { timeout: 60_000 }, () => {
  it("prints only the next set on stdout once the running set is confirmed", async () => {
    const current = await OxideAllowlist.build(SEED, CURRENT);
    const r = run(env(journalAttesting(current.root)), ["--add", NEWCOMER, "--index", "611"]);
    expect(r.stderr).toContain("add at position 611: 1 -> 2 recipient(s)");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      { address: MEMBER, index: 3 },
      { address: NEWCOMER, index: 611 },
    ]);
    expect(r.stderr).not.toContain(NEWCOMER.slice(2));
    expect(r.stderr).not.toContain(current.root.slice(2));

    const revoked = run(env(journalAttesting(current.root)), ["--revoke", MEMBER]);
    expect(revoked.status).toBe(0);
    expect(JSON.parse(revoked.stdout)).toEqual([]);
  });

  it("refuses a set that is not the one the bridge last attested", async () => {
    const other = await OxideAllowlist.build(SEED, [{ address: MEMBER, index: 4 }]);
    const r = run(env(journalAttesting(other.root)), ["--add", NEWCOMER, "--index", "611"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not build the root of the bridge's newest RootUpdate");
  });

  it("needs --initial before the first RootUpdate, and refuses it after", async () => {
    const empty = journalAttesting(undefined);
    const refused = run(env(empty), ["--add", NEWCOMER, "--index", "random"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("holds no RootUpdate yet");
    const initial = run(env(empty), ["--add", NEWCOMER, "--index", "random", "--initial"]);
    expect(initial.status).toBe(0);
    expect(JSON.parse(initial.stdout)).toHaveLength(2);

    const current = await OxideAllowlist.build(SEED, CURRENT);
    const late = run(env(journalAttesting(current.root)), ["--add", NEWCOMER, "--index", "611", "--initial"]);
    expect(late.status).toBe(1);
    expect(late.stderr).toContain("--initial is refused");
  });

  it("refuses while the bridge holds the journal", async () => {
    const current = await OxideAllowlist.build(SEED, CURRENT);
    const path = tempJournalPath();
    const journal = openBoundJournal(path);
    journal.enqueueRootUpdate({ id: "run:1", root: current.root, rootBlock: "7", payload: {}, idempotencyKey: "0x01" });
    try {
      const r = run(env(path), ["--add", NEWCOMER, "--index", "611"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("stop the bridge first");
    } finally {
      journal.close();
    }
  });

  it("applies update-allowlist's position and duplicate checks", async () => {
    const current = await OxideAllowlist.build(SEED, CURRENT);
    const journal = journalAttesting(current.root);
    expect(run(env(journal), ["--add", NEWCOMER]).stderr).toContain("--index random");
    expect(run(env(journal), ["--add", NEWCOMER, "--index", "3"]).stderr).toContain("position 3 is already occupied");
    expect(run(env(journal), ["--add", MEMBER, "--index", "9"]).stderr).toContain("already in the set");
    expect(run(env(journal), ["--revoke", NEWCOMER]).stderr).toContain("not in the current set");
    expect(
      run({ ...env(journal), PXE_BRIDGE_ACCOUNT_ADDRESS: NEWCOMER }, ["--add", NEWCOMER, "--index", "9"]).stderr,
    ).toContain("sending account");
  });
});
