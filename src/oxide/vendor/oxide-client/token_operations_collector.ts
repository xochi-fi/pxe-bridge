import { ARCHIVE_HEIGHT } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { CompleteAddress } from '@aztec-labs/stdlib/contract';
import { type BlockHeader, type OffchainEffect, TxHash } from '@aztec-labs/stdlib/tx';

import { extractMetadata } from '../oxide-lib/da_extractors.js';
import {
  ACCOUNTING_EFFECT_IDENTIFIER,
  DEPOSIT_EFFECT_TYPE,
  INSERTION_EFFECT_TYPE,
  NULLIFICATION_EFFECT_TYPE,
  WITHDRAWAL_EFFECT_TYPE,
} from '../oxide-lib/oxide_constants.gen.js';
import type {
  K1NoteSignature,
  NoteData,
  OutboxWithdrawal,
  SpendValidationData,
  SpentDeposit,
  TokenOperation,
} from '../oxide-lib/types.js';

import { PermanentError } from './errors.js';
import { type AnchoredNodeReads, memoizeNodeReads } from './node_read_memo.js';
import { produceTxEffectsAtAnchorHints } from './produce_tx_effects_hints.js';
import { fetchSignerRegistrationWitness } from './signer_registration.js';

/**
 * Mirror of `NoteStage` from `aztec-nr/aztec/src/note/note_metadata.nr`. A nullification
 * effect carries the stage of the note *relative to the nullification's execution context*:
 *   - `PENDING_SAME_PHASE`: the note was created in this same tx AND in the same execution
 *     phase as the nullification. Such a pair is safe to squash — the kernel makes the note
 *     transient and never inserts it into the tree.
 *   - `PENDING_PREVIOUS_PHASE`: the note was created in this tx in the non-revertible phase
 *     but is being nullified in the revertible phase. Per the upstream docs the note is still
 *     inserted into the tree, so the pair MUST NOT be squashed.
 *   - `SETTLED`: the note was created in a prior tx (lives in the tree). Hydrate normally.
 */
export const NoteStage = {
  PENDING_SAME_PHASE: 1,
  PENDING_PREVIOUS_PHASE: 2,
  SETTLED: 3,
} as const;

// Every accounting effect (from effects.nr) starts with `ACCOUNTING_EFFECT_IDENTIFIER`
const ACCOUNTING_EFFECT_IDENTIFIER_FR = new Fr(ACCOUNTING_EFFECT_IDENTIFIER);

export interface NullificationEffectData {
  amount: Fr;
  owner: AztecAddress;
  randomness: Fr;
  storageSlot: Fr;
  provenNoteHash: Fr;
  metadataStage: number;
  metadataMaybeNoteNonce: Fr;
  signature: K1NoteSignature;
  /**
   * Hash of the tx that created the note being nullified. Recorded by the recipient's
   * `note_handler` during sync (see oxide_token_contract/src/delivery.nr) and read
   * back in `emit_nullification_effect`. May be `TxHash.ZERO` if the note was created
   * in this same tx (recipient hasn't synced it).
   */
  creationTxHash: TxHash;
}

export interface InsertionEffectData {
  amount: Fr;
  owner: AztecAddress;
  randomness: Fr;
  storageSlot: Fr;
}

export interface DepositEffectData {
  recipient: AztecAddress;
  amount: bigint;
  sharedSecretSalt: Fr;
  inboxIndex: bigint;
  messageHash: Fr;
}

export interface CollectedAccountingEffects {
  nullifiedNotes: NullificationEffectData[];
  createdNotes: NoteData[];
  withdrawals: OutboxWithdrawal[];
  deposits: DepositEffectData[];
  /**
   * Notes whose insertion was squashed against a same-tx, same-phase nullification. The kernel
   * makes these transient (never lands them in the note hash tree), but the contract still
   * executes the insertion path during this tx — which means it still calls `load_signature`.
   * No recipient ever syncs a transient note, so `validate_note` never runs and the signature
   * is never checked. Callers must build a (dummy) capsule for each entry here so the strict-mode
   * `signature.unwrap()` in `AssertedNote::create` finds something.
   */
  squashedTransientNotes: NoteData[];
}

/**
 * Per-spend metadata the caller must supply to hydrate a nullified note into full SpendValidationData.
 * The signature is not here — it comes from the NullificationEffect itself.
 */
export interface SpendMetadata {
  creationTxHash: TxHash;
  ownerAddressPreimage: CompleteAddress;
  masterNullifierHidingKey: GrumpkinScalar;
}

/** Callback that maps a nullification effect to the spend metadata the TEE needs to sign it. */
export type SpendMetadataResolver = (nullified: NullificationEffectData) => Promise<SpendMetadata>;

/** Key material the TEE needs per spent deposit: the recipient's address preimage and the master nullifier hiding
 *  key that derives the nhk_app keying the deposit-message nullifier. */
export type DepositSpendMetadata = Pick<SpendMetadata, 'ownerAddressPreimage' | 'masterNullifierHidingKey'>;

/** Callback that maps a spent deposit's recipient to the metadata the TEE needs to sign it. */
export type DepositSpendMetadataResolver = (recipient: AztecAddress) => Promise<DepositSpendMetadata>;

export function collectAccountingEffects(
  tokenAddress: AztecAddress,
  offchainEffects: OffchainEffect[],
): CollectedAccountingEffects {
  // Filter out non-accounting effects from all the offchain effects
  const accountingEffects = offchainEffects.filter(
    e => e.contractAddress.equals(tokenAddress) && e.data[0]?.equals(ACCOUNTING_EFFECT_IDENTIFIER_FR),
  );
  if (accountingEffects.length === 0) {
    throw new PermanentError(`No accounting effects found for contract ${tokenAddress}`);
  }

  const nullifiedNotes: NullificationEffectData[] = [];
  const createdNotes: NoteData[] = [];
  const withdrawals: OutboxWithdrawal[] = [];
  const deposits: DepositEffectData[] = [];

  for (const effect of accountingEffects) {
    if (effect.data.length < 2) {
      throw new PermanentError('Accounting effect has no type field');
    }

    const typ = effect.data[1].toNumber();
    switch (typ) {
      case NULLIFICATION_EFFECT_TYPE:
        nullifiedNotes.push(parseNullificationEffect(effect.data));
        break;
      case INSERTION_EFFECT_TYPE: {
        const insertion = parseInsertionEffect(effect.data);
        createdNotes.push({
          amount: insertion.amount.toBigInt(),
          owner: insertion.owner,
          randomness: insertion.randomness,
        });
        break;
      }
      case WITHDRAWAL_EFFECT_TYPE:
        withdrawals.push(parseWithdrawalEffect(effect.data));
        break;
      case DEPOSIT_EFFECT_TYPE:
        deposits.push(parseDepositEffect(effect.data));
        break;
      default:
        throw new PermanentError(`Unknown effect type ${typ}`);
    }
  }

  const {
    nullifiedNotes: remainingNullified,
    createdNotes: remainingCreated,
    squashedTransientNotes,
  } = squashTransientPairs(nullifiedNotes, createdNotes);

  return {
    nullifiedNotes: remainingNullified,
    createdNotes: remainingCreated,
    withdrawals,
    deposits,
    squashedTransientNotes,
  };
}

/**
 * Hydrates collected effects into a full TokenOperation.
 *
 * For each nullified note, this looks up the creation tx's effects, produces ancestry hints against
 * the operation anchor block, extracts the note's anchor-block-hash from the creation metadata, and
 * fetches the archive membership witness needed to prove that anchor-block-hash is an ancestor of
 * the operation anchor block.
 *
 * `spendMetadata` MUST be in the same order and have the same length as `collected.nullifiedNotes`.
 */
export interface PortalAssertions {
  deposits: SpentDeposit[];
}

export async function buildTokenOperation(
  chain: AnchoredNodeReads,
  tokenAddress: AztecAddress,
  teeRegistry: EthAddress,
  anchorBlockHeader: BlockHeader,
  collected: CollectedAccountingEffects,
  spendMetadata: SpendMetadata[],
  portal?: PortalAssertions,
): Promise<TokenOperation> {
  if (spendMetadata.length !== collected.nullifiedNotes.length) {
    throw new PermanentError(
      `spendMetadata length ${spendMetadata.length} does not match nullifiedNotes length ${collected.nullifiedNotes.length}`,
    );
  }

  // Notes sharing a creation tx, block, or TEE signer repeat identical anchored reads.
  chain = memoizeNodeReads(chain);

  const anchorBlockHash = await anchorBlockHeader.hash();

  const spentNotes: SpendValidationData[] = await Promise.all(
    collected.nullifiedNotes.map(async (nullified, i) => {
      const metadata = spendMetadata[i];
      const { effects: creationEffects, hints } = await produceTxEffectsAtAnchorHints(
        chain,
        metadata.creationTxHash,
        anchorBlockHash,
      );

      const creationMetadata = await extractMetadata(creationEffects, tokenAddress);

      // A block's own hash isn't in its own archive, so when the creation's anchor equals the
      // operation's anchor, no real witness exists. The signer short-circuits on equality and
      // never consults the witness, so we stuff in a zero-filled placeholder in that case.
      const anchorBlockHashMembershipWitness = creationMetadata.anchorBlockHash.equals(anchorBlockHash)
        ? MembershipWitness.empty(ARCHIVE_HEIGHT)
        : await chain.getBlockHashMembershipWitness(anchorBlockHash, creationMetadata.anchorBlockHash);
      if (!anchorBlockHashMembershipWitness) {
        throw new Error(
          `Creation anchor block ${creationMetadata.anchorBlockHash} is not an ancestor of operation anchor block ${anchorBlockHash}`,
        );
      }

      const signerRegistrationWitness = await fetchSignerRegistrationWitness(
        chain,
        teeRegistry,
        creationMetadata,
        anchorBlockHeader,
      );

      return {
        note: {
          amount: nullified.amount.toBigInt(),
          owner: nullified.owner,
          randomness: nullified.randomness,
        },
        ownerAddressPreimage: metadata.ownerAddressPreimage,
        masterNullifierHidingKey: metadata.masterNullifierHidingKey,
        hints,
        signature: nullified.signature,
        anchorBlockHashMembershipWitness,
        signerRegistrationWitness,
      };
    }),
  );

  return {
    anchorBlockHeader,
    spentNotes,
    createdNotes: collected.createdNotes,
    deposits: portal?.deposits ?? [],
    withdrawals: collected.withdrawals,
  };
}

/**
 * Resolve the deposit witnesses and the spend metadata of the collected effects, then build the token operation. A
 * resolver is required only when the effects contain what it resolves.
 */
export async function hydrateTokenOperation(
  chain: AnchoredNodeReads,
  args: {
    tokenAddress: AztecAddress;
    teeRegistry: EthAddress;
    anchorBlockHeader: BlockHeader;
    collected: CollectedAccountingEffects;
    resolveSpendMetadata?: SpendMetadataResolver;
    resolveDepositSpendMetadata?: DepositSpendMetadataResolver;
  },
): Promise<TokenOperation> {
  const { collected, resolveSpendMetadata, resolveDepositSpendMetadata } = args;
  const anchorBlockHash = await args.anchorBlockHeader.hash();

  if (collected.deposits.length > 0 && !resolveDepositSpendMetadata) {
    throw new Error(
      `${collected.deposits.length} deposit spend(s) need resolveDepositSpendMetadata, but none was supplied`,
    );
  }
  const deposits: SpentDeposit[] = [];
  for (const spent of collected.deposits) {
    const witness = await chain.getL1ToL2MessageMembershipWitness(anchorBlockHash, spent.messageHash);
    if (!witness) {
      throw new Error(`No L1->L2 membership witness for deposit message ${spent.messageHash}`);
    }
    const [witnessLeafIndex, siblingPath] = witness;
    if (witnessLeafIndex !== spent.inboxIndex) {
      throw new Error(
        `Deposit witness leaf index ${witnessLeafIndex} does not match deposit effect leaf index ${spent.inboxIndex}`,
      );
    }
    const metadata = await resolveDepositSpendMetadata!(spent.recipient);
    deposits.push({
      recipient: spent.recipient,
      recipientAddressPreimage: metadata.ownerAddressPreimage,
      masterNullifierHidingKey: metadata.masterNullifierHidingKey,
      amount: spent.amount,
      sharedSecretSalt: spent.sharedSecretSalt,
      messageLeafIndex: spent.inboxIndex,
      siblingPath: siblingPath.toTuple(),
    });
  }

  if (collected.nullifiedNotes.length > 0 && !resolveSpendMetadata) {
    throw new Error(
      `${collected.nullifiedNotes.length} nullified note(s) need resolveSpendMetadata, but none was supplied`,
    );
  }
  const spendMetadata = await Promise.all(collected.nullifiedNotes.map(nullified => resolveSpendMetadata!(nullified)));

  return await buildTokenOperation(
    chain,
    args.tokenAddress,
    args.teeRegistry,
    args.anchorBlockHeader,
    collected,
    spendMetadata,
    { deposits },
  );
}

const NULLIFICATION_EFFECT_LEN = 14;
const INSERTION_EFFECT_LEN = 6;
const WITHDRAWAL_EFFECT_LEN = 7;
const DEPOSIT_EFFECT_LEN = 7;

// -- Helper functions ------------------------------------------------------------

function parseNullificationEffect(data: Fr[]): NullificationEffectData {
  if (data.length !== NULLIFICATION_EFFECT_LEN) {
    throw new PermanentError(`Expected ${NULLIFICATION_EFFECT_LEN} fields for NullificationEffect, got ${data.length}`);
  }
  return {
    amount: data[2],
    owner: AztecAddress.fromFieldUnsafe(data[3]),
    randomness: data[4],
    storageSlot: data[5],
    provenNoteHash: data[6],
    metadataStage: Number(data[7].toBigInt()),
    metadataMaybeNoteNonce: data[8],
    // Wire order matches Noir `k1_verify::Signature { s_lo, s_hi, r_lo, r_hi }`.
    signature: {
      sLo: data[9],
      sHi: data[10],
      rLo: data[11],
      rHi: data[12],
    },
    creationTxHash: TxHash.fromField(data[13]),
  };
}

function parseInsertionEffect(data: Fr[]): InsertionEffectData {
  if (data.length !== INSERTION_EFFECT_LEN) {
    throw new PermanentError(`Expected ${INSERTION_EFFECT_LEN} fields for InsertionEffect, got ${data.length}`);
  }
  return {
    amount: data[2],
    owner: AztecAddress.fromFieldUnsafe(data[3]),
    randomness: data[4],
    storageSlot: data[5],
  };
}

function parseWithdrawalEffect(data: Fr[]): OutboxWithdrawal {
  if (data.length !== WITHDRAWAL_EFFECT_LEN) {
    throw new PermanentError(`Expected ${WITHDRAWAL_EFFECT_LEN} fields for WithdrawalEffect, got ${data.length}`);
  }
  return {
    executor: EthAddress.fromField(data[2]),
    userPayloadHash: data[3],
    amount: data[4].toBigInt(),
    proverTip: data[5].toBigInt(),
    randomness: data[6],
  };
}

function parseDepositEffect(data: Fr[]): DepositEffectData {
  if (data.length !== DEPOSIT_EFFECT_LEN) {
    throw new PermanentError(`Expected ${DEPOSIT_EFFECT_LEN} fields for DepositEffect, got ${data.length}`);
  }
  return {
    recipient: AztecAddress.fromFieldUnsafe(data[2]),
    amount: data[3].toBigInt(),
    sharedSecretSalt: data[4],
    inboxIndex: data[5].toBigInt(),
    messageHash: data[6],
  };
}

/**
 * Splits notes into three buckets
 *   - `nullifiedNotes`: not squashed nullifications — real spends to sign.
 *   - `createdNotes`: not squashed created notes — real notes that land in the tree.
 *   - `squashedTransientNotes`: squashed note — never gets into the tree. We still need to return it here as token
 *     execution will still need to process it (squashing happens later in kernels) and `load_signature` gets called,
 *     so callers must supply a dummy capsule for each.
 */
function squashTransientPairs(
  nullifiedNotes: NullificationEffectData[],
  createdNotes: NoteData[],
): Pick<CollectedAccountingEffects, 'nullifiedNotes' | 'createdNotes' | 'squashedTransientNotes'> {
  const insertionsByKey = new Map<string, number[]>();
  createdNotes.forEach((note, i) => {
    const key = noteKey(note.owner, note.randomness, note.amount);
    const list = insertionsByKey.get(key) ?? [];
    list.push(i);
    insertionsByKey.set(key, list);
  });
  const squashedInsertionIndices = new Set<number>();
  const remainingNullified: NullificationEffectData[] = [];

  for (const nullified of nullifiedNotes) {
    if (!nullified.creationTxHash.equals(TxHash.zero())) {
      // Settled (prior-tx) note — hydrate normally.
      remainingNullified.push(nullified);
      continue;
    }
    if (nullified.metadataStage !== NoteStage.PENDING_SAME_PHASE) {
      // Cross-phase pending: the note is still inserted into the tree even though it's
      // nullified in this tx. Not squashable. The oxide_token_contract doesn't currently
      // produce this combo (all ops run in a single phase), so this is a guardrail.
      throw new PermanentError(
        `Cannot squash nullification with creationTxHash=ZERO and metadataStage=${nullified.metadataStage}: ` +
          `only PENDING_SAME_PHASE (${NoteStage.PENDING_SAME_PHASE}) is supported`,
      );
    }
    const key = noteKey(nullified.owner, nullified.randomness, nullified.amount.toBigInt());
    const candidates = insertionsByKey.get(key) ?? [];
    const matchIndex = candidates.find(i => !squashedInsertionIndices.has(i));
    if (matchIndex === undefined) {
      throw new PermanentError(
        `Nullification with creationTxHash=ZERO has no matching insertion ` +
          `(owner=${nullified.owner}, randomness=${nullified.randomness})`,
      );
    }
    squashedInsertionIndices.add(matchIndex);
  }

  const remainingCreated: NoteData[] = [];
  const squashedTransientNotes: NoteData[] = [];
  createdNotes.forEach((note, i) => {
    (squashedInsertionIndices.has(i) ? squashedTransientNotes : remainingCreated).push(note);
  });
  return {
    nullifiedNotes: remainingNullified,
    createdNotes: remainingCreated,
    squashedTransientNotes,
  };
}

function noteKey(owner: AztecAddress, randomness: Fr, amount: bigint): string {
  return `${owner.toString()}:${randomness.toString()}${amount}`;
}
