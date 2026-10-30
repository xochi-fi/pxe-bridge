import { appendFile, open } from "node:fs/promises";

/**
 * One line of the structured audit log.
 *
 * Output only (decided 2026-10-25). It used to be the durable store the
 * rolling window and idempotency keys were rebuilt from; the settlement
 * journal (journal.ts) is that store now, and nothing reads this file back.
 * A line is written after the journal transition it describes, so a lost line
 * loses a report, never a decision.
 *
 * `observation` is the only settlement fact retained. Recipient, operation,
 * note, transaction, request-origin, token and amount identifiers are excluded
 * because the output can be aggregated outside the shielded trust boundary.
 */
export interface AuditEntry {
  timestamp: string;
  method: string;
  observation: string;
}

const AUDIT_PREFIX = "[audit] ";

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
