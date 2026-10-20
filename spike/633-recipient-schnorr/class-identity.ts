/**
 * Offline half of the xochi-fi/xochi#633 compatibility spike. Needs no node.
 *
 *   1. class identity of @aztec/accounts 5.1.0 `SchnorrAccount`, computed from
 *      the shipped artifact (class id, Aztec artifactHash, sha256 of the file);
 *   2. the signing key is a constructor argument, so it is in the
 *      initialization hash and therefore the address: two signing keys under
 *      one secret and salt give two addresses, and the address is recomputed
 *      from the public descriptor by hand, without a wallet or PXE;
 *   3. the function list of the artifact, to show there is no function that
 *      changes the signing key.
 *
 * Run: npx tsx spike/633-recipient-schnorr/class-identity.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  SchnorrAccountContract,
  SchnorrAccountContractArtifact,
  SchnorrInitializerlessAccountContractArtifact,
} from "@aztec/accounts/schnorr";
import { getAccountContractAddress } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { FunctionSelector, FunctionType } from "@aztec/stdlib/abi";
import {
  computeArtifactHash,
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec/stdlib/contract";
import { deriveKeys } from "@aztec/stdlib/keys";

import { addressFromDescriptor } from "./derive.js";

const require = createRequire(import.meta.url);

// Fixed, test-only material. Never used with funds.
const SECRET = new Fr(0x633a11cen);
const SALT = new Fr(0x5a17n);
const SIGNING_KEY_A = GrumpkinScalar.fromString("0x" + "0a".repeat(31));
const SIGNING_KEY_B = GrumpkinScalar.fromString("0x" + "0b".repeat(31));

async function main(): Promise<void> {
  console.log("== versions ==");
  for (const p of [
    "@aztec/accounts/schnorr",
    "@aztec/aztec.js/account",
    "@aztec/stdlib/contract",
    "@aztec/foundation/crypto/poseidon",
    "@aztec/wallets/embedded",
    "@aztec/bb.js",
  ]) {
    // Not every @aztec package exports ./package.json; read it off disk instead.
    const entry = require.resolve(p);
    const root = entry.slice(0, entry.lastIndexOf("/dest/"));
    const version = JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version;
    console.log(`${p.split("/").slice(0, 2).join("/")} ${version}`);
  }

  // ---------------------------------------------------------------- item 1
  console.log("\n== 1. class identity ==");
  const artifactPath = require
    .resolve("@aztec/accounts/schnorr")
    .replace(/\/dest\/.*$/, "/artifacts/SchnorrAccount.json");
  const raw = JSON.parse(readFileSync(artifactPath, "utf8"));
  console.log(`artifact file        ${artifactPath.replace(/^.*node_modules\//, "")}`);
  console.log(`artifact name        ${raw.name}`);
  console.log(`artifact aztec_ver   ${raw.aztec_version}`);
  console.log(`artifact noir_ver    ${raw.noir_version}`);
  console.log(
    `artifact sha256      ${createHash("sha256").update(readFileSync(artifactPath)).digest("hex")}`,
  );

  const cls = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
  const artifactHash = await computeArtifactHash(SchnorrAccountContractArtifact);
  console.log(`class id             ${cls.id.toString()}`);
  console.log(`artifactHash         ${cls.artifactHash.toString()}`);
  console.log(`artifactHash (recmp) ${artifactHash.toString()}`);
  console.log(`privateFunctionsRoot ${cls.privateFunctionsRoot.toString()}`);
  console.log(`publicBytecodeCommit ${cls.publicBytecodeCommitment.toString()}`);

  // The sibling class the same `@aztec/accounts/schnorr` entry point exports.
  // It is NOT the class we pin: it has no initializer and binds the key through
  // immutablesHash instead.
  const initless = await getContractClassFromArtifact(SchnorrInitializerlessAccountContractArtifact);
  console.log(`(not pinned) SchnorrInitializerlessAccount class id ${initless.id.toString()}`);
  const refused = !initless.id.equals(cls.id);
  console.log(`pin refuses SchnorrInitializerlessAccount: ${refused ? "PASS" : "FAIL"}`);
  if (!refused) process.exitCode = 1;

  // ---------------------------------------------------------------- item 3
  console.log("\n== 3. functions (rotation check) ==");
  for (const f of SchnorrAccountContractArtifact.functions) {
    const params = f.parameters.map((p) => p.name).join(", ");
    console.log(
      `${f.functionType.padEnd(8)} ${f.isInitializer ? "init " : "     "}${f.name}(${params})`,
    );
  }
  console.log(`storage: ${Object.keys(SchnorrAccountContractArtifact.storageLayout).join(", ")}`);
  const source = Object.values(raw.file_map as Record<string, { path: string; source: string }>).find(
    (f) => f.path.endsWith("schnorr_account_contract/src/main.nr"),
  )!.source;
  // Every write to the key is a call on the storage variable. There must be
  // exactly one, in the constructor, and the variable must be immutable.
  const writes = [...source.matchAll(/signing_public_key\.(\w+)\(/g)].map((m) => m[1]);
  console.log(`signing_public_key state var: ${/signing_public_key: (\w+)</.exec(source)![1]}`);
  console.log(`signing_public_key accesses: ${writes.join(", ")}`);
  const publicFns = SchnorrAccountContractArtifact.functions.filter(
    (f) => f.functionType === FunctionType.PUBLIC,
  );
  console.log(`public functions: ${publicFns.map((f) => f.name).join(", ")}`);

  // ---------------------------------------------------------------- item 2
  console.log("\n== 2. address derivation ==");
  const { publicKeys } = await deriveKeys(SECRET);
  const ctor = SchnorrAccountContractArtifact.functions.find((f) => f.name === "constructor")!;
  const selector = await FunctionSelector.fromNameAndParameters(ctor.name, ctor.parameters);
  console.log(`constructor selector ${selector.toString()}`);
  console.log(`publicKeys hash      ${(await publicKeys.hash()).toString()}`);

  const addresses: AztecAddress[] = [];
  for (const [label, signingKey] of [
    ["A", SIGNING_KEY_A],
    ["B", SIGNING_KEY_B],
  ] as const) {
    const contract = new SchnorrAccountContract(signingKey);
    const pub = await contract.getSigningPublicKey();

    // SDK path (what EmbeddedWallet.createSchnorrAccount resolves to).
    const sdkAddress = await getAccountContractAddress(contract, SECRET, SALT);

    // Manual path, from the public descriptor only (derive.ts).
    const { initializationHash, address: manualAddress } = await addressFromDescriptor({
      classId: cls.id,
      constructorArgs: [pub.x, pub.y],
      salt: SALT,
      deployer: AztecAddress.ZERO,
      immutablesHash: Fr.ZERO,
      publicKeys,
    });

    // And the stdlib instance path, for a third opinion.
    const instance = await getContractInstanceFromInstantiationParams(
      SchnorrAccountContractArtifact,
      {
        constructorArtifact: "constructor",
        constructorArgs: [pub.x, pub.y],
        salt: SALT,
        publicKeys,
        deployer: AztecAddress.ZERO,
      },
    );

    console.log(`[${label}] signing pubkey x      ${pub.x.toString()}`);
    console.log(`[${label}] signing pubkey y      ${pub.y.toString()}`);
    console.log(`[${label}] initializationHash    ${initializationHash.toString()}`);
    console.log(`[${label}] instance.initHash     ${instance.initializationHash.toString()}`);
    console.log(`[${label}] immutablesHash        ${instance.immutablesHash.toString()}`);
    console.log(`[${label}] address (SDK)         ${sdkAddress.toString()}`);
    console.log(`[${label}] address (manual)      ${manualAddress.toString()}`);
    console.log(`[${label}] address (instance)    ${instance.address.toString()}`);
    const agree =
      sdkAddress.equals(manualAddress) &&
      sdkAddress.equals(instance.address) &&
      initializationHash.equals(instance.initializationHash);
    console.log(`[${label}] all three agree       ${agree ? "PASS" : "FAIL"}`);
    if (!agree) process.exitCode = 1;
    addresses.push(sdkAddress);
  }
  const distinct = !addresses[0]!.equals(addresses[1]!);
  console.log(
    `same secret+salt, different signing key -> different address: ${distinct ? "PASS" : "FAIL"}`,
  );
  if (!distinct) process.exitCode = 1;
}

await main();
