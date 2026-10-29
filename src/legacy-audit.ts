import { readFileSync } from "node:fs";

/**
 * The pre-journal audit log as an ADOPTION gate (decision D-B, 2026-10-27).
 *
 * Before #45 the JSON-lines audit log (`PXE_BRIDGE_AUDIT_LOG`) was the
 * recovery store: the 24h rolling window and the idempotency keys were
 * replayed from it. A journal adopted beside an account that log describes
 * forgets both, so adoption is refused while the log still says either:
 *
 * - an UNRESOLVED key: an `idempotencyKey` whose last legacy line is
 *   `submitting` (a crash between send and record) or `unknown` (may have
 *   moved funds), at any age. Last line wins per key, as the legacy replay
 *   read it, so appending a line with the reconciled status (`success` when
 *   the transfer landed, `error` when it provably did not) resolves the key;
 * - a SPEND inside the last 24h: any legacy line `success`, `unknown` or
 *   `submitting`, keyed or not, timestamped within 24h of now. A reconciled
 *   `success` line is a spend at its own timestamp, so it holds adoption for
 *   another 24h -- the window the old bridge would have enforced.
 *
 * Legacy lines are the ones carrying `status`; the journal-era output lines
 * carry `observation` instead and are ignored. A legacy-looking line that does
 * not parse, or whose timestamp does not, refuses adoption: it cannot be
 * placed in the window, and a torn last line is exactly the crash case.
 *
 * Read only at adoption, synchronously: this is a startup gate, not a store.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Legacy statuses that leave a key unresolved, and those that spent. */
const UNRESOLVED: Record<string, true> = { submitting: true, unknown: true };
const SPENT: Record<string, true> = { success: true, unknown: true, submitting: true };

/** Why the legacy log at `path` forbids adoption, or undefined when it does not. */
export function legacyAuditRefusal(path: string, nowMs: number): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `legacy audit log ${path} is unreadable: ${(cause as Error).message}`;
  }

  const lastStatusByKey = new Map<string, string>();
  let unplaceable = 0;
  let recentSpends = 0;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A journal-era line is complete JSON, so an unparseable line is a torn
      // or foreign line, and either could be a legacy outcome.
      unplaceable += 1;
      continue;
    }
    if (typeof entry !== "object" || entry === null || !("status" in entry)) continue;
    const status = typeof entry.status === "string" ? entry.status : "";
    const timestamp =
      "timestamp" in entry && typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (Number.isNaN(timestamp)) {
      unplaceable += 1;
      continue;
    }
    if ("idempotencyKey" in entry && typeof entry.idempotencyKey === "string") {
      lastStatusByKey.set(entry.idempotencyKey, status);
    }
    if (Object.hasOwn(SPENT, status) && timestamp >= nowMs - DAY_MS) recentSpends += 1;
  }

  const unresolved = [...lastStatusByKey]
    .filter(([, status]) => Object.hasOwn(UNRESOLVED, status))
    .map(([key]) => key);
  const reasons: string[] = [];
  if (unresolved.length > 0) {
    reasons.push(
      `${unresolved.length} unresolved key(s) (${unresolved.slice(0, 5).join(", ")}` +
        `${unresolved.length > 5 ? ", ..." : ""})`,
    );
  }
  if (recentSpends > 0) reasons.push(`${recentSpends} spend(s) inside the last 24h`);
  if (unplaceable > 0) reasons.push(`${unplaceable} line(s) that cannot be placed`);
  if (reasons.length === 0) return undefined;
  return (
    `legacy audit log ${path} holds ${reasons.join(", ")}; drain and reconcile it ` +
    "(docs/settlement-operations.md, \"Legacy drain and adoption\") before adopting"
  );
}
