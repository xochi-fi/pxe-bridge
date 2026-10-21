/**
 * Posts every case in cases.ts to verifier/worker.ts running in workerd
 * (`wrangler dev` in this directory). Each verdict must equal the case's
 * `expect`: 200 { valid } for valid/invalid, 400 for malformed; any other
 * status fails. On 200 the Worker's messageField must equal the Node parse of
 * the same body. Each request is aborted after REQUEST_TIMEOUT_MS.
 *
 *   npx tsx spike/633-recipient-schnorr/verifier/workerd-check.ts [http://127.0.0.1:8799]
 */
import { z } from "zod";

import { readPublic } from "../common.js";
import { buildCases, type Verdict } from "./cases.js";
import { parseRequest } from "./request.js";

const REQUEST_TIMEOUT_MS = 10_000;
const url = process.argv[2] ?? "http://127.0.0.1:8799";
const Verified = z.object({ valid: z.boolean(), messageField: z.string() });

let ok = true;
const cases = buildCases(readPublic());
for (const c of cases) {
  const res = await fetch(url, {
    method: "POST",
    body: JSON.stringify(c.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let verdict: Verdict | `HTTP ${number}`;
  let detail = "";
  let fieldMatches = true;
  if (res.status === 400) {
    verdict = "malformed";
    detail = z.object({ error: z.string() }).parse(await res.json()).error;
  } else if (res.status === 200) {
    const out = Verified.parse(await res.json());
    verdict = out.valid ? "valid" : "invalid";
    fieldMatches = BigInt(out.messageField) === parseRequest(c.body).message;
    detail = `field=${out.messageField}${fieldMatches ? "" : " (differs from the Node parse)"}`;
  } else {
    verdict = `HTTP ${res.status}`;
    detail = await res.text();
  }
  const pass = verdict === c.expect && fieldMatches;
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} workerd case ${c.label}: ${verdict} (expect ${c.expect}) ${detail}`);
}
console.log(`${cases.length} cases`);
process.exit(ok ? 0 : 1);
