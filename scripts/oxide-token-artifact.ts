/**
 * Refuses an OxideToken artifact unless its contract class is the deployed
 * OXDAI class (`OXIDE_V6_MAINNET.oxideTokenClassId`). The check is the
 * sender's own load gate, `loadOxideTokenArtifact`, so what passes here is
 * exactly what the sender will register.
 *
 *   npm run check:oxide-token                  # the artifact build:oxide-token writes
 *   npm run check:oxide-token -- <artifact>    # another file
 *
 * Exit 1 when the file is missing, untranspiled, or of another class.
 */
import { readFileSync } from "node:fs";
import { loadOxideTokenArtifact, OXIDE_TOKEN_ARTIFACT } from "../src/oxide/backend.js";
import { OXIDE_V6_MAINNET } from "../src/oxide/pins.js";

const path = process.argv[2] ?? OXIDE_TOKEN_ARTIFACT;

let raw: { transpiled?: boolean; aztec_version?: string; noir_version?: string };
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`Could not read ${path}: ${(err as Error).message}`);
  console.error("Build it with `npm run build:oxide-token` (aztec-up 6.0.0 on PATH).");
  process.exit(1);
}
// Plain nargo emits an untranspiled artifact; only `aztec compile` gives the deployed class.
if (raw.transpiled !== true) {
  console.error(`${path} is not transpiled: built with nargo instead of \`aztec compile\`?`);
  process.exit(1);
}
console.log(`aztec ${raw.aztec_version ?? "?"} / noir ${raw.noir_version ?? "?"}`);

try {
  await loadOxideTokenArtifact(path);
} catch (err) {
  console.error(`::error::${(err as Error).message}`);
  process.exit(1);
}
console.log(`OxideToken class ${OXIDE_V6_MAINNET.oxideTokenClassId}: matches the deployed OXDAI class`);
