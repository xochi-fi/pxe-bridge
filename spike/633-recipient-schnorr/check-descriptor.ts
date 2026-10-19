/**
 * What a registration service could check with no access to the recipient's
 * PXE: re-derive the address from the published descriptor (derive.ts), then
 * confirm against the node that
 *   - an instance exists at that address, with exactly the descriptor's class
 *     id, initialization hash, salt, deployer, immutables hash and public keys;
 *   - the class the node has registered under that id has the artifactHash,
 *     private-functions root and public-bytecode commitment we compute from the
 *     shipped SchnorrAccount artifact.
 *
 *   npx tsx spike/633-recipient-schnorr/check-descriptor.ts
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
import { addressFromDescriptor } from "./derive.js";

const hex = z.string().regex(/^0x[0-9a-f]+$/i);
const d = z
  .object({
    classId: hex,
    constructorArgs: z.tuple([hex, hex]),
    salt: hex,
    deployer: hex,
    immutablesHash: hex,
    publicKeys: hex,
    address: hex,
  })
  .parse(readPublic()["recipientDescriptor"]);
const descriptor = {
  classId: Fr.fromString(d.classId),
  constructorArgs: [Fr.fromString(d.constructorArgs[0]), Fr.fromString(d.constructorArgs[1])] as [Fr, Fr],
  salt: Fr.fromString(d.salt),
  deployer: AztecAddress.fromStringUnsafe(d.deployer),
  immutablesHash: Fr.fromString(d.immutablesHash),
  publicKeys: PublicKeys.fromString(d.publicKeys),
};

let ok = true;
const check = (label: string, pass: boolean, detail = ""): void => {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  ok &&= pass;
};

const local = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
check("descriptor class id == class id computed from shipped artifact", local.id.equals(descriptor.classId), local.id.toString());

const { initializationHash, address } = await addressFromDescriptor(descriptor);
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
