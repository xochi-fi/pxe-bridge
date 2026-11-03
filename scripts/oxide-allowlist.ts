/**
 * Adds or revokes ONE recipient in the Oxide sender's PRIVATE allowlist
 * (xochi-fi/xochi#751, decided as xochi#775 option a).
 *
 * The Oxide allowlist has no on-chain root and no admin transaction: the set
 * lives only in the bridge's secret environment, and the bridge signs
 * Membership and RootUpdate readiness records over its root. So this script
 * changes nothing by itself. It checks the change, then prints the next
 * PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS value, and ONLY that value, on
 * stdout, so it can be piped straight into the secret store. Every other line
 * goes to stderr. Neither the set nor its root is ever printed elsewhere: keep
 * stdout out of shell history, logs and tickets.
 *
 * Usage:
 *   npm run -s oxide-allowlist -- --add 0x<address> --index <n>|random [--initial]
 *   npm run -s oxide-allowlist -- --revoke 0x<address>
 *
 * Required env:
 *   PXE_BRIDGE_OXIDE_ALLOWLIST_SEED        -- the seed every leaf salt derives from
 *   PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS  -- the CURRENT set, as the bridge runs it
 *   PXE_BRIDGE_JOURNAL                     -- the bridge's settlement journal, opened read-only
 *
 * Optional env:
 *   PXE_BRIDGE_ACCOUNT_ADDRESS  -- the Oxide sending account, which is never admitted
 *
 * Refuses unless the configured set reproduces the root the bridge last
 * signed a RootUpdate for (the journal's newest outbox entry), the mirror of
 * update-allowlist's check against the account's on-chain root: a stale set
 * would silently drop or restore recipients. `--initial` is accepted only
 * while the journal holds no RootUpdate yet (before the first attested start).
 *
 * Choose `--index random` (or a random free position): positions are part of
 * the commitment, and filling left to right would make a later root change
 * read as an addition to anyone who ever held an earlier set.
 *
 * Applying: run this with the bridge STOPPED (its journal holds an exclusive
 * lock while it runs, so the check below cannot read it), store the printed
 * value as PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS, and start the bridge. It
 * publishes the new root's RootUpdate from the first finalized block above
 * the previous one, and the Worker marks an approved binding ready on its
 * next refresh.
 *
 * REVOKING: a fresh send to a revoked recipient is refused PERMANENTLY
 * (`recipient_not_allowlisted`), including an order whose source funds
 * Riddler already pulled. So before revoking, close Riddler intake for the
 * recipient and drain every obligation to it that has not yet reached
 * createNote (paid, or refunded on its own path); only then run --revoke and
 * restart. A prepared attempt already journaled still resends; one whose
 * bytes lapse and needs a fresh attempt is refused like any new send.
 */

import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import type { AllowlistRecipient } from "../src/allowlist-tree.js";
import {
  OxideAllowlist,
  freeOxidePositions,
  planOxideAllowlistChange,
  validateOxideRecipients,
  type OxideAllowlistChange,
} from "../src/oxide/allowlist.js";
import { requiredEnv, runScript, takeSecretEnv } from "./spending-limit-admin.js";

const TAG = "[oxide-allowlist]";

function fail(message: string): never {
  throw new Error(message);
}

function parseChange(argv: readonly string[], current: readonly AllowlistRecipient[]): {
  change: OxideAllowlistChange;
  initial: boolean;
} {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      add: { type: "string" },
      revoke: { type: "string" },
      index: { type: "string" },
      initial: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.revoke !== undefined) {
    if (values.add !== undefined) fail("pass exactly one of --add or --revoke");
    if (values.index !== undefined) fail("--revoke takes no --index: the position is the listed one");
    return { change: { mode: "revoke", address: values.revoke }, initial: values.initial };
  }
  if (values.add === undefined) {
    fail("pass exactly one of --add <address> --index <n>|random or --revoke <address>");
  }
  const free = freeOxidePositions(current);
  let index: number | undefined;
  if (values.index === "random") {
    index = free[randomInt(Math.max(free.length, 1))];
    if (index === undefined) fail("every position is occupied; revoke a recipient first");
  } else if (values.index !== undefined && /^(?:0|[1-9]\d*)$/.test(values.index)) {
    index = Number(values.index);
  } else {
    fail(
      "--add needs --index <n> or --index random. Choose a RANDOM free position, not the lowest: " +
        "filling left to right makes a later root change readable as an addition.",
    );
  }
  return { change: { mode: "add", address: values.add, index }, initial: values.initial };
}

/** The root of the newest RootUpdate the bridge enqueued, or undefined before the first. */
function lastAttestedRoot(journalPath: string): string | undefined {
  try {
    const db = new Database(journalPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT root FROM root_update_outbox ORDER BY rowid DESC LIMIT 1")
        .get() as { root: string } | undefined;
      return row?.root.toLowerCase();
    } finally {
      db.close();
    }
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code === "SQLITE_BUSY") fail("the settlement journal is locked: stop the bridge first");
    throw new Error(`PXE_BRIDGE_JOURNAL could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function main(): Promise<number> {
  const seed = takeSecretEnv("PXE_BRIDGE_OXIDE_ALLOWLIST_SEED");
  if (!seed) fail("PXE_BRIDGE_OXIDE_ALLOWLIST_SEED is required");
  const raw = takeSecretEnv("PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS");
  if (!raw) fail('PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS is required ("[]" for an empty set)');
  const journalPath = requiredEnv("PXE_BRIDGE_JOURNAL");
  const sender = process.env["PXE_BRIDGE_ACCOUNT_ADDRESS"];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS is not valid JSON");
  }
  const current = validateOxideRecipients(json);
  const { change, initial } = parseChange(process.argv.slice(2), current);

  const before = await OxideAllowlist.build(seed, current);
  const attested = lastAttestedRoot(journalPath);
  if (attested === undefined && !initial) {
    fail(
      "the journal holds no RootUpdate yet, so the running set cannot be confirmed. Pass --initial " +
        "only before the bridge's first attested Oxide-mode start.",
    );
  }
  if (attested !== undefined && initial) {
    fail("--initial is refused: the bridge has already attested a root");
  }
  if (attested !== undefined && attested !== before.root) {
    fail(
      "the configured PXE_BRIDGE_OXIDE_ALLOWLIST_SEED and PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS do " +
        "not build the root of the bridge's newest RootUpdate. Either this is not the set the bridge " +
        "runs, or the bridge has not published a RootUpdate for its current set yet (after a " +
        "restart it waits for the next finalized block: audit reason finalized_tip_not_advanced). " +
        "Start the bridge on its current set, wait until it publishes, stop it, then retry.",
    );
  }

  const next = planOxideAllowlistChange(current, change, sender);
  const after = await OxideAllowlist.build(seed, next);
  const position =
    change.mode === "add" ? change.index : current.find((r) => !next.some((n) => n.index === r.index))?.index;
  console.error(`${TAG} ${change.mode} at position ${position}: ${current.length} -> ${next.length} recipient(s)`);
  console.error(`${TAG} root changes: ${after.root !== before.root ? "yes" : "NO"}`);
  console.error(
    `${TAG} stdout is the next PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS. It is SECRET: store it only in ` +
      "the bridge's secret store, then restart the bridge.",
  );
  process.stdout.write(`${JSON.stringify(next)}\n`);
  return 0;
}

runScript(TAG, main);
