/**
 * Offline class identity of stock `SchnorrAccount` under @aztec-labs
 * 6.0.0-rc.3, installed in this directory only. xochi-fi/xochi#633 was scoped
 * to a testnet on 6.0.0-rc.3; the node now reports 6.0.0, so the live run
 * (one directory up) pins 6.0.0, and this records what rc.3 would have
 * deployed for comparison. Exits nonzero on a version, surface or class-id
 * mismatch with RC3_CLASS_ID in ../expected.ts (testnet-node.ts queries the
 * testnet for that id); equality with the 6.0.0 and 5.2.0 pins is reported.
 *
 *   (cd spike/633-recipient-schnorr-testnet/rc3 && npx tsx class-id.ts)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  SchnorrAccountContractArtifact,
  SchnorrInitializerlessAccountContractArtifact,
} from "@aztec-labs/accounts/schnorr";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";

import { FUNCTION_SURFACE, PIN_5_2_0_CLASS_ID, PINNED_CLASS_ID, RC3_CLASS_ID } from "../expected.js";

const RC_VERSION = "6.0.0-rc.3";
const require = createRequire(import.meta.url);
let ok = true;
const check = (label: string, pass: boolean, detail: unknown): void => {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}  ${JSON.stringify(detail)}`);
  ok &&= pass;
};

const entry = require.resolve("@aztec-labs/accounts/schnorr");
const pkgRoot = entry.slice(0, entry.lastIndexOf("/dest/"));
const version = JSON.parse(readFileSync(`${pkgRoot}/package.json`, "utf8")).version;
check("@aztec-labs/accounts version", version === RC_VERSION, version);
const artifactPath = `${pkgRoot}/artifacts/SchnorrAccount.json`;
const raw = JSON.parse(readFileSync(artifactPath, "utf8"));
check("artifact aztec_version", raw.aztec_version === RC_VERSION, raw.aztec_version);
console.log(`artifact noir_version ${raw.noir_version}`);
console.log(`artifact sha256       ${createHash("sha256").update(readFileSync(artifactPath)).digest("hex")}`);

const cls = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
const initless = await getContractClassFromArtifact(SchnorrInitializerlessAccountContractArtifact);
check("rc.3 class id == expected.ts RC3_CLASS_ID", cls.id.toString() === RC3_CLASS_ID, cls.id.toString());
console.log(`rc.3 artifactHash     ${cls.artifactHash.toString()}`);
console.log(`rc.3 initializerless  ${initless.id.toString()}`);
const surface = SchnorrAccountContractArtifact.functions.map(
  (f) => `${f.functionType} ${f.name}${f.isInitializer ? " init" : ""}`,
);
check("function surface == 6.0.0 surface", JSON.stringify(surface) === JSON.stringify(FUNCTION_SURFACE), surface);
console.log(`rc.3 class id == 6.0.0 pin (${PINNED_CLASS_ID}): ${cls.id.toString() === PINNED_CLASS_ID}`);
console.log(`rc.3 class id == 5.2.0 pin (${PIN_5_2_0_CLASS_ID}): ${cls.id.toString() === PIN_5_2_0_CLASS_ID}`);
process.exit(ok ? 0 : 1);
