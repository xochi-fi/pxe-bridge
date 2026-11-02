import { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import { computeSignerRegistrationMessageHash } from '../oxide-lib/hash.js';
import type { TEEMetadata } from '../oxide-lib/types.js';

import type { ChainDataSource } from './chain_data_source.js';

/** Fetches the L1->L2 witness of the `metadata` signer's `teeRegistry` registration at `referenceBlock`. */
export async function fetchSignerRegistrationWitness(
  chain: Pick<ChainDataSource, 'getL1ToL2MessageMembershipWitness'>,
  teeRegistry: EthAddress,
  metadata: TEEMetadata,
  referenceBlock: BlockHeader,
): Promise<MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>> {
  const messageHash = computeSignerRegistrationMessageHash(
    {
      teeRegistry,
      l1ChainId: referenceBlock.globalVariables.chainId.toBigInt(),
      rollupVersion: referenceBlock.globalVariables.version.toBigInt(),
    },
    metadata.publicKey(),
    metadata.registrationLeafIndex,
  );
  const referenceBlockHash = await referenceBlock.hash();
  const witness = await chain.getL1ToL2MessageMembershipWitness(referenceBlockHash, messageHash);
  if (!witness) {
    throw new Error(
      `No L1->L2 witness for the registration of signer x=${metadata.pubKeyXHi}|${metadata.pubKeyXLo}` +
        ` on TeeRegistry ${teeRegistry} at leaf ${metadata.registrationLeafIndex}`,
    );
  }
  const [leafIndex, siblingPath] = witness;
  return MembershipWitness.fromSiblingPath(leafIndex, siblingPath);
}
