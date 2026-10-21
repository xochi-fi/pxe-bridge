/**
 * The verifier's wire format, parsed strictly so that each value has exactly
 * one accepted spelling:
 *
 *   publicKey.x, publicKey.y, messageField, digest: 0x + exactly 64 hex digits
 *   signature: 0x + exactly 128 hex digits (64 bytes, s || e)
 *   exactly one of digest (reduced by digestToField) or messageField
 *
 * Anything else throws MalformedRequest; the Worker answers 400. Range checks
 * (coordinates, message and e < r, s < n) are the verifier's, which returns
 * false. Shared by worker.ts (workerd) and cases.ts (Node), so both run the
 * same parse.
 */
import { digestToField, type GrumpkinPoint } from "./schnorr-grumpkin.js";

export class MalformedRequest extends Error {}

const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
const HEX_64_BYTES = /^0x[0-9a-fA-F]{128}$/;

export interface ParsedRequest {
  publicKey: GrumpkinPoint;
  message: bigint;
  signature: Uint8Array;
}

/** A string at `path` in untrusted JSON, or undefined. */
function stringAt(value: unknown, ...path: string[]): string | undefined {
  let v = value;
  for (const key of path) v = v !== null && typeof v === "object" ? Reflect.get(v, key) : undefined;
  return typeof v === "string" ? v : undefined;
}

function hexArg(name: string, value: string | undefined, pattern: RegExp): string {
  if (value === undefined || !pattern.test(value)) {
    throw new MalformedRequest(`${name} must match ${pattern.source}`);
  }
  return value;
}

/** Only called on strings that matched one of the patterns above. */
function bytes(hex: string): Uint8Array {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

export function parseRequest(body: unknown): ParsedRequest {
  const x = hexArg("publicKey.x", stringAt(body, "publicKey", "x"), HEX_32_BYTES);
  const y = hexArg("publicKey.y", stringAt(body, "publicKey", "y"), HEX_32_BYTES);
  const signature = hexArg("signature", stringAt(body, "signature"), HEX_64_BYTES);
  const digest = stringAt(body, "digest");
  const field = stringAt(body, "messageField");
  if ((digest === undefined) === (field === undefined)) {
    throw new MalformedRequest("exactly one of digest or messageField is required");
  }
  const message =
    digest !== undefined
      ? digestToField(bytes(hexArg("digest", digest, HEX_32_BYTES)))
      : BigInt(hexArg("messageField", field, HEX_32_BYTES));
  return { publicKey: { x: BigInt(x), y: BigInt(y) }, message, signature: bytes(signature) };
}
