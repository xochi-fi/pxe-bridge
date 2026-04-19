import { appendFile } from "node:fs/promises";

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
  constructor(private readonly logPath?: string) {}

  async log(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry);

    if (this.logPath) {
      await appendFile(this.logPath, line + "\n");
    } else {
      process.stdout.write(AUDIT_PREFIX + line + "\n");
    }
  }
}
