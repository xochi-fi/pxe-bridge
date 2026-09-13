/**
 * Computes the spending-limit account's contract class ID from its compiled
 * artifact, and optionally checks it against a committed value.
 *
 * Why this exists: the artifact is gitignored and rebuilt by CI on every run,
 * from a toolchain fetched by piping a remote installer into bash. The class ID
 * derives from that bytecode and feeds address derivation, so a toolchain
 * change silently moves the account's address. The bridge then sees no contract
 * at the new address, deploys a fresh empty account, logs "Ready", and leaves
 * the balance stranded at the old one. Nothing else in the repo would notice.
 *
 * Plain JS, not TypeScript: it runs from CI with no build step, and tsconfig
 * covers only src/ and tests/.
 *
 *   node scripts/contract-class-id.js                 # print
 *   node scripts/contract-class-id.js --check <file>  # compare, exit 1 on drift
 */
import { readFileSync } from "node:fs";
import { loadContractArtifact } from "@aztec/stdlib/abi";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";

const ARTIFACT =
  "contracts/spending_limit_account/target/spending_limit_account_contract-SpendingLimitAccount.json";

const args = process.argv.slice(2);
const checkIndex = args.indexOf("--check");
const pinPath = checkIndex === -1 ? null : args[checkIndex + 1];

let raw;
try {
  raw = JSON.parse(readFileSync(ARTIFACT, "utf8"));
} catch (err) {
  console.error(`Could not read ${ARTIFACT}: ${err.message}`);
  console.error("Build it with `aztec compile` in contracts/spending_limit_account.");
  process.exit(1);
}

// Both are checks on the build, not on the contract. An untranspiled artifact
// comes from plain nargo rather than `aztec compile`, and loadContractArtifact
// rejects it at runtime rather than here.
if (!raw.transpiled) {
  console.error("Artifact is not transpiled -- built with nargo instead of `aztec compile`?");
  process.exit(1);
}
if (!raw.aztec_version) {
  console.error("Artifact has no aztec_version");
  process.exit(1);
}

const contractClass = await getContractClassFromArtifact(loadContractArtifact(raw));
const classId = contractClass.id.toString();

console.log(`aztec ${raw.aztec_version} / noir ${raw.noir_version}`);
console.log(`contract class id: ${classId}`);

if (!pinPath) process.exit(0);

let pinned;
try {
  pinned = readFileSync(pinPath, "utf8").trim();
} catch {
  // Warned rather than failed, so the pin can be introduced without the
  // contract job going red before anyone has a value to commit. It becomes
  // load-bearing the moment the file lands.
  console.log(`::warning::${pinPath} is absent -- the class ID is UNPINNED.`);
  console.log(`::warning::Commit this to activate the check: ${classId}`);
  process.exit(0);
}

if (pinned !== classId) {
  console.error(`::error::Contract class ID changed.`);
  console.error(`  pinned:   ${pinned}`);
  console.error(`  computed: ${classId}`);
  console.error("");
  console.error("The account address derives from this. A change that is not deliberate");
  console.error("means the toolchain moved under the contract, and deploying against it");
  console.error("would strand the balance at the old address. If the change IS deliberate,");
  console.error(`update ${pinPath} in the same commit as the contract change.`);
  process.exit(1);
}

console.log(`class id matches ${pinPath}`);
