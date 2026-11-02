// Modified for pxe-bridge (see ../VENDORED.md): readOxideTokenImmutables removed.
// It takes name/symbol from the portal's underlying ERC-20 ("Dai Stablecoin"),
// not the deployed token's ("Oxide DAI"), so it never derives the deployed
// address; pxe-bridge uses the pinned manifest's l2TokenImmutables instead.
import { NO_FROM } from '@aztec-labs/aztec.js/account';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BatchCall, Contract } from '@aztec-labs/aztec.js/contracts';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import { CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS } from '@aztec-labs/constants';
import type { ContractArtifact } from '@aztec-labs/stdlib/abi';
import {
  type ContractInstanceWithAddress,
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from '@aztec-labs/stdlib/contract';
import {
  DelayedPublicMutableValues,
  DelayedPublicMutableValuesWithHash,
} from '@aztec-labs/stdlib/delayed-public-mutable';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';

import { TOKEN_UPDATE_DELAY } from '../oxide-lib/oxide_constants.gen.js';
import {
  type OxideTokenImmutables,
  computeTokenImmutablesHash,
  tokenImmutablesAbiArg,
} from '../oxide-lib/token_immutables.js';

/** The instance of the token `artifact` that `immutables` commit to. */
export async function predictOxideTokenInstanceWithArtifact(
  artifact: ContractArtifact,
  immutables: OxideTokenImmutables,
): Promise<ContractInstanceWithAddress> {
  return await getContractInstanceFromInstantiationParams(artifact, {
    salt: Fr.ZERO,
    immutablesHash: await computeTokenImmutablesHash(immutables),
  });
}

/**
 * Registers the token at `address` with the wallet and stores its immutables. Every wallet that calls the token needs
 * them. Pass the `OxideToken` artifact of the caller's bindings.
 *
 * Throws if the immutables do not give `address`.
 */
export async function registerOxideTokenWithArtifact(
  wallet: Wallet,
  artifact: ContractArtifact,
  immutables: OxideTokenImmutables,
  address: AztecAddress,
): Promise<Contract> {
  const instance = await predictOxideTokenInstanceWithArtifact(artifact, immutables);
  if (!instance.address.equals(address)) {
    throw new Error(`Token immutables give ${instance.address.toString()}, not the token ${address.toString()}`);
  }
  await wallet.registerContract(instance, artifact);
  const token = Contract.at(instance.address, artifact, wallet);
  await token.methods.store_immutables(tokenImmutablesAbiArg(immutables)).simulate({ from: NO_FROM });
  return token;
}

/**
 * Publishes the token's instance, and its class if the class is not published yet. Then locks its class-update delay
 * and stores its immutables, like {@link registerOxideTokenWithArtifact}. Pass the `OxideToken` artifact of the
 * caller's bindings.
 */
export async function publishAndLockOxideTokenWithArtifact(
  wallet: Wallet,
  artifact: ContractArtifact,
  immutables: OxideTokenImmutables,
  from: AztecAddress,
): Promise<Contract> {
  const publish = Contract.deploy(wallet, artifact, [], undefined, {
    salt: Fr.ZERO,
    immutablesHash: await computeTokenImmutablesHash(immutables),
    universalDeploy: true,
  });
  const token = await publish.register();
  // The token has no public functions, so it does not need a published instance to run. The instance registry accepts
  // `set_update_delay` only from a published contract, so the lock needs the instance publication.
  await new BatchCall(wallet, [publish, token.methods.lock_update_delay()]).send({ from });
  await token.methods.store_immutables(tokenImmutablesAbiArg(immutables)).simulate({ from: NO_FROM });
  return token;
}

/**
 * Whether the token at `token` is locked to the class of `artifact`, which holds when:
 * - it is published with that class,
 * - its class-update record names no other class, and
 * - its class-update delay is `TOKEN_UPDATE_DELAY`.
 */
export async function isOxideTokenLockedToArtifact(
  node: Pick<AztecNode, 'getContract' | 'getPublicStorageAt'>,
  artifact: ContractArtifact,
  token: AztecAddress,
): Promise<boolean> {
  const registry = AztecAddress.fromNumberUnsafe(CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS);
  const { delayedPublicMutableSlot } = await DelayedPublicMutableValuesWithHash.getContractUpdateSlots(token);
  const [instance, contractClass, update] = await Promise.all([
    node.getContract(token),
    getContractClassFromArtifact(artifact),
    DelayedPublicMutableValues.readFromTree(delayedPublicMutableSlot, slot =>
      node.getPublicStorageAt('latest', registry, slot),
    ),
  ]);
  if (!instance?.originalContractClassId.equals(contractClass.id)) {
    return false;
  }
  const classIds = [...update.svc.previous, ...update.svc.post];
  // A zero class id means no update, so the original class applies.
  const onlyOwnClass = classIds.every(classId => classId.isZero() || classId.equals(contractClass.id));
  return onlyOwnClass && update.sdc.post === BigInt(TOKEN_UPDATE_DELAY);
}
