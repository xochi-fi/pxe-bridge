/**
 * Recomputes a SchnorrAccount address from its public descriptor, step by step
 * with the stdlib hash primitives -- no wallet, no PXE, no account manager.
 * This is the check a registration service would run (spec §5.2).
 *
 *   initialization_hash      = poseidon2(INITIALIZER, [ctor_selector, varArgsHash(ctor_args)])
 *   salted_initialization    = poseidon2(SALTED_INITIALIZATION_HASH,
 *                                        [salt, initialization_hash, deployer, immutables_hash])
 *   partial_address          = poseidon2(PARTIAL_ADDRESS, [class_id, salted_initialization])
 *   address                  = computeAddress(public_keys, partial_address)
 */
import { SchnorrAccountContractArtifact } from "@aztec-labs/accounts/schnorr";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { DomainSeparator } from "@aztec-labs/constants";
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon";
import { FunctionSelector } from "@aztec-labs/stdlib/abi";
import { computeVarArgsHash } from "@aztec-labs/stdlib/hash";
import { computeAddress, PublicKeys } from "@aztec-labs/stdlib/keys";

export interface Descriptor {
  classId: Fr;
  /** Grumpkin signing public key (x, y): the SchnorrAccount constructor arguments. */
  constructorArgs: [Fr, Fr];
  salt: Fr;
  deployer: AztecAddress;
  immutablesHash: Fr;
  publicKeys: PublicKeys;
}

/** The SchnorrAccount constructor's initialization hash for a signing key. */
export async function initializationHashFor(constructorArgs: [Fr, Fr]): Promise<Fr> {
  const ctor = SchnorrAccountContractArtifact.functions.find((f) => f.name === "constructor")!;
  const selector = await FunctionSelector.fromNameAndParameters(ctor.name, ctor.parameters);
  return poseidon2HashWithSeparator(
    [selector.toField(), await computeVarArgsHash(constructorArgs)],
    DomainSeparator.INITIALIZER,
  );
}

export async function addressFromDescriptor(
  d: Descriptor,
): Promise<{ initializationHash: Fr; address: AztecAddress }> {
  const initializationHash = await initializationHashFor(d.constructorArgs);
  const salted = await poseidon2HashWithSeparator(
    [d.salt, initializationHash, d.deployer.toField(), d.immutablesHash],
    DomainSeparator.SALTED_INITIALIZATION_HASH,
  );
  const partial = await poseidon2HashWithSeparator([d.classId, salted], DomainSeparator.PARTIAL_ADDRESS);
  return { initializationHash, address: await computeAddress(d.publicKeys, partial) };
}
