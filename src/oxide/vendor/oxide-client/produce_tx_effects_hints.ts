import type { BlockHash, L2Block } from '@aztec-labs/stdlib/block';
import { type TxEffect, type TxHash, computeTxEffectMembershipWitness } from '@aztec-labs/stdlib/tx';

import { toTxEffectHintData } from '../oxide-lib/tx_effect_hint.js';
import type {
  ArchivedTxEffectsHints,
  TxBlockAnchorRelation,
  TxEffectsAtAnchorHints,
  TxEffectsHints,
} from '../oxide-lib/types.js';

import { type ArchiveRef, blockResponseToL2Block } from './archive_ref.js';
import type { AnchoredNodeReads } from './node_read_memo.js';

/**
 * Produces hints that prove a transaction's effects belong to a block that is an ancestor of the given anchor block.
 *
 * @param chain - The chain data to query for blocks, effects, and membership witnesses.
 * @param txHash - Hash of the transaction whose effects we want to prove.
 * @param anchorBlockHash - Hash of the anchor block (the target block must be strictly before this one).
 * @returns The tx effects and the hints needed to verify ancestry.
 */
export async function produceTxEffectsAtAnchorHints(
  chain: AnchoredNodeReads,
  txHash: TxHash,
  anchorBlockHash: BlockHash,
): Promise<{ effects: TxEffect; hints: TxEffectsAtAnchorHints }> {
  const { txBlock, txIndexInBlock } = await fetchTxBlock(chain, txHash);

  // If the tx block is not the anchor block we will get a witness that it's some of the ancestors.
  const txBlockHash = await txBlock.hash();
  let anchorRelation: TxBlockAnchorRelation;
  if (txBlockHash.equals(anchorBlockHash)) {
    anchorRelation = { kind: 'txBlockIsAnchor' };
  } else {
    const archiveMembershipWitness = await chain.getBlockHashMembershipWitness(anchorBlockHash, txBlockHash);
    if (!archiveMembershipWitness) {
      throw new Error(
        `Tx block ${txBlock.number} is not an ancestor of anchor block (hash ${anchorBlockHash}). ` +
          `The anchor block's lastArchive does not contain the tx block's hash.`,
      );
    }
    anchorRelation = { kind: 'txBlockIsAncestorOfAnchor', archiveMembershipWitness };
  }

  const { effects, txEffectsHints } = await produceTxEffectsHints(txBlock, txIndexInBlock, txHash);
  return { effects, hints: { anchorRelation, txEffectsHints } };
}

/**
 * Produces hints that prove the effects of the tx with hash `txHash` belong to a block whose hash is in the given
 * `archive`. The witnesses are obtained from the provided `chain`.
 */
export async function produceArchivedTxEffectsHints(
  chain: AnchoredNodeReads,
  txHash: TxHash,
  archive: ArchiveRef,
): Promise<ArchivedTxEffectsHints> {
  const { txBlock, txIndexInBlock } = await fetchTxBlock(chain, txHash);

  // The witness is against the exact root, so it exists also when the chain stops at the checkpoint's last block.
  const txBlockHash = await txBlock.hash();
  const archiveMembershipWitness = await chain.getBlockHashMembershipWitnessAtArchive(
    { archive: archive.root },
    txBlockHash,
  );
  if (!archiveMembershipWitness) {
    throw new Error(`Tx block ${txBlockHash} is not in the archive ${archive.root}`);
  }

  const { txEffectsHints } = await produceTxEffectsHints(txBlock, txIndexInBlock, txHash);
  return { archiveMembershipWitness, txEffectsHints };
}

/** Looks up the tx and fetches its block with the body, which the tx effects tree is rebuilt from. */
async function fetchTxBlock(
  chain: AnchoredNodeReads,
  txHash: TxHash,
): Promise<{ txBlock: L2Block; txIndexInBlock: number }> {
  const indexedTxEffect = await chain.getTxEffect(txHash);
  if (!indexedTxEffect) {
    throw new Error(`Tx effect not found for hash ${txHash}`);
  }
  const txBlockResp = await chain.getBlock(indexedTxEffect.l2BlockNumber, { includeTransactions: true });
  if (!txBlockResp) {
    throw new Error(`Block ${indexedTxEffect.l2BlockNumber} not found`);
  }
  return { txBlock: blockResponseToL2Block(txBlockResp), txIndexInBlock: indexedTxEffect.txIndexInBlock };
}

/**
 * Rebuilds the block's tx effects tree and returns the tx's effects with its membership path. The root is checked
 * against the header here, so a node that serves a body its header does not commit to fails loudly.
 */
async function produceTxEffectsHints(
  txBlock: L2Block,
  txIndexInBlock: number,
  txHash: TxHash,
): Promise<{ effects: TxEffect; txEffectsHints: TxEffectsHints }> {
  const effects = txBlock.body.txEffects[txIndexInBlock];
  if (!effects || !effects.txHash.equals(txHash)) {
    throw new Error(`Tx ${txHash} is not at index ${txIndexInBlock} of block ${txBlock.number}`);
  }
  const witness = await computeTxEffectMembershipWitness(txBlock.body.txEffects, txIndexInBlock);
  if (!witness.root.equals(txBlock.header.txEffectsTreeRoot)) {
    throw new Error(
      `Tx effects tree root ${witness.root} rebuilt from the body of block ${txBlock.number} does not match ` +
        `the header's ${txBlock.header.txEffectsTreeRoot}`,
    );
  }
  return {
    effects,
    txEffectsHints: {
      txBlockHeader: txBlock.header,
      txEffect: await toTxEffectHintData(effects),
      leafIndex: witness.leafIndex,
      siblingPath: witness.siblingPath.toFields(),
    },
  };
}
