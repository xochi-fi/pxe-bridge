import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { type BlockParameter, inspectBlockParameter } from '@aztec-labs/stdlib/block';
import type {
  AztecNode,
  BlockIncludeOptions,
  BlockResponse,
  BlocksIncludeOptions,
} from '@aztec-labs/stdlib/interfaces/client';

/**
 * The node reads the spent-note fan-out performs. All are anchored reads of immutable history, so within one
 * operation build a repeated call is guaranteed to return the same data.
 */
export type AnchoredNodeReads = Pick<
  AztecNode,
  | 'getTxEffect'
  | 'getBlock'
  | 'getBlocks'
  | 'getBlockData'
  | 'getBlockHashMembershipWitness'
  | 'getBlockHashMembershipWitnessAtArchive'
  | 'getL1ToL2MessageMembershipWitness'
>;

const includeKey = (o?: BlocksIncludeOptions): string =>
  [o?.includeTransactions, o?.includeL1PublishInfo, o?.includeAttestations, o?.onlyCheckpointed]
    .map(f => (f ? '1' : '0'))
    .join('');

/**
 * Read-memoizing view of a node, scoped to one operation build. The per-spent-note hint fan-out repeats identical
 * anchored reads — notes sharing a creation tx, a block, or the TEE signer — and the memo collapses each to a single
 * node call. Callers get shared response instances and must treat them as read-only.
 */
export function memoizeNodeReads(node: AnchoredNodeReads): AnchoredNodeReads {
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    let promise = cache.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = fn();
      promise.catch(() => cache.delete(key));
      cache.set(key, promise);
    }
    return promise;
  };
  return {
    getTxEffect: txHash => once(`getTxEffect:${txHash}`, () => node.getTxEffect(txHash)),
    getBlock: <Opts extends BlockIncludeOptions>(param: BlockParameter, options?: Opts) =>
      once(`getBlock:${inspectBlockParameter(param)}:${includeKey(options)}`, () =>
        node.getBlock(param, options),
      ) as Promise<BlockResponse<Opts> | undefined>,
    getBlocks: <Opts extends BlocksIncludeOptions>(from: BlockNumber, limit: number, options?: Opts) =>
      once(`getBlocks:${from}:${limit}:${includeKey(options)}`, () => node.getBlocks(from, limit, options)) as Promise<
        BlockResponse<Opts>[]
      >,
    getBlockData: param => once(`getBlockData:${inspectBlockParameter(param)}`, () => node.getBlockData(param)),
    getBlockHashMembershipWitness: (referenceBlock, blockHash) =>
      once(`getBlockHashMembershipWitness:${inspectBlockParameter(referenceBlock)}:${blockHash}`, () =>
        node.getBlockHashMembershipWitness(referenceBlock, blockHash),
      ),
    // Keyed by the exact root, so a witness is never reused for another archive. A cached witness does not make its
    // root canonical: the caller still selects a root that its verifier accepts.
    getBlockHashMembershipWitnessAtArchive: ({ archive }, blockHash) =>
      once(`getBlockHashMembershipWitnessAtArchive:${archive}:${blockHash}`, () =>
        node.getBlockHashMembershipWitnessAtArchive({ archive }, blockHash),
      ),
    getL1ToL2MessageMembershipWitness: (referenceBlock, messageHash) =>
      once(`getL1ToL2MessageMembershipWitness:${inspectBlockParameter(referenceBlock)}:${messageHash}`, () =>
        node.getL1ToL2MessageMembershipWitness(referenceBlock, messageHash),
      ),
  };
}
