import { appendFile, open } from "node:fs/promises";

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
