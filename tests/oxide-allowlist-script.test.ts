import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OxideAllowlist } from "../src/oxide/allowlist.js";
import { openBoundJournal, tempJournalPath } from "./settlement-fixtures.js";

const SCRIPT = fileURLToPath(new URL("../scripts/oxide-allowlist.ts", import.meta.url));
const SEED = "0x" + "12".repeat(32);
const MEMBER = "0x" + "0c".repeat(32);
const NEWCOMER = "0x" + "0d".repeat(32);
const SENDER = "0x" + "0e".repeat(32);
const CURRENT = [{ address: MEMBER, index: 3 }];

function run(
  env: Record<string, string>,
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
    ...(input !== undefined ? { input } : {}),
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
    PXE_BRIDGE_ACCOUNT_ADDRESS: SENDER,
  };
}

/** The production form: secrets and the change on stdin, nothing in argv or the environment. */
function payload(lines: Record<string, string>, recipients: unknown = CURRENT): string {
  return Object.entries({
    PXE_BRIDGE_OXIDE_ALLOWLIST_SEED: SEED,
    PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS: JSON.stringify(recipients),
    ...lines,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

// Each case starts several isolated tsx processes so the tests exercise the
// production CLI boundary. Keep the per-process timeout in `run`; this outer
// timeout only accommodates the aggregate under a loaded runner.
describe("oxide-allowlist", { timeout: 420_000 }, () => {
  it("prints only the next set on stdout once the running set is confirmed", async () => {
    const current = await OxideAllowlist.build(SEED, CURRENT);
    const r = run(env(journalAttesting(current.root)), ["--add", NEWCOMER, "--index", "611"]);
    expect(r.stderr).toContain("add: checked against the bridge's newest RootUpdate");
    expect(r.stderr).toContain("root changes: yes");
    // Neither the position, the set's size nor any member describes the private set on stderr.
    expect(r.stderr).not.toMatch(/611|position|recipient\(s\)|1 -> 2/);
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

  it("takes the secrets and the change on stdin, with nothing in argv or the environment", async () => {
    const current = await OxideAllowlist.build(SEED, CURRENT);
    const journal = journalAttesting(current.root);
    const base = { PXE_BRIDGE_JOURNAL: journal, PXE_BRIDGE_ACCOUNT_ADDRESS: SENDER };
    const added = run(base, ["--stdin"], payload({ OXIDE_ALLOWLIST_ADD: NEWCOMER, OXIDE_ALLOWLIST_INDEX: "611" }));
    expect(added.status).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual([
      { address: MEMBER, index: 3 },
      { address: NEWCOMER, index: 611 },
    ]);
    expect(added.stderr).not.toContain(NEWCOMER.slice(2));
    const revoked = run(base, ["--stdin"], payload({ OXIDE_ALLOWLIST_REVOKE: MEMBER }));
    expect(revoked.status).toBe(0);
    expect(JSON.parse(revoked.stdout)).toEqual([]);

    // --initial rides in the payload, and the empty-journal rule still applies.
    const empty = journalAttesting(undefined);
    const initial = run(
      { ...base, PXE_BRIDGE_JOURNAL: empty },
      ["--stdin"],
      payload({ OXIDE_ALLOWLIST_ADD: NEWCOMER, OXIDE_ALLOWLIST_INDEX: "random", OXIDE_ALLOWLIST_INITIAL: "1" }),
    );
    expect(initial.status).toBe(0);
    expect(JSON.parse(initial.stdout)).toHaveLength(2);

    // The secrets must not also be in the environment, and nothing else goes in argv.
    const both = run(env(journal), ["--stdin"], payload({ OXIDE_ALLOWLIST_REVOKE: MEMBER }));
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("must not be set in the environment");
    const mixed = run(base, ["--stdin", "--revoke", MEMBER], payload({}));
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain("--stdin takes no other argument");
    expect(mixed.stderr).not.toContain(MEMBER.slice(2));
    // An unknown key is refused by name; a malformed line by number; never by value.
    const unknown = run(base, ["--stdin"], payload({ OXIDE_ALLOWLIST_REVOKE: MEMBER, SOMETHING_ELSE: NEWCOMER }));
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("names an unknown key");
    expect(unknown.stderr).not.toContain(NEWCOMER.slice(2));
  });

  it("never echoes an argument it did not understand, and requires the sending account", async () => {
    const current = await OxideAllowlist.build(SEED, CURRENT);
    const journal = journalAttesting(current.root);
    const stray = run(env(journal), ["--revoke", MEMBER, NEWCOMER]);
    expect(stray.status).toBe(1);
    expect(stray.stderr).toContain("unrecognised arguments");
    expect(stray.stderr).not.toContain(NEWCOMER.slice(2));
    expect(stray.stderr).not.toContain(MEMBER.slice(2));
    const withoutSender = env(journal);
    delete withoutSender["PXE_BRIDGE_ACCOUNT_ADDRESS"];
    const r = run(withoutSender, ["--revoke", MEMBER]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PXE_BRIDGE_ACCOUNT_ADDRESS is required");
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
    expect(run(env(journal), ["--add", NEWCOMER]).stderr).toContain("an index of <n> or random");
    expect(run(env(journal), ["--add", NEWCOMER, "--index", "3"]).stderr).toContain("slot is already occupied");
    expect(run(env(journal), ["--add", MEMBER, "--index", "9"]).stderr).toContain("already in the set");
    expect(run(env(journal), ["--revoke", NEWCOMER]).stderr).toContain("not in the current set");
    expect(
      run({ ...env(journal), PXE_BRIDGE_ACCOUNT_ADDRESS: NEWCOMER }, ["--add", NEWCOMER, "--index", "9"]).stderr,
    ).toContain("sending account");
  });
});
