import { Fr } from '@aztec-labs/aztec.js/fields';
import type { BlockNumber, CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { L2Block } from '@aztec-labs/stdlib/block';
import type { BlockResponse } from '@aztec-labs/stdlib/interfaces/client';
import type { BlockHeader, TxHash } from '@aztec-labs/stdlib/tx';

import type { ChainDataSource } from './chain_data_source.js';

/**
 * Minimum archive info every TEE-signed L1 finalization / refund proof needs.
 *
 * Get the block-hash membership witnesses against `root` with `getBlockHashMembershipWitnessAtArchive({ archive:
 * root }, ...)`. The root is the archive after the checkpoint's last block, so that block is a member of it and no
 * later block has to exist.
 */
export interface ArchiveRef {
  /** Archive root after the checkpoint's last L2 block. */
  root: Fr;
  checkpointNumber: CheckpointNumber;
  /** Header of the checkpoint's last L2 block; the operation anchor for the refund proof. */
  checkpointEndBlockHeader: BlockHeader;
}

/**
 * Build an `ArchiveRef` from a known archive root. Looks up the checkpoint-end block header
 * (whose archive IS `archiveRoot`) and derives the checkpoint number.
 *
 * Throws if the checkpoint-end block isn't on the chain yet.
 */
export async function resolveArchive(chain: ChainDataSource, archiveRoot: Fr): Promise<ArchiveRef> {
  if (archiveRoot.equals(Fr.ZERO)) {
    throw new Error('resolveArchive called with zero archive root.');
  }
  const checkpointEnd = await chain.getBlockData({ archive: archiveRoot });
  if (!checkpointEnd) {
    throw new Error(`No L2 block found whose archive matches ${archiveRoot}.`);
  }
  return {
    root: archiveRoot,
    checkpointNumber: checkpointEnd.checkpointNumber,
    checkpointEndBlockHeader: checkpointEnd.header,
  };
}

export async function resolveFreezeArchive(
  portal: { getFreezeArchive(): Promise<Fr> },
  chain: ChainDataSource,
): Promise<ArchiveRef> {
  const freezeArchiveRoot = await portal.getFreezeArchive();
  if (freezeArchiveRoot.equals(Fr.ZERO)) {
    throw new Error('Portal is not frozen, so it has no freeze archive (pass an explicit archive to run pre-freeze).');
  }
  return await resolveArchive(chain, freezeArchiveRoot);
}

/** True when `blockNumber` falls in `[startBlock, startBlock + blockCount)` of the checkpoint. */
export function checkpointContainsBlock(
  checkpoint: { startBlock: BlockNumber; blockCount: number },
  blockNumber: BlockNumber,
): boolean {
  return blockNumber >= checkpoint.startBlock && blockNumber < checkpoint.startBlock + checkpoint.blockCount;
}

/**
 * Resolve the archive root of the checkpoint that contains tx `txHash`. A withdrawal finalization anchors to the
 * checkpoint of its initiation tx by default.
 */
export async function resolveTxCheckpointArchive(chain: ChainDataSource, txHash: TxHash): Promise<Fr> {
  const { slotNumber, blockNumber } = await chain.getTxReceipt(txHash);
  if (slotNumber === undefined || blockNumber === undefined) {
    throw new Error(`Tx ${txHash} is not yet in a checkpoint; cannot resolve its archive.`);
  }
  // The containing checkpoint is anchored at or before the tx's slot, so scan backwards from it.
  const [checkpoint] = await chain.getCheckpointsData({ fromSlot: slotNumber, limit: 1, reverse: true });
  if (!checkpoint || !checkpointContainsBlock(checkpoint, blockNumber)) {
    throw new Error(`No checkpoint containing block ${blockNumber} for tx ${txHash}.`);
  }
  return checkpoint.archive.root;
}

/** Wraps an `includeTransactions: true` block response in an `L2Block` so callers can use its
 *  `.hash()` / `.toBlockBlobData()` helpers. */
export function blockResponseToL2Block(r: BlockResponse<{ includeTransactions: true }>): L2Block {
  return new L2Block(r.archive, r.header, r.body, r.checkpointNumber, r.indexWithinCheckpoint);
}
