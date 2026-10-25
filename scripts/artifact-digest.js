/**
 * Computes the spending-limit artifact's digest of record, and optionally
 * checks it against a committed value (ARTIFACT_SHA256).
 *
 * The class ID (contract-class-id.js) covers bytecode and verification keys
 * but not the whole file: the ABI, the storage layout and other metadata can
 * change without moving it, and the bridge encodes against the ABI and reads
 * storage slots from the layout. So the artifact is pinned byte for byte too.
 *
 * Not a plain `sha256sum` of the file: `file_map` records every source file
 * under its ABSOLUTE build path (the checkout directory and nargo's dependency
 * cache under $HOME). An x86 container build and a native arm64 build of the
 * same commit produced identical nargo output except for those paths
 * (2026-10-25), so a raw file hash pins the runner's directory layout as much
 * as the contract. The digest is sha256 over the artifact as written, with each
 * `file_map` path cut to the part below the checkout (`contracts/...`) or below
 * the nargo cache (`nargo/...`). Sources, bytecode, ABI, layout and VKs are all
 * still covered.
 *
 * Plain JS, no build step, no SDK import.
 *
 *   node scripts/artifact-digest.js                 # print
 *   node scripts/artifact-digest.js --check <file>  # compare, exit 1 on drift
 *   node scripts/artifact-digest.js <artifact.json> # print for another file
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DEFAULT_ARTIFACT =
  "contracts/spending_limit_account/target/spending_limit_account_contract-SpendingLimitAccount.json";

const args = process.argv.slice(2);
const checkIndex = args.indexOf("--check");
const pinPath = checkIndex === -1 ? null : args[checkIndex + 1];
const artifactPath =
  args.find((a, i) => !a.startsWith("--") && (checkIndex === -1 || i !== checkIndex + 1)) ??
  DEFAULT_ARTIFACT;

let bytes;
try {
  bytes = readFileSync(artifactPath, "utf8");
} catch (err) {
  console.error(`Could not read ${artifactPath}: ${err.message}`);
  process.exit(1);
}

const artifact = JSON.parse(bytes);
for (const entry of Object.values(artifact.file_map ?? {})) {
  const path = String(entry.path);
  const contracts = path.lastIndexOf("/contracts/spending_limit_account/");
  const nargo = path.lastIndexOf("/nargo/");
  if (contracts !== -1) entry.path = path.slice(contracts + 1);
  else if (nargo !== -1) entry.path = path.slice(nargo + 1);
  // The noir stdlib is recorded relative (`std/...`) and needs no cut.
  else if (path.startsWith("/")) {
    console.error(`file_map path ${path} is under neither the checkout nor the nargo cache`);
    process.exit(1);
  }
}

const digest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
const fileSha = createHash("sha256").update(bytes).digest("hex");
console.log(`artifact digest (paths normalised): ${digest}`);
console.log(`raw file sha256 (path-dependent):   ${fileSha}`);

if (!pinPath) process.exit(0);

const pinned = readFileSync(pinPath, "utf8").trim();
if (pinned !== digest) {
  console.error("::error::Contract artifact digest changed.");
  console.error(`  pinned:   ${pinned}`);
  console.error(`  computed: ${digest}`);
  console.error(`Update ${pinPath} only with a deliberate contract or toolchain change, from the`);
  console.error("x86 `contract` CI job's build.");
  process.exit(1);
}
console.log(`artifact digest matches ${pinPath}`);
