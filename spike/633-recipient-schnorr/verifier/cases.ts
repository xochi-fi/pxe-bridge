/**
 * The one case table every verifier runs: run.ts (pure-JS verifier and bb.js,
 * in Node) and workerd-check.ts (the same pure-JS verifier inside workerd).
 * Each case is a Worker request body and its expected verdicts:
 *
 *   expect  the pure-JS verifier's and workerd's verdict: valid | invalid, or
 *           malformed (parseRequest throws in Node; the Worker answers 400)
 *   bb      bb.js's outcome on the same parsed input (through @aztec/foundation's
 *           Schnorr): valid | invalid; { throws } with the error it must raise
 *           when it refuses the input instead of answering; or n/a when the
 *           body is malformed and never parses into anything bb.js could take
 *
 * On every well-formed case bb.js either returns the pure-JS verdict or
 * refuses the input: a coordinate or message >= r is refused by the Fr
 * constructor (FR_REFUSES), s >= n or e >= r by bb.js's own deserializer
 * (BB_REFUSES). It never accepts what the pure-JS verifier rejects.
 *
 * Sources: the Noir library's own pinned vectors (noir-lang/schnorr v0.4.0
 * pinned_vector_small / pinned_vector_large), and the recipient's signatures
 * from public.json, made in its own PXE through the account's auth-witness
 * provider.
 */
import { z } from "zod";

import { FIELD_MODULUS, GRUMPKIN_ORDER, Grumpkin } from "./schnorr-grumpkin.js";

export type Verdict = "valid" | "invalid" | "malformed";
/** @aztec/foundation's Fr constructor: a value >= r is not a field element. */
const FR_REFUSES = { throws: /greater or equal to field modulus/ };
/** bb.js msgpack deserialization of s or e: >= the modulus is non-canonical. */
const BB_REFUSES = { throws: /non-canonical encoding/ };
export type BbOutcome = "valid" | "invalid" | "n/a" | { throws: RegExp };

export interface Case {
  label: string;
  body: Record<string, unknown>;
  expect: Verdict;
  bb: BbOutcome;
}

const h32 = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;
const limbs = (lo: bigint, hi: bigint): bigint => (hi << 128n) | lo;
const sig = (s: bigint, e: bigint): string => `0x${s.toString(16).padStart(64, "0")}${e.toString(16).padStart(64, "0")}`;

const NOIR_SMALL = {
  publicKey: {
    x: h32(0x2c39bbbde2d0ffcb5c4317dcbfa1771cf554a2f33c647446632fa707a5bf5f3fn),
    y: h32(0x2b9c81935298af5ebe22f1a7279bb76781e6cadba3fb6c5c41ed942392dc687cn),
  },
  signature: sig(
    limbs(0x5fd1ac0ad411110674830c54cb506212n, 0x281906862cdb4e0efec7226d757fe803n),
    limbs(0x6c368959f958e525d761d06c47fd2ad6n, 0x013f6a902c6c0efafdadbd4de409690dn),
  ),
  messageField: h32(0x2bcn),
};
const NOIR_LARGE = {
  publicKey: {
    x: h32(0x065812e335a97c2108ea8cf4ccfe2f9dd6b117a0714f5e18461575be93f61da6n),
    y: h32(0x1a915003e8ec534f9a15d926a7ded478e178468ccc4f28e236e67450a55ac622n),
  },
  signature: sig(
    limbs(0xf3bc3b7147acb9c621fd9f72dbf15ffan, 0x08599f379f0301dfefdbd0272554454dn),
    limbs(0x97065383ebbbd76620398792bd259bc2n, 0x2ceaee87f45b7a417f0ffb05451a8c92n),
  ),
  messageField: h32(0x0123456789abcdef0fedcba9876543210123456789abcdef0fedcba987654321n),
};

const hex = z.string().regex(/^0x[0-9a-f]+$/i);
export const PublicSchema = z.object({
  recipientDescriptor: z.object({ constructorArgs: z.tuple([hex, hex]) }),
  recipientSignatures: z.array(z.object({ digest: hex, messageField: hex, signature: hex })).min(2),
});

/** A fixed key that did not sign anything here. */
const other = Grumpkin.BASE.multiply(0x1234567n).toAffine();
const WRONG_KEY = { x: h32(other.x), y: h32(other.y) };

export function buildCases(input: unknown): Case[] {
  const pub = PublicSchema.parse(input);
  const [x, y] = pub.recipientDescriptor.constructorArgs;
  const key = { x, y };
  const cases: Case[] = [
    { label: "noir pinned_vector_small", body: NOIR_SMALL, expect: "valid", bb: "valid" },
    { label: "noir pinned_vector_large", body: NOIR_LARGE, expect: "valid", bb: "valid" },
    { label: "noir pinned_vector_large, message + 1", body: { ...NOIR_LARGE, messageField: h32(BigInt(NOIR_LARGE.messageField) + 1n) }, expect: "invalid", bb: "invalid" },
    { label: "noir pinned_vector_small sig under large key", body: { ...NOIR_SMALL, publicKey: NOIR_LARGE.publicKey }, expect: "invalid", bb: "invalid" },
  ];

  for (const [i, v] of pub.recipientSignatures.entries()) {
    const field = BigInt(v.messageField);
    const s = BigInt(`0x${v.signature.slice(2, 66)}`);
    const e = BigInt(`0x${v.signature.slice(66)}`);
    const flipByte = (at: number): string => {
      const b = Buffer.from(v.signature.slice(2), "hex");
      b[at]! ^= 1;
      return `0x${b.toString("hex")}`;
    };
    const lastDigestByte = parseInt(v.digest.slice(-2), 16) ^ 1;
    const flippedDigest = `${v.digest.slice(0, -2)}${lastDigestByte.toString(16).padStart(2, "0")}`;
    const at = (label: string, body: Record<string, unknown>, expect: Verdict, bb: BbOutcome) =>
      cases.push({ label: `sig[${i}] ${label}`, body, expect, bb });

    at("recipient key, digest", { publicKey: key, digest: v.digest, signature: v.signature }, "valid", "valid");
    at("recipient key, messageField", { publicKey: key, messageField: v.messageField, signature: v.signature }, "valid", "valid");
    at("WRONG key", { publicKey: WRONG_KEY, digest: v.digest, signature: v.signature }, "invalid", "invalid");
    at("WRONG digest (last bit)", { publicKey: key, digest: flippedDigest, signature: v.signature }, "invalid", "invalid");
    at("WRONG messageField (+1)", { publicKey: key, messageField: h32((field + 1n) % FIELD_MODULUS), signature: v.signature }, "invalid", "invalid");
    at("tampered s byte", { publicKey: key, digest: v.digest, signature: flipByte(5) }, "invalid", "invalid");
    at("tampered e byte", { publicKey: key, digest: v.digest, signature: flipByte(40) }, "invalid", "invalid");
    at("off-curve key (x, y + 1)", { publicKey: { x, y: h32((BigInt(y) + 1n) % FIELD_MODULUS) }, digest: v.digest, signature: v.signature }, "invalid", "invalid");
    at("key = point at infinity (0, 0)", { publicKey: { x: h32(0n), y: h32(0n) }, digest: v.digest, signature: v.signature }, "invalid", "invalid");
    at("key x + r (non-canonical coordinate)", { publicKey: { x: h32(BigInt(x) + FIELD_MODULUS), y }, digest: v.digest, signature: v.signature }, "invalid", FR_REFUSES);
    at("s = 0", { publicKey: key, digest: v.digest, signature: sig(0n, e) }, "invalid", "invalid");
    at("e = 0", { publicKey: key, digest: v.digest, signature: sig(s, 0n) }, "invalid", "invalid");
    at("s + n (Grumpkin order)", { publicKey: key, digest: v.digest, signature: sig(s + GRUMPKIN_ORDER, e) }, "invalid", BB_REFUSES);
    at("e + r (field modulus)", { publicKey: key, digest: v.digest, signature: sig(s, e + FIELD_MODULUS) }, "invalid", BB_REFUSES);
    at("messageField + r (>= r, same residue)", { publicKey: key, messageField: h32(field + FIELD_MODULUS), signature: v.signature }, "invalid", FR_REFUSES);
    if (BigInt(v.digest) >= FIELD_MODULUS) {
      at("messageField = unreduced digest (>= r)", { publicKey: key, messageField: v.digest, signature: v.signature }, "invalid", FR_REFUSES);
    }
  }

  const [a, b] = pub.recipientSignatures;
  cases.push({
    label: "sig[0] against sig[1]'s message",
    body: { publicKey: key, messageField: b!.messageField, signature: a!.signature },
    expect: "invalid",
    bb: "invalid",
  });

  // Non-canonical encodings: refused before any verifier runs.
  const good = { publicKey: key, digest: a!.digest, signature: a!.signature };
  const malformed: [string, Record<string, unknown>][] = [
    ["digest with odd trailing nibble (63 hex)", { ...good, digest: a!.digest.slice(0, -1) }],
    ["digest with a non-hex digit", { ...good, digest: `${a!.digest.slice(0, -1)}g` }],
    ["digest 31 bytes", { ...good, digest: a!.digest.slice(0, -2) }],
    ["digest 33 bytes (00 || d)", { ...good, digest: `0x00${a!.digest.slice(2)}` }],
    ["digest without 0x", { ...good, digest: a!.digest.slice(2) }],
    ["signature 127 hex", { ...good, signature: a!.signature.slice(0, -1) }],
    ["signature 65 bytes", { ...good, signature: `${a!.signature}00` }],
    ["signature with a non-hex digit", { ...good, signature: `${a!.signature.slice(0, -1)}z` }],
    ["publicKey.x decimal", { ...good, publicKey: { x: BigInt(x).toString(10), y } }],
    ["publicKey.y 63 hex", { ...good, publicKey: { x, y: `0x${y.slice(3)}` } }],
    ["messageField 31 bytes", { publicKey: key, messageField: a!.messageField.slice(0, -2), signature: a!.signature }],
    ["both digest and messageField", { ...good, messageField: a!.messageField }],
    ["neither digest nor messageField", { publicKey: key, signature: a!.signature }],
  ];
  for (const [label, body] of malformed) {
    cases.push({ label: `malformed: ${label}`, body, expect: "malformed", bb: "n/a" });
  }
  return cases;
}
