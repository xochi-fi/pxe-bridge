/**
 * What a registration service could check with no access to the recipient's
 * PXE. First, fail closed on the descriptor alone (no derivation, no node):
 * every emitted field parses, the class id is the pinned 5.2.0 SchnorrAccount,
 * the artifactHash is the shipped artifact's, the immutablesHash is zero and the
 * initializationHash is the one the constructor args produce. Only then
 * re-derive the address (derive.ts) and confirm against the node that
 *   - an instance exists at that address, with exactly the descriptor's class
 *     id, initialization hash, salt, deployer, immutables hash and public keys;
 *   - the class the node has registered under that id has the artifactHash,
 *     private-functions root and public-bytecode commitment we compute from the
 *     shipped SchnorrAccount artifact.
 *
 *   npx tsx spike/633-recipient-schnorr/check-descriptor.ts [--mutate <case>]
 *
 * `--mutate` runs the same entry point on a forged copy of the recipient's
 * descriptor (address recomputed where the field feeds it, so the forged field
 * is the only defect): initializerless | immutables | artifact-hash | init-hash.
 *
 * Exit 0: every check passed. Exit 2: descriptor refused before derivation or
 * node lookup (under --mutate, only for that case's expected reason). Exit 1:
 * anything else.
 */
import { SchnorrAccountContractArtifact } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  computeContractClassId,
  computePublicBytecodeCommitment,
  getContractClassFromArtifact,
} from "@aztec/stdlib/contract";
import { PublicKeys } from "@aztec/stdlib/keys";
import { z } from "zod";

import { NODE_URL, readPublic } from "./common.js";
import { addressFromDescriptor, initializationHashFor, type Descriptor } from "./derive.js";
import { INITIALIZERLESS_CLASS_ID, PINNED_CLASS_ID } from "./expected.js";

const field = z.string().regex(/^0x[0-9a-f]{64}$/i);
const DescriptorSchema = z
  .object({
    accountClass: z.literal("@aztec/accounts SchnorrAccount"),
    classId: field,
    artifactHash: field,
    constructor: z.literal("constructor"),
    constructorArgs: z.tuple([field, field]),
    initializationHash: field,
    salt: field,
    deployer: field,
    immutablesHash: field,
    publicKeys: z.string().regex(/^0x[0-9a-f]+$/i),
    address: field,
  })
  .strict();
type RawDescriptor = z.infer<typeof DescriptorSchema>;

type Refusal = "schema" | "class-id" | "local-artifact" | "artifact-hash" | "immutables" | "init-hash";
class Refused extends Error {
  constructor(readonly reason: Refusal, detail: string) {
    super(`descriptor refused (${reason}): ${detail}`);
  }
}

const local = await getContractClassFromArtifact(SchnorrAccountContractArtifact);

function toDescriptor(d: RawDescriptor): Descriptor {
  return {
    classId: Fr.fromString(d.classId),
    constructorArgs: [Fr.fromString(d.constructorArgs[0]), Fr.fromString(d.constructorArgs[1])],
    salt: Fr.fromString(d.salt),
    deployer: AztecAddress.fromStringUnsafe(d.deployer),
    immutablesHash: Fr.fromString(d.immutablesHash),
    publicKeys: PublicKeys.fromString(d.publicKeys),
  };
}

interface Gate {
  d: RawDescriptor;
  descriptor: Descriptor;
  initializationHash: Fr;
}

/** The fail-closed gate. Touches neither address derivation nor the node. */
async function validate(input: unknown): Promise<Gate> {
  const parsed = DescriptorSchema.safeParse(input);
  if (!parsed.success) throw new Refused("schema", parsed.error.message);
  const d = parsed.data;
  let descriptor: Descriptor;
  try {
    descriptor = toDescriptor(d);
  } catch (err) {
    throw new Refused("schema", String(err));
  }
  const pinned = Fr.fromString(PINNED_CLASS_ID);
  if (!local.id.equals(pinned)) {
    throw new Refused("local-artifact", `shipped artifact class ${local.id} is not the pin ${PINNED_CLASS_ID}`);
  }
  if (!descriptor.classId.equals(pinned)) {
    throw new Refused("class-id", `${d.classId} is not the pinned ${PINNED_CLASS_ID}`);
  }
  if (!Fr.fromString(d.artifactHash).equals(local.artifactHash)) {
    throw new Refused("artifact-hash", `${d.artifactHash} is not the shipped ${local.artifactHash}`);
  }
  if (!descriptor.immutablesHash.isZero()) {
    throw new Refused("immutables", `immutablesHash ${d.immutablesHash} is not zero`);
  }
  const initializationHash = await initializationHashFor(descriptor.constructorArgs);
  if (!Fr.fromString(d.initializationHash).equals(initializationHash)) {
    throw new Refused("init-hash", `${d.initializationHash} is not the recomputed ${initializationHash}`);
  }
  return { d, descriptor, initializationHash };
}

/**
 * A forged copy of an honest descriptor, and the refusal it must produce. The
 * address is re-derived from the forged fields, so it stays self-consistent.
 */
async function mutate(honest: RawDescriptor, kind: string): Promise<{ forged: RawDescriptor; expect: Refusal }> {
  const forged = { ...honest };
  let expect: Refusal;
  switch (kind) {
    case "initializerless":
      forged.classId = INITIALIZERLESS_CLASS_ID;
      expect = "class-id";
      break;
    case "immutables":
      forged.immutablesHash = new Fr(1n).toString();
      expect = "immutables";
      break;
    case "artifact-hash":
      forged.artifactHash = new Fr(Fr.fromString(forged.artifactHash).toBigInt() + 1n).toString();
      expect = "artifact-hash";
      break;
    case "init-hash":
      forged.initializationHash = new Fr(Fr.fromString(forged.initializationHash).toBigInt() + 1n).toString();
      expect = "init-hash";
      break;
    default:
      throw new Error(`unknown --mutate case ${kind}`);
  }
  forged.address = (await addressFromDescriptor(toDescriptor(forged))).address.toString();
  return { forged, expect };
}

let input: unknown = readPublic()["recipientDescriptor"];
let expectRefusal: Refusal | undefined;
const mutateAt = process.argv.indexOf("--mutate");
if (mutateAt !== -1) {
  const kind = process.argv[mutateAt + 1] ?? "";
  const { forged, expect } = await mutate(DescriptorSchema.parse(input), kind);
  console.log(`[negative ${kind}] forged descriptor ${JSON.stringify(forged)}`);
  input = forged;
  expectRefusal = expect;
}

let gate: Gate;
try {
  gate = await validate(input);
} catch (err) {
  if (!(err instanceof Refused)) throw err;
  const right = expectRefusal === undefined || err.reason === expectRefusal;
  console.log(`${expectRefusal && right ? "PASS" : "FAIL"} ${err.message}`);
  if (expectRefusal && !right) console.log(`FAIL expected refusal reason ${expectRefusal}`);
  process.exit(right ? 2 : 1);
}
if (expectRefusal) {
  console.log(`FAIL forged descriptor accepted; expected refusal ${expectRefusal}`);
  process.exit(1);
}
const { d, descriptor, initializationHash } = gate;

let ok = true;
const check = (label: string, pass: boolean, detail = ""): void => {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  ok &&= pass;
};

check("descriptor class id == pinned 5.2.0 class id == shipped artifact's", true, local.id.toString());
check("descriptor artifactHash == shipped artifact's", true, d.artifactHash);
check("descriptor immutablesHash == 0", true);
check("descriptor initializationHash == recomputed from constructor args", true, initializationHash.toString());

const { address } = await addressFromDescriptor(descriptor);
check("address re-derived from descriptor == claimed address", address.toString() === d.address, address.toString());

const node = createAztecNodeClient(NODE_URL);
const instance = await node.getContract(address);
check("instance published on node", instance !== undefined);
if (instance) {
  check("node instance originalContractClassId", instance.originalContractClassId.equals(local.id), instance.originalContractClassId.toString());
  check("node instance currentContractClassId", instance.currentContractClassId.equals(local.id), instance.currentContractClassId.toString());
  check("node instance initializationHash", instance.initializationHash.equals(initializationHash), instance.initializationHash.toString());
  check("node instance salt", instance.salt.equals(descriptor.salt));
  check("node instance deployer", instance.deployer.equals(descriptor.deployer), instance.deployer.toString());
  check("node instance immutablesHash", instance.immutablesHash.equals(descriptor.immutablesHash));
  check("node instance publicKeys", instance.publicKeys.equals(descriptor.publicKeys));
}

const published = await node.getContractClass(local.id);
check("class registered on node", published !== undefined);
if (published) {
  check("node class artifactHash", published.artifactHash.equals(local.artifactHash), published.artifactHash.toString());
  check("node class privateFunctionsRoot", published.privateFunctionsRoot.equals(local.privateFunctionsRoot), published.privateFunctionsRoot.toString());
  // The node serves the packed public bytecode, not its commitment: recompute
  // it, then the class id from the node's own preimage.
  const commitment = await computePublicBytecodeCommitment(published.packedBytecode);
  check("node class publicBytecodeCommitment (from served bytecode)", commitment.equals(local.publicBytecodeCommitment), commitment.toString());
  const nodeClassId = await computeContractClassId({
    artifactHash: published.artifactHash,
    privateFunctionsRoot: published.privateFunctionsRoot,
    publicBytecodeCommitment: commitment,
  });
  check("class id recomputed from node's preimage == pinned class id", nodeClassId.equals(local.id), nodeClassId.toString());
}

// Contrast: a descriptor with only the signing key swapped is a different account.
const swapped = await addressFromDescriptor({ ...descriptor, constructorArgs: [descriptor.constructorArgs[1], descriptor.constructorArgs[0]] });
check("swapping the constructor args (signing key) changes the address", !swapped.address.equals(address), swapped.address.toString());
check("no instance on node at the swapped address", (await node.getContract(swapped.address)) === undefined);

process.exit(ok ? 0 : 1);
