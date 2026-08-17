import { appendFile, open, readFile } from "node:fs/promises";

export interface AuditEntry {
  timestamp: string;
  method: string;
  recipient: string;
  token: string;
  amount: string;
  chainId: number;
  tradeId?: string | undefined;
  clientIp: string;
  status: "success" | "rejected" | "error";
  txHash?: string | undefined;
  error?: string | undefined;
}

const AUDIT_PREFIX = "[audit] ";

export interface RecordedSpend {
  amount: bigint;
  timestamp: number;
}

/**
 * Replays successful spends from a JSON-lines audit log, newest window first.
 *
 * This is what lets `TransactionLimits` survive a restart. The log is already
 * the authoritative record of what the bridge moved, so rehydrating from it
 * needs a reader rather than a second store that could disagree with it.
 *
 * Tolerant by design: a truncated final line (killed mid-append) or an entry
 * from an older schema is skipped, not fatal. Refusing to boot over a corrupt
 * log would turn an observability problem into an outage.
 */
export async function readRecentSpends(
  logPath: string,
  sinceMs: number,
): Promise<RecordedSpend[]> {
  let contents: string;
  try {
    contents = await readFile(logPath, "utf8");
  } catch (err) {
    // A missing log is the normal first-boot case.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const spends: RecordedSpend[] = [];
  let skipped = 0;

  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;

    let entry: Partial<AuditEntry>;
    try {
      entry = JSON.parse(line) as Partial<AuditEntry>;
    } catch {
      skipped++;
      continue;
    }

    if (entry.status !== "success" || typeof entry.amount !== "string") continue;

    const timestamp = Date.parse(entry.timestamp ?? "");
    if (Number.isNaN(timestamp) || timestamp < sinceMs) continue;

    try {
      spends.push({ amount: BigInt(entry.amount), timestamp });
    } catch {
      skipped++;
    }
  }

  if (skipped > 0) {
    console.warn(`[pxe-bridge] Audit log: skipped ${skipped} unparseable line(s)`);
  }
  return spends;
}

export class AuditLogger {
  private fileInitialized = false;

  constructor(private readonly logPath?: string) {}

  async log(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry);

    if (this.logPath) {
      if (!this.fileInitialized) {
        const fh = await open(this.logPath, "a", 0o600);
        await fh.close();
        this.fileInitialized = true;
      }
      await appendFile(this.logPath, line + "\n");
    } else {
      process.stdout.write(AUDIT_PREFIX + line + "\n");
    }
  }
}
