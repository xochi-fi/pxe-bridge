/**
 * Adds or revokes ONE recipient in the Oxide sender's PRIVATE allowlist
 * (xochi-fi/xochi#751, decided as xochi#775 option a).
 *
 * The Oxide allowlist has no on-chain root and no admin transaction: the set
 * lives only in the bridge's secret environment, and the bridge signs
 * Membership and RootUpdate readiness records over its root. So this script
 * changes nothing by itself. It checks the change, then prints the next
 * owner-only recipients-file content, and ONLY that JSON, on stdout, so it
 * can be piped straight into the secret store. Every other line goes to
 * stderr, and none of them names a recipient, a position, the set's size or
 * its root: keep stdout out of shell history, logs and tickets.
 *
 * Two ways to supply the secrets and the change:
 *
 *   npm run -s oxide-allowlist -- --add 0x<address> --index <n>|random [--initial]
 *   npm run -s oxide-allowlist -- --revoke 0x<address>
 *     with PXE_BRIDGE_OXIDE_ALLOWLIST_SEED and _RECIPIENTS in the environment
 *     (development: both reach any child process and `ps e`).
 *
 *   npm run -s oxide-allowlist -- --stdin
 *     everything on stdin as KEY=VALUE lines (production, docs "G1"): the two
 *     secrets plus the change, so neither the set nor the address being
 *     added or revoked is ever a command-line argument (visible to `ps`,
 *     shell history, auditd and the Docker daemon's saved container config)
 *     or a container environment variable (`docker inspect`,
 *     /var/lib/docker/containers/<id>/config.v2.json):
 *       PXE_BRIDGE_OXIDE_ALLOWLIST_SEED=0x<64 hex>
 *       PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS=[{"address":"0x..","index":n},...]
 *       OXIDE_ALLOWLIST_ADD=0x<address>      with OXIDE_ALLOWLIST_INDEX=<n>|random
 *       OXIDE_ALLOWLIST_REVOKE=0x<address>
 *       OXIDE_ALLOWLIST_INITIAL=1            (optional)
 *     With --stdin the two secret variables must NOT be in the environment
 *     and no other argument is accepted.
 *
 * Required env (not secret):
 *   PXE_BRIDGE_JOURNAL           -- the bridge's settlement journal, opened read-only
 *   PXE_BRIDGE_ACCOUNT_ADDRESS   -- the Oxide sending account, which is never admitted
 *
 * Refuses unless the configured set reproduces the root the bridge last
 * signed a RootUpdate for (the journal's newest outbox entry), the mirror of
 * update-allowlist's check against the account's on-chain root: a stale set
 * would silently drop or restore recipients. `--initial` is accepted only
 * while the journal holds no RootUpdate yet (before the first attested start).
 *
 * Choose `random` (or a random free position): positions are part of the
 * commitment, and filling left to right would make a later root change read
 * as an addition to anyone who ever held an earlier set.
 *
 * Applying: run this with the bridge STOPPED (its journal holds an exclusive
 * lock while it runs), store the printed JSON in the secret that is mounted
 * at `PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS_FILE`, and start the bridge. It
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
import { readFileSync } from "node:fs";
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
const SEED_ENV = "PXE_BRIDGE_OXIDE_ALLOWLIST_SEED";
const RECIPIENTS_ENV = "PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS";
const PAYLOAD_KEYS = [
  SEED_ENV,
  RECIPIENTS_ENV,
  "OXIDE_ALLOWLIST_ADD",
  "OXIDE_ALLOWLIST_REVOKE",
  "OXIDE_ALLOWLIST_INDEX",
  "OXIDE_ALLOWLIST_INITIAL",
] as const;
type PayloadKey = (typeof PAYLOAD_KEYS)[number];

function fail(message: string): never {
  throw new Error(message);
}

/** What the script was asked, before the secrets are read: the change, or `--stdin`. */
interface Request {
  add?: string | undefined;
  revoke?: string | undefined;
  index?: string | undefined;
  initial: boolean;
}

/**
 * The command line. A parse error is reported with a fixed message: node's
 * own names the offending argument, which may be an address.
 */
function parseCommandLine(argv: readonly string[]): { stdin: boolean; request: Request } {
  let values: { add?: string; revoke?: string; index?: string; initial?: boolean; stdin?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        add: { type: "string" },
        revoke: { type: "string" },
        index: { type: "string" },
        initial: { type: "boolean", default: false },
        stdin: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    fail(
      "unrecognised arguments. Usage: --add 0x<address> --index <n>|random [--initial] | --revoke 0x<address> | --stdin",
    );
  }
  if (values.stdin === true) {
    if (values.add !== undefined || values.revoke !== undefined || values.index !== undefined || values.initial === true) {
      fail("--stdin takes no other argument: the change travels in the payload");
    }
    return { stdin: true, request: { initial: false } };
  }
  return {
    stdin: false,
    request: { add: values.add, revoke: values.revoke, index: values.index, initial: values.initial === true },
  };
}

/** KEY=VALUE lines from stdin; unknown keys and repeated keys are refused by name, never by value. */
function readPayload(): Partial<Record<PayloadKey, string>> {
  let text: string;
  try {
    text = readFileSync(0, "utf8");
  } catch {
    fail("--stdin: the payload could not be read from stdin");
  }
  const payload: Partial<Record<PayloadKey, string>> = {};
  for (const [n, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) fail(`--stdin: line ${n + 1} is not KEY=VALUE`);
    const key = line.slice(0, eq).trim();
    if (!(PAYLOAD_KEYS as readonly string[]).includes(key)) fail(`--stdin: line ${n + 1} names an unknown key`);
    if (payload[key as PayloadKey] !== undefined) fail(`--stdin: ${key} is given twice`);
    payload[key as PayloadKey] = line.slice(eq + 1).trim();
  }
  return payload;
}

function parseChange(request: Request, current: readonly AllowlistRecipient[]): OxideAllowlistChange {
  if (request.revoke !== undefined) {
    if (request.add !== undefined) fail("pass exactly one of add or revoke");
    if (request.index !== undefined) fail("revoke takes no index: the position is the listed one");
    return { mode: "revoke", address: request.revoke };
  }
  if (request.add === undefined) fail("pass exactly one of add (with an index of <n> or random) or revoke");
  const free = freeOxidePositions(current);
  let index: number | undefined;
  if (request.index === "random") {
    index = free[randomInt(Math.max(free.length, 1))];
    if (index === undefined) fail("every position is occupied; revoke a recipient first");
  } else if (request.index !== undefined && /^(?:0|[1-9]\d*)$/.test(request.index)) {
    index = Number(request.index);
  } else {
    fail(
      "add needs an index of <n> or random. Choose a RANDOM free position, not the lowest: " +
        "filling left to right makes a later root change readable as an addition.",
    );
  }
  return { mode: "add", address: request.add, index };
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
  const { stdin, request: argRequest } = parseCommandLine(process.argv.slice(2));
  let seed: string | undefined;
  let raw: string | undefined;
  let request = argRequest;
  if (stdin) {
    // The secrets must not ALSO be in the environment: that is the leak the payload avoids.
    if (process.env[SEED_ENV] !== undefined || process.env[RECIPIENTS_ENV] !== undefined) {
      fail(`--stdin: ${SEED_ENV} and ${RECIPIENTS_ENV} must not be set in the environment`);
    }
    const payload = readPayload();
    seed = payload[SEED_ENV];
    raw = payload[RECIPIENTS_ENV];
    const initial = payload.OXIDE_ALLOWLIST_INITIAL;
    if (initial !== undefined && initial !== "1") fail("--stdin: OXIDE_ALLOWLIST_INITIAL must be 1 when given");
    request = {
      add: payload.OXIDE_ALLOWLIST_ADD,
      revoke: payload.OXIDE_ALLOWLIST_REVOKE,
      index: payload.OXIDE_ALLOWLIST_INDEX,
      initial: initial === "1",
    };
  } else {
    seed = takeSecretEnv(SEED_ENV);
    raw = takeSecretEnv(RECIPIENTS_ENV);
  }
  seed = seed?.trim();
  if (!seed) fail(`${SEED_ENV} is required`);
  if (!raw) fail(`${RECIPIENTS_ENV} is required ("[]" for an empty set)`);
  const journalPath = requiredEnv("PXE_BRIDGE_JOURNAL");
  // Required, not optional: without it the "never the sending account" check
  // would be skipped silently.
  const sender = requiredEnv("PXE_BRIDGE_ACCOUNT_ADDRESS");

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail(`${RECIPIENTS_ENV} is not valid JSON`);
  }
  const current = validateOxideRecipients(json);
  const change = parseChange(request, current);

  const before = await OxideAllowlist.build(seed, current);
  const attested = lastAttestedRoot(journalPath);
  if (attested === undefined && !request.initial) {
    fail(
      "the journal holds no RootUpdate yet, so the running set cannot be confirmed. Pass --initial " +
        "(OXIDE_ALLOWLIST_INITIAL=1) only before the bridge's first attested Oxide-mode start.",
    );
  }
  if (attested !== undefined && request.initial) {
    fail("--initial is refused: the bridge has already attested a root");
  }
  if (attested !== undefined && attested !== before.root) {
    fail(
      `the configured ${SEED_ENV} and ${RECIPIENTS_ENV} do ` +
        "not build the root of the bridge's newest RootUpdate. Either this is not the set the bridge " +
        "runs, or the bridge has not published a RootUpdate for its current set yet (after a " +
        "restart it waits for the next finalized block: audit reason finalized_tip_not_advanced). " +
        "Start the bridge on its current set, wait until it publishes, stop it, then retry.",
    );
  }

  const next = planOxideAllowlistChange(current, change, sender);
  const after = await OxideAllowlist.build(seed, next);
  // Neither the position nor the set's size: both describe the private set.
  console.error(`${TAG} ${change.mode}: checked against the bridge's newest RootUpdate`);
  console.error(`${TAG} root changes: ${after.root !== before.root ? "yes" : "NO"}`);
  console.error(
    `${TAG} stdout is the next owner-only recipients-file content. It is SECRET: ` +
      "store it only in the bridge's secret store, then restart the bridge.",
  );
  process.stdout.write(`${JSON.stringify(next)}\n`);
  return 0;
}

runScript(TAG, main);
