/**
 * Minimal Cloudflare Worker around the standalone verifier, used only to
 * measure the bundle and to run the verifier inside workerd.
 *
 * POST { publicKey: { x, y }, digest: "0x..32 bytes" | messageField: "0x..", signature: "0x..64 bytes" }
 *   -> { valid: boolean, messageField }
 */
import { digestToField, verifySchnorrGrumpkin } from "./schnorr-grumpkin.js";

/** A string at `path` in untrusted JSON, or undefined. */
function stringAt(value: unknown, ...path: string[]): string | undefined {
  let v = value;
  for (const key of path) v = v !== null && typeof v === "object" ? Reflect.get(v, key) : undefined;
  return typeof v === "string" ? v : undefined;
}

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from((hex.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));

export default {
  async fetch(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    const x = stringAt(body, "publicKey", "x");
    const y = stringAt(body, "publicKey", "y");
    const signature = stringAt(body, "signature");
    const digest = stringAt(body, "digest");
    const field = stringAt(body, "messageField");
    if (!x || !y || !signature || (!digest && !field)) {
      return Response.json({ error: "bad request" }, { status: 400 });
    }
    const message = digest ? digestToField(hexToBytes(digest)) : BigInt(field!);
    const valid = verifySchnorrGrumpkin({ x: BigInt(x), y: BigInt(y) }, message, hexToBytes(signature));
    return Response.json({ valid, messageField: `0x${message.toString(16).padStart(64, "0")}` });
  },
};
