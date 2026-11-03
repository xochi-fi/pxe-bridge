import { SchnorrAccountContract, SchnorrInitializerlessAccountContract } from '@aztec-labs/accounts/schnorr';
import { Fr, GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { deriveKeys } from '@aztec-labs/aztec.js/keys';
import { CompleteAddress, getContractInstanceFromInstantiationParams } from '@aztec-labs/stdlib/contract';
import type { TxHash } from '@aztec-labs/stdlib/tx';

import type { SpendMetadata } from './token_operations_collector.js';

/**
 * Builds the metadata the TEE signer needs to validate a spent note: the owner's
 * address-preimage and master nullifier hiding key, plus the creation tx hash.
 *
 * Callers are responsible for resolving `(secret, salt, signingKey)` from their
 * own account source (persistent store, test fixture, etc.) before calling this.
 */
export async function buildSpendMetadata(input: {
  secret: Fr;
  salt: Fr;
  signingKey: GrumpkinScalar;
  creationTxHash: TxHash;
  /** True for `schnorr_initializerless` accounts (v5 genesis funded accounts): they have no
   *  constructor, so their address preimage derives from the initializerless contract class. */
  initializerless?: boolean;
}): Promise<SpendMetadata> {
  const keys = await deriveKeys(input.secret);

  const accountContract = input.initializerless
    ? new SchnorrInitializerlessAccountContract(input.signingKey)
    : new SchnorrAccountContract(input.signingKey);
  const init = (await accountContract.getInitializationFunctionAndArgs()) ?? {
    constructorName: undefined,
    constructorArgs: undefined,
  };
  const artifact = await accountContract.getContractArtifact();
  const instance = await getContractInstanceFromInstantiationParams(artifact, {
    constructorArtifact: init.constructorName,
    constructorArgs: init.constructorArgs,
    salt: input.salt,
    publicKeys: keys.publicKeys,
    // v5 ContractInstance v2: initializerless accounts have no constructor to carry the signing
    // key, so it lives in the immutablesHash — mirror getAccountContractAddress or the derived
    // owner address won't match the note.
    immutablesHash: await accountContract.getImmutablesHash(),
  });
  const ownerAddressPreimage = await CompleteAddress.fromSecretKeyAndInstance(input.secret, instance);

  return {
    creationTxHash: input.creationTxHash,
    ownerAddressPreimage,
    masterNullifierHidingKey: keys.masterNullifierHidingSecretKey,
  };
}
