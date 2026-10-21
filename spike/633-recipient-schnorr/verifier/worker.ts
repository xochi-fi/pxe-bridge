/**
 * Minimal Cloudflare Worker around the standalone verifier, used only to
 * measure the bundle and to run the verifier inside workerd.
 *
 * POST { publicKey: { x, y }, digest | messageField, signature } (encodings: request.ts)
 *   -> 200 { valid: boolean, messageField }, or 400 { error } for any malformed body
 */
import { MalformedRequest, parseRequest, type ParsedRequest } from "./request.js";
import { verifySchnorrGrumpkin } from "./schnorr-grumpkin.js";

export default {
  async fetch(request: Request): Promise<Response> {
    let parsed: ParsedRequest;
    try {
      parsed = parseRequest(await request.json());
    } catch (err) {
      if (err instanceof MalformedRequest || err instanceof SyntaxError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
    const { publicKey, message, signature } = parsed;
    return Response.json({
      valid: verifySchnorrGrumpkin(publicKey, message, signature),
      messageField: `0x${message.toString(16).padStart(64, "0")}`,
    });
  },
};
