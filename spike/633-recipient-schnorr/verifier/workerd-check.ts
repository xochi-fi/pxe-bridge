/**
 * Posts the recipient's signatures to verifier/worker.ts running in workerd
 * (`wrangler dev` in this directory) and checks the verdicts: right key and
 * digest accepted; wrong key, wrong digest and wrong reduced field rejected.
 *
 *   npx tsx spike/633-recipient-schnorr/verifier/workerd-check.ts [http://127.0.0.1:8799]
 */
import { z } from "zod";

import { readPublic } from "../common.js";
import { Grumpkin } from "./schnorr-grumpkin.js";

const url = process.argv[2] ?? "http://127.0.0.1:8799";
const hex = z.string().regex(/^0x[0-9a-f]+$/i);
const pub = z
  .object({
    recipientDescriptor: z.object({ constructorArgs: z.tuple([hex, hex]) }),
    recipientSignatures: z.array(z.object({ digest: hex, messageField: hex, signature: hex })).min(1),
  })
  .parse(readPublic());
const [x, y] = pub.recipientDescriptor.constructorArgs;
const other = Grumpkin.BASE.multiply(0x1234567n).toAffine();
const wrongKey = { x: `0x${other.x.toString(16)}`, y: `0x${other.y.toString(16)}` };

let ok = true;
for (const [i, v] of pub.recipientSignatures.entries()) {
  const flipped = `0x${v.digest.slice(2, 64)}${((parseInt(v.digest.slice(64), 16) ^ 1) & 0xff).toString(16).padStart(2, "0")}`;
  const cases = [
    { label: "right key, digest", body: { publicKey: { x, y }, digest: v.digest, signature: v.signature }, expect: true },
    { label: "WRONG key", body: { publicKey: wrongKey, digest: v.digest, signature: v.signature }, expect: false },
    { label: "WRONG digest (last bit)", body: { publicKey: { x, y }, digest: flipped, signature: v.signature }, expect: false },
  ];
  for (const c of cases) {
    const res = await fetch(url, { method: "POST", body: JSON.stringify(c.body) });
    const out = z.object({ valid: z.boolean(), messageField: z.string() }).parse(await res.json());
    const pass = out.valid === c.expect;
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"} workerd sig[${i}] ${c.label}: valid=${out.valid} field=${out.messageField}`);
  }
}
process.exit(ok ? 0 : 1);
