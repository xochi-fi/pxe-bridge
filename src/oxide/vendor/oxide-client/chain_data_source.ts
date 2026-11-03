import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';

/**
 * The chain data the oxide flows read: block and tx lookups plus world-state membership witnesses. A live node
 * supplies it; so does a static snapshot pinned at the frozen block.
 */
export type ChainDataSource = Pick<
  AztecNode,
  | 'getBlock'
  | 'getBlocks'
  | 'getBlockData'
  | 'getCheckpointsData'
  | 'getTxEffect'
  | 'getTxReceipt'
  | 'getBlockHashMembershipWitness'
  | 'getBlockHashMembershipWitnessAtArchive'
  | 'getPublicDataWitness'
  | 'getL2ToL1Messages'
  | 'getL2ToL1MembershipWitness'
  | 'getL1ToL2MessageMembershipWitness'
  | 'getNoteHashMembershipWitness'
  | 'getLowNullifierMembershipWitness'
  | 'findLeavesIndexes'
>;
