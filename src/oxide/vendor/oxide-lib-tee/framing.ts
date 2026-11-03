// Length-prefixed framing for vsock RPC. Wire: [4-byte BE length][JSON payload].
// Ported verbatim from ~/nitro-enclave/packages/common/src/vsock.ts (uses Buffer here).

// Sized to admit the largest legal signTokenOperation — 64 spends whose tx effect hints each carry the maximum
// 1166 fields (~5.7 MB of JSON, ~7.9 MB sealed + base64) — with headroom.
export const MAX_MESSAGE_SIZE = 9 * 1024 * 1024;

export function frame(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > MAX_MESSAGE_SIZE) {
    throw new Error(`message too large: ${body.length} > ${MAX_MESSAGE_SIZE}`);
  }
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** Streaming reader that accumulates chunks and yields complete framed payloads. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private total = 0;

  push(chunk: Buffer): Buffer[] {
    this.chunks.push(chunk);
    this.total += chunk.length;
    const out: Buffer[] = [];
    while (this.total >= 4) {
      const len = this.header().readUInt32BE(0);
      if (len > MAX_MESSAGE_SIZE) {
        throw new Error(`message too large: ${len} > ${MAX_MESSAGE_SIZE}`);
      }
      if (this.total < 4 + len) {
        break;
      }
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      out.push(all.subarray(4, 4 + len));
      const rest = all.subarray(4 + len);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.total = rest.length;
    }
    return out;
  }

  /** First 4 buffered bytes; collapses leading chunks only when the prefix spans them. */
  private header(): Buffer {
    if (this.chunks[0].length < 4) {
      this.chunks = [Buffer.concat(this.chunks)];
    }
    return this.chunks[0];
  }
}
