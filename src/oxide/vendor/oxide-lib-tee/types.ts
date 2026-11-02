import { Fr, GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { MIN_TX_BLOB_FIELDS } from '@aztec-labs/blob-lib/encoding';
import {
  ARCHIVE_HEIGHT,
  BLOBS_PER_CHECKPOINT,
  FIELDS_PER_BLOB,
  L1_TO_L2_MSG_TREE_HEIGHT,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_PRIVATE_LOGS_PER_TX,
  NULLIFIER_TREE_HEIGHT,
  PRIVATE_LOG_SIZE_IN_FIELDS,
} from '@aztec-labs/constants';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { padArrayEnd } from '@aztec-labs/foundation/collection';
import { Point as GrumpkinPoint } from '@aztec-labs/foundation/curves/grumpkin';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { type ZodFor, schemas, zodFor } from '@aztec-labs/foundation/schemas';
import type { Tuple } from '@aztec-labs/foundation/serialize';
import { isHex } from '@aztec-labs/foundation/string';
import { MembershipWitness, SiblingPath } from '@aztec-labs/foundation/trees';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { type BlockHash, EthAddress } from '@aztec-labs/stdlib/block';
import { CompleteAddress } from '@aztec-labs/stdlib/contract';
import { PublicKeys } from '@aztec-labs/stdlib/keys';
import { NullifierLeafPreimage, NullifierMembershipWitness } from '@aztec-labs/stdlib/trees';
import { BlockHeader } from '@aztec-labs/stdlib/tx';

import { z } from 'zod4';

import {
  type AccountInstancePreimage,
  AccountInstancePreimageSchema,
  type PasskeyPublicKey,
  type WebAuthnAuth,
} from './account_address.js';
import { P256PublicKey } from './encryption.js';
import type { MigrationSignature } from './migration_signature.js';
import {
  MAX_ACCOUNT_PASSKEYS,
  MAX_FROZEN_DEPOSITS_PER_REFUND,
  MAX_FROZEN_NOTES_PER_REFUND,
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
} from './oxide_constants.gen.js';

export { P256PublicKey } from './encryption.js';

// TODO(alvaro): `schemas.Buffer32` upstream is `z.string().transform(Buffer32.fromString)`. `Buffer32.fromString`
// reads `this.SIZE`, so zod calling it unbound as `effect.transform(...)` makes `this` the effect
// descriptor and the length check always blows up with "Expected NaN characters long". Wrap the
// static call in an arrow so the class context is preserved. Drop this and use `schemas.Buffer32`
// once upstream switches to `Buffer32.SIZE` (or a bound reference).
const buffer32Schema = z
  .string()
  .refine(isHex, 'Not a valid hex string')
  .transform(s => Buffer32.fromString(s));

// ---------------------------------------------------------------------------
// Zod schema helpers used to encode the types below for the enclave RPC.
// Composed with `jsonStringify` (operator) and `jsonParseWithSchema` /
// `parseAsync` (enclave) from `@aztec-labs/foundation/json-rpc`.
// ---------------------------------------------------------------------------

// Checks that an array has less than `max` elements or exactly `max` elements if `exact` is provided.
//
// Without this a crafted request with a huge array of invalid entries would otherwise make Zod build one issue per
// element — an amplification vector that could crash the enclave.
export function boundedArray<T extends z.ZodTypeAny>(
  element: T,
  max: number,
  field: string,
  opts?: { exact?: boolean },
) {
  return z.preprocess(
    value => {
      if (Array.isArray(value) && value.length > max) {
        throw new Error(`${field} has ${value.length} entries, exceeds max ${max}`);
      }
      return value;
    },
    // eslint-disable-next-line no-restricted-syntax -- the guard above rejects oversized input before this runs.
    opts?.exact ? z.array(element).length(max) : z.array(element),
  );
}

const u128Schema = schemas.BigInt.pipe(
  z
    .bigint()
    .min(0n)
    .max(2n ** 128n - 1n),
);

const LEAF_INDEX_BYTES = 32;
const VECTOR_COUNT_BYTES = 4;

function base64CharsFor(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

// Includes "0x"
function hexCharsFor(bytes: number): number {
  return 2 + 2 * bytes;
}

function boundedBytes(expectedBytes: number, maxChars: number, charUnit: string, field: string) {
  return (value: unknown) => {
    if (typeof value === 'string' && value.length > maxChars) {
      throw new Error(`${field} is ${value.length} ${charUnit} chars, exceeds max ${maxChars}`);
    }
    const data = (value as { data?: unknown } | null | undefined)?.data;
    if (Array.isArray(data) && data.length > expectedBytes) {
      throw new Error(`${field} has ${data.length} bytes, exceeds max ${expectedBytes}`);
    }
    return value;
  };
}

function fixedSizeBufferSchema(expectedBytes: number, field: string) {
  return z
    .preprocess(boundedBytes(expectedBytes, base64CharsFor(expectedBytes), 'base64', field), schemas.Buffer)
    .refine(buf => buf.length === expectedBytes, `${field} must be exactly ${expectedBytes} bytes`);
}

function boundedBufferSchema(maxBytes: number, field: string) {
  return z
    .preprocess(boundedBytes(maxBytes, base64CharsFor(maxBytes), 'base64', field), schemas.Buffer)
    .refine(buf => buf.length <= maxBytes, `${field} must be at most ${maxBytes} bytes`);
}

const aztecAddressSchema = (field: string): ZodFor<AztecAddress> =>
  z.preprocess(
    boundedBytes(AztecAddress.SIZE_IN_BYTES, hexCharsFor(AztecAddress.SIZE_IN_BYTES), 'hex', field),
    AztecAddress.schema,
  );

const membershipWitnessSchema = <N extends number>(height: N, field: string) =>
  fixedSizeBufferSchema(LEAF_INDEX_BYTES + height * Fr.SIZE_IN_BYTES, field).transform(buf =>
    MembershipWitness.fromBuffer(buf, height),
  );

const siblingPathSchema = <N extends number>(height: N, field: string) =>
  fixedSizeBufferSchema(VECTOR_COUNT_BYTES + height * Fr.SIZE_IN_BYTES, field)
    .refine(
      buf => buf.length >= VECTOR_COUNT_BYTES && buf.readUInt32BE(0) === height,
      `${field} must declare exactly ${height} entries`,
    )
    .transform(buf => SiblingPath.fromBuffer(buf) as SiblingPath<N>);

export const nullifierMembershipWitnessSchema = z
  .object({
    index: schemas.BigInt,
    leafPreimage: NullifierLeafPreimage.schema,
    siblingPath: siblingPathSchema(NULLIFIER_TREE_HEIGHT, 'nullifierMembershipWitness.siblingPath'),
  })
  .transform(
    ({ index, leafPreimage, siblingPath }) => new NullifierMembershipWitness(index, leafPreimage, siblingPath),
  );

export const archiveMembershipWitnessSchema = membershipWitnessSchema(ARCHIVE_HEIGHT, 'archiveMembershipWitness');

const signerRegistrationWitnessSchema = membershipWitnessSchema(L1_TO_L2_MSG_TREE_HEIGHT, 'signerRegistrationWitness');

// CompleteAddress.schema returns ZodType<never, ...> because its `fromString` is async and
// the inferred output type collapses to `never`. Wrap async parse explicitly so the schema
// produces an actual `CompleteAddress` instance under `parseAsync`. Validation against the
// owner is rerun by the signer in `validateOwnerPreimage`.
const completeAddressSchema = z
  .string()
  .transform(s => CompleteAddress.fromString(s)) as unknown as ZodFor<CompleteAddress>;

// The passkey schemas in `account_address.ts` read hex buffers. The enclave RPC carries buffers as base64
// (`jsonStringify`), so the finalization inputs use these transport variants with the same size limits.
const passkeyPublicKeySchema = (field: string) =>
  zodFor<PasskeyPublicKey>()(
    z.object({
      x: fixedSizeBufferSchema(32, `${field}.x`),
      y: fixedSizeBufferSchema(32, `${field}.y`),
    }),
  );

const webAuthnAssertionSchema = (field: string) =>
  zodFor<WebAuthnAuth>()(
    z.object({
      authenticatorData: fixedSizeBufferSchema(WEBAUTHN_AUTHENTICATOR_DATA_LEN, `${field}.authenticatorData`),
      clientDataJSON: boundedBufferSchema(WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN, `${field}.clientDataJSON`),
      signature: fixedSizeBufferSchema(64, `${field}.signature`),
    }),
  );

const grumpkinPointSchema = (field: string): ZodFor<GrumpkinPoint> =>
  z.preprocess(
    boundedBytes(GrumpkinPoint.SIZE_IN_BYTES, hexCharsFor(GrumpkinPoint.SIZE_IN_BYTES), 'hex', field),
    GrumpkinPoint.schema,
  );

// ---------------------------------------------------------------------------
// Types + their schemas.
// ---------------------------------------------------------------------------

/** Deepest leaf of a block's tx effects tree: a whole checkpoint of minimum-size txs, paired greedily. */
export const MAX_TX_EFFECTS_TREE_DEPTH = Math.ceil(
  Math.log2((BLOBS_PER_CHECKPOINT * FIELDS_PER_BLOB) / MIN_TX_BLOB_FIELDS),
);

/**
 * The effects of a tx as the wallet sends them to the enclave. The enclave does not read the public data writes, the
 * public logs and the contract class logs, so the wallet sends only their category hashes.
 */
export interface TxEffectHintData {
  /** Encoded tx start marker. It holds the revert code and the count of each category. */
  txStartMarker: Fr;
  txHash: Fr;
  transactionFee: Fr;
  noteHashes: Fr[];
  nullifiers: Fr[];
  l2ToL1Msgs: Fr[];
  /** The fields of each private log. */
  privateLogs: Fr[][];
  /** Category hash of the public data writes. */
  publicDataWritesHash: Fr;
  /** Category hash of the public logs. */
  publicLogsHash: Fr;
  /** Category hash of the contract class logs. */
  contractClassLogHash: Fr;
}

export const TxEffectHintDataSchema = zodFor<TxEffectHintData>()(
  z.object({
    txStartMarker: schemas.Fr,
    txHash: schemas.Fr,
    transactionFee: schemas.Fr,
    noteHashes: boundedArray(schemas.Fr, MAX_NOTE_HASHES_PER_TX, 'noteHashes'),
    nullifiers: boundedArray(schemas.Fr, MAX_NULLIFIERS_PER_TX, 'nullifiers'),
    l2ToL1Msgs: boundedArray(schemas.Fr, MAX_L2_TO_L1_MSGS_PER_TX, 'l2ToL1Msgs'),
    privateLogs: boundedArray(
      boundedArray(schemas.Fr, PRIVATE_LOG_SIZE_IN_FIELDS, 'privateLog'),
      MAX_PRIVATE_LOGS_PER_TX,
      'privateLogs',
    ),
    publicDataWritesHash: schemas.Fr,
    publicLogsHash: schemas.Fr,
    contractClassLogHash: schemas.Fr,
  }),
);

/** Hints proving that a tx with the given effects is a leaf of the tx block's tx effects tree. */
export interface TxEffectsHints {
  /** Header of the block containing the target tx. */
  txBlockHeader: BlockHeader;
  /** Effects of the tx. */
  txEffect: TxEffectHintData;
  /** Index of the tx's leaf at its own depth of the unbalanced tx effects tree. */
  leafIndex: bigint;
  /** Sibling path from the leaf to `txBlockHeader.txEffectsTreeRoot`, leaf level first. */
  siblingPath: Fr[];
}

export const TxEffectsHintsSchema = zodFor<TxEffectsHints>()(
  z.object({
    txBlockHeader: BlockHeader.schema,
    txEffect: TxEffectHintDataSchema,
    leafIndex: schemas.BigInt,
    siblingPath: boundedArray(schemas.Fr, MAX_TX_EFFECTS_TREE_DEPTH, 'siblingPath'),
  }),
);

/** Relation of the tx block to the anchor block, carrying the proof material that relation requires. */
export type TxBlockAnchorRelation =
  | { kind: 'txBlockIsAnchor' }
  | {
      kind: 'txBlockIsAncestorOfAnchor';
      /** Merkle proof that the tx block's hash is a leaf in the anchor block's `lastArchive`. */
      archiveMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
    };

/** Hints for proving that a tx's effects are in the anchor block or one of its ancestors. */
export interface TxEffectsAtAnchorHints {
  anchorRelation: TxBlockAnchorRelation;
  txEffectsHints: TxEffectsHints;
}

export const TxEffectsAtAnchorHintsSchema = zodFor<TxEffectsAtAnchorHints>()(
  z.object({
    anchorRelation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('txBlockIsAnchor') }),
      z.object({
        kind: z.literal('txBlockIsAncestorOfAnchor'),
        archiveMembershipWitness: archiveMembershipWitnessSchema,
      }),
    ]),
    txEffectsHints: TxEffectsHintsSchema,
  }),
);

/** Hints for proving that a tx's effects are in a block whose hash is a leaf in some archive root.
 *  The archive root itself is supplied by the consumer (e.g. `WithdrawalFinalizationInput.archiveRoot`);
 *  the witness here is checked against that root. */
export interface ArchivedTxEffectsHints {
  /**
   * Merkle proof that the tx block's hash is a leaf in the consumer-supplied archive root.
   */
  archiveMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;

  txEffectsHints: TxEffectsHints;
}

export const ArchivedTxEffectsHintsSchema = zodFor<ArchivedTxEffectsHints>()(
  z.object({
    archiveMembershipWitness: archiveMembershipWitnessSchema,
    txEffectsHints: TxEffectsHintsSchema,
  }),
);

/**
 * Secp256k1 ECDSA signature `(r, s)` split into two big-endian 128-bit halves apiece, matching
 * `k1_verify::Signature` in `oxide_token_contract`. Each half is carried as an `Fr` whose value
 * is bounded to `[0, 2^128)`, so it serialises into one Noir `u128` field per slot.
 */
export interface K1NoteSignature {
  sLo: Fr;
  sHi: Fr;
  rLo: Fr;
  rHi: Fr;
}

export const K1NoteSignatureSchema = zodFor<K1NoteSignature>()(
  z.object({
    sLo: schemas.Fr,
    sHi: schemas.Fr,
    rLo: schemas.Fr,
    rHi: schemas.Fr,
  }),
);

/**
 * Grumpkin-Schnorr-Poseidon2 signature `(s, e)` split into two big-endian 128-bit halves apiece, matching the
 * `(EmbeddedCurveScalar, EmbeddedCurveScalar)` pair the `noir-lang/schnorr` verifier consumes.
 */
export interface GrumpkinPoseidonSignature {
  sLo: Fr;
  sHi: Fr;
  eLo: Fr;
  eHi: Fr;
}

export const GrumpkinPoseidonSignatureSchema = zodFor<GrumpkinPoseidonSignature>()(
  z.object({
    sLo: schemas.Fr,
    sHi: schemas.Fr,
    eLo: schemas.Fr,
    eHi: schemas.Fr,
  }),
);

/**
 * A {@link MigrationSignature}, as `jsonStringify` writes it. A wallet restores a saved signature with
 * `jsonParseWithSchema(text, MigrationSignatureSchema)`.
 */
export const MigrationSignatureSchema = zodFor<MigrationSignature>()(
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('passkey'),
      passkey: passkeyPublicKeySchema('migrationSignature.passkey'),
      passkeySet: boundedArray(schemas.Fr, MAX_ACCOUNT_PASSKEYS, 'migrationSignature.passkeySet', { exact: true }),
      webauthn: webAuthnAssertionSchema('migrationSignature.webauthn'),
    }),
    z.object({
      kind: z.literal('fallbackKey'),
      fbpkM: grumpkinPointSchema('migrationSignature.fbpkM'),
      fallbackSignature: GrumpkinPoseidonSignatureSchema,
    }),
  ]),
);

export interface NoteData {
  amount: bigint;
  owner: AztecAddress;
  randomness: Fr;
}

export const NoteDataSchema = zodFor<NoteData>()(
  z.object({
    amount: u128Schema,
    owner: aztecAddressSchema('note.owner'),
    randomness: schemas.Fr,
  }),
);

export interface SpendValidationData {
  note: NoteData;
  ownerAddressPreimage: CompleteAddress;
  masterNullifierHidingKey: GrumpkinScalar;
  hints: TxEffectsAtAnchorHints;
  signature: K1NoteSignature;
  anchorBlockHashMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  /** Proof that the `TeeRegistry` registration message of the note's signer is in the anchor block's L1->L2 tree. */
  signerRegistrationWitness: MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>;
}

export const SpendValidationDataSchema = zodFor<SpendValidationData>()(
  z.object({
    note: NoteDataSchema,
    ownerAddressPreimage: completeAddressSchema,
    masterNullifierHidingKey: GrumpkinScalar.schema,
    hints: TxEffectsAtAnchorHintsSchema,
    signature: K1NoteSignatureSchema,
    anchorBlockHashMembershipWitness: archiveMembershipWitnessSchema,
    signerRegistrationWitness: signerRegistrationWitnessSchema,
  }),
);

export interface SpentDeposit {
  recipient: AztecAddress;
  recipientAddressPreimage: CompleteAddress;
  masterNullifierHidingKey: GrumpkinScalar;
  amount: bigint;
  sharedSecretSalt: Fr;
  messageLeafIndex: bigint;
  siblingPath: Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>;
}

export const SpentDepositSchema = zodFor<SpentDeposit>()(
  z.object({
    recipient: aztecAddressSchema('spentDeposit.recipient'),
    recipientAddressPreimage: completeAddressSchema,
    masterNullifierHidingKey: GrumpkinScalar.schema,
    amount: u128Schema,
    sharedSecretSalt: schemas.Fr,
    messageLeafIndex: schemas.BigInt,
    siblingPath: boundedArray(schemas.Fr, L1_TO_L2_MSG_TREE_HEIGHT, 'siblingPath', { exact: true }).transform(
      arr => arr as Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>,
    ),
  }),
);

/**
 * An L2 -> L1 withdrawal the TEE attests the operation emitted.
 * The content hash is computed from these values.
 */
export interface OutboxWithdrawal {
  executor: EthAddress;
  userPayloadHash: Fr;
  amount: bigint;
  proverTip: bigint;
  randomness: Fr;
}

export const OutboxWithdrawalSchema = zodFor<OutboxWithdrawal>()(
  z.object({
    executor: EthAddress.schema,
    userPayloadHash: schemas.Fr,
    amount: u128Schema,
    proverTip: u128Schema,
    randomness: schemas.Fr,
  }),
);

/** Info that is not in the block header and that the enclave needs to be able to work with multiple tokens/portals. */
export class PortalLink {
  private constructor(
    public readonly l1Portal: EthAddress,
    public readonly l2Token: AztecAddress,
    public readonly teeRegistry: EthAddress,
  ) {}

  static from({
    l1Portal,
    l2Token,
    teeRegistry,
  }: {
    l1Portal: EthAddress;
    l2Token: AztecAddress;
    teeRegistry: EthAddress;
  }): PortalLink {
    return new PortalLink(l1Portal, l2Token, teeRegistry);
  }

  static readonly schema: ZodFor<PortalLink> = z
    .object({
      l1Portal: EthAddress.schema,
      l2Token: aztecAddressSchema('portalLink.l2Token'),
      teeRegistry: EthAddress.schema,
    })
    .transform(o => PortalLink.from(o));

  toBuffer(): Buffer {
    return Buffer.concat([this.l1Portal.toBuffer(), this.l2Token.toBuffer(), this.teeRegistry.toBuffer()]);
  }

  equals(other: PortalLink): boolean {
    return (
      this.l1Portal.equals(other.l1Portal) &&
      this.l2Token.equals(other.l2Token) &&
      this.teeRegistry.equals(other.teeRegistry)
    );
  }
}

/**
 * Just like PortalLink but with extra info sourced from the block header. Optionally disclosed in plaintext to allow
 * enclave operators to filter based on its info.
 */
export interface PortalDomain {
  l1Portal: EthAddress;
  l2Token: AztecAddress;
  teeRegistry: EthAddress;
  l1ChainId: bigint;
  rollupVersion: bigint;
}

export const PortalDomainSchema = zodFor<PortalDomain>()(
  z.object({
    l1Portal: EthAddress.schema,
    l2Token: aztecAddressSchema('portalDomain.l2Token'),
    teeRegistry: EthAddress.schema,
    l1ChainId: schemas.BigInt,
    rollupVersion: schemas.BigInt,
  }),
);

export interface TokenOperation {
  anchorBlockHeader: BlockHeader;
  spentNotes: SpendValidationData[];
  createdNotes: NoteData[];
  deposits: SpentDeposit[];
  withdrawals: OutboxWithdrawal[];
}

export const TokenOperationSchema = zodFor<TokenOperation>()(
  z.object({
    anchorBlockHeader: BlockHeader.schema,
    spentNotes: boundedArray(SpendValidationDataSchema, MAX_NULLIFIERS_PER_TX, 'spentNotes'),
    createdNotes: boundedArray(NoteDataSchema, MAX_NOTE_HASHES_PER_TX, 'createdNotes'),
    deposits: boundedArray(SpentDepositSchema, MAX_NULLIFIERS_PER_TX, 'deposits'),
    withdrawals: boundedArray(OutboxWithdrawalSchema, MAX_L2_TO_L1_MSGS_PER_TX, 'withdrawals'),
  }),
);

/**
 * Output of `signTokenOperation`: one per-note Schnorr signature per created note (in
 * `signatures`), one per-withdrawal Schnorr signature per L2->L1 withdrawal (in `withdrawalSignatures`), and the
 * three field arrays the L2 contract needs in DA capsules / the L1 finalizer needs to re-bind
 * (`requiredNullifiers`, `teeNotes`, `withdrawalMessageHashes`).
 */
export interface SignTokenOperationOutput {
  signatures: K1NoteSignature[];
  withdrawalSignatures: K1NoteSignature[];
  requiredNullifiers: Fr[];
  teeNotes: Fr[];
  withdrawalMessageHashes: Fr[];
}

export const SignTokenOperationOutputSchema = zodFor<SignTokenOperationOutput>()(
  z.object({
    signatures: z.array(K1NoteSignatureSchema),
    withdrawalSignatures: z.array(K1NoteSignatureSchema),
    requiredNullifiers: z.array(schemas.Fr),
    teeNotes: z.array(schemas.Fr),
    withdrawalMessageHashes: z.array(schemas.Fr),
  }),
);

export interface WithdrawalFinalizationInput {
  archiveRoot: Fr;
  hints: ArchivedTxEffectsHints;
  withdrawalSignature: K1NoteSignature;
  /** L2->L1 message hash of the withdrawal being finalized. */
  messageHash: Fr;
  // Path to check that the tx.anchorBlockHash in metadata is a member of archive root
  anchorBlockHashMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  /**
   * Proof that the `TeeRegistry` registration message of the initiation tx's signer is in the L1->L2 tree of
   * `hints.txBlockHeader`, which `verifyAndDecodeArchivedTxEffects` authenticates against `archiveRoot`.
   */
  signerRegistrationWitness: MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>;
}

export const WithdrawalFinalizationInputSchema = zodFor<WithdrawalFinalizationInput>()(
  z.object({
    archiveRoot: schemas.Fr,
    hints: ArchivedTxEffectsHintsSchema,
    withdrawalSignature: K1NoteSignatureSchema,
    messageHash: schemas.Fr,
    anchorBlockHashMembershipWitness: archiveMembershipWitnessSchema,
    signerRegistrationWitness: signerRegistrationWitnessSchema,
  }),
);

export interface WithdrawalFinalizationOutput {
  /**
   * Opaque 32-byte withdrawal identifier L1 stores in `$isWithdrawalSpent`. Derived as
   * `sha256(creation_tx_hash || message_hash)`, so it uniquely identifies this withdrawal
   * finalization independently of the outbox leaf used to prove message membership.
   */
  withdrawalId: Buffer32;
  /** 32-byte ECDSA preimage hash `OxidePortal.withdraw` recomputes. */
  finalDigest: Buffer32;
  /** ECDSA signature the portal recovers. */
  signature: Signature;
}

export const WithdrawalFinalizationOutputSchema = zodFor<WithdrawalFinalizationOutput>()(
  z.object({
    withdrawalId: buffer32Schema,
    finalDigest: buffer32Schema,
    signature: Signature.schema,
  }),
);

export interface FrozenNotesRefundFinalizationInput {
  frozenArchiveRoot: Fr;
  frozenTip: BlockHeader;
  frozenTipMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  notes: SpendValidationData[];
  executor: EthAddress;
  userPayloadHash: Fr;
  lowNullifierMembershipWitnesses: NullifierMembershipWitness[];
  owner: AztecAddress;
  ownerPublicKeys: PublicKeys;
  ownerInstance: AccountInstancePreimage;
  migrationSignature: MigrationSignature;
}

export const FrozenNotesRefundFinalizationInputSchema = zodFor<FrozenNotesRefundFinalizationInput>()(
  z.object({
    frozenArchiveRoot: schemas.Fr,
    frozenTip: BlockHeader.schema,
    frozenTipMembershipWitness: archiveMembershipWitnessSchema,
    notes: boundedArray(SpendValidationDataSchema, MAX_FROZEN_NOTES_PER_REFUND, 'notes'),
    executor: EthAddress.schema,
    userPayloadHash: schemas.Fr,
    lowNullifierMembershipWitnesses: boundedArray(
      nullifierMembershipWitnessSchema,
      MAX_FROZEN_NOTES_PER_REFUND,
      'lowNullifierMembershipWitnesses',
    ),
    owner: aztecAddressSchema('owner'),
    ownerPublicKeys: PublicKeys.schema,
    ownerInstance: AccountInstancePreimageSchema,
    migrationSignature: MigrationSignatureSchema,
  }),
);

export interface FrozenNotesRefundFinalizationOutput {
  /** Active source nullifiers to pass to `OxidePortal.refundFrozenNotes`. */
  nullifiers: Fr[];
  /** Public inputs signed for L1 and passed to the Noir verifier. */
  publicInputs: Fr[];
  /** 32-byte ECDSA preimage hash `OxidePortal.refundFrozenNotes` recomputes. */
  finalDigest: Buffer32;
  /** ECDSA signature the portal recovers. */
  signature: Signature;
}

export const FrozenNotesRefundFinalizationOutputSchema = zodFor<FrozenNotesRefundFinalizationOutput>()(
  z.object({
    nullifiers: z.array(schemas.Fr),
    publicInputs: z.array(schemas.Fr),
    finalDigest: buffer32Schema,
    signature: Signature.schema,
  }),
);

export interface FrozenDeposit {
  amount: bigint;
  sharedSecretSalt: Fr;
  messageMembershipWitness: MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>;
  lowNullifierMembershipWitness: NullifierMembershipWitness;
}

export const FrozenDepositSchema = zodFor<FrozenDeposit>()(
  z.object({
    amount: u128Schema,
    sharedSecretSalt: schemas.Fr,
    messageMembershipWitness: membershipWitnessSchema(L1_TO_L2_MSG_TREE_HEIGHT, 'messageMembershipWitness'),
    lowNullifierMembershipWitness: nullifierMembershipWitnessSchema,
  }),
);

export interface FrozenDepositsRefundFinalizationInput {
  frozenArchiveRoot: Fr;
  frozenTip: BlockHeader;
  frozenTipMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  executor: EthAddress;
  userPayloadHash: Fr;
  l2Recipient: AztecAddress;
  l2RecipientPublicKeys: PublicKeys;
  l2RecipientInstance: AccountInstancePreimage;
  l2RecipientNhkM: GrumpkinScalar;
  deposits: FrozenDeposit[];
  migrationSignature: MigrationSignature;
}

export const FrozenDepositsRefundFinalizationInputSchema = zodFor<FrozenDepositsRefundFinalizationInput>()(
  z.object({
    frozenArchiveRoot: schemas.Fr,
    frozenTip: BlockHeader.schema,
    frozenTipMembershipWitness: archiveMembershipWitnessSchema,
    executor: EthAddress.schema,
    userPayloadHash: schemas.Fr,
    l2Recipient: aztecAddressSchema('l2Recipient'),
    l2RecipientPublicKeys: PublicKeys.schema,
    l2RecipientInstance: AccountInstancePreimageSchema,
    l2RecipientNhkM: GrumpkinScalar.schema,
    deposits: boundedArray(FrozenDepositSchema, MAX_FROZEN_DEPOSITS_PER_REFUND, 'deposits'),
    migrationSignature: MigrationSignatureSchema,
  }),
);

export interface FrozenDepositsRefundFinalizationOutput {
  /**
   * The siloed deposit-message nullifiers, in the order of the deposits, to pass to `OxidePortal.refundFrozenDeposits`.
   * The L1 portal marks them spent and the verifier carries them in public inputs.
   */
  nullifiers: Fr[];
  /** The sum of the deposit amounts: the refund amount. */
  amount: bigint;
  /** Public inputs the L1 verifier receives. */
  publicInputs: Fr[];
  /** 32-byte ECDSA preimage hash `OxidePortal.refundFrozenDeposits` recomputes. */
  finalDigest: Buffer32;
  /** ECDSA signature the portal recovers. */
  signature: Signature;
}

export const FrozenDepositsRefundFinalizationOutputSchema = zodFor<FrozenDepositsRefundFinalizationOutput>()(
  z.object({
    nullifiers: z.array(schemas.Fr),
    amount: u128Schema,
    publicInputs: z.array(schemas.Fr),
    finalDigest: buffer32Schema,
    signature: Signature.schema,
  }),
);

export interface UnprocessedDepositRefundFinalizationInput {
  frozenArchiveRoot: Fr;
  frozenTip: BlockHeader;
  frozenTipMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  sharedSecretSalt: Fr;
  l2Recipient: AztecAddress;
  l2RecipientPublicKeys: PublicKeys;
  l2RecipientInstance: AccountInstancePreimage;
  l2RecipientNhkM: GrumpkinScalar;
  messageLeafIndex: Fr;
  migrationSignature: MigrationSignature;
}

export const UnprocessedDepositRefundFinalizationInputSchema = zodFor<UnprocessedDepositRefundFinalizationInput>()(
  z.object({
    frozenArchiveRoot: schemas.Fr,
    frozenTip: BlockHeader.schema,
    frozenTipMembershipWitness: archiveMembershipWitnessSchema,
    amount: u128Schema,
    executor: EthAddress.schema,
    userPayloadHash: schemas.Fr,
    sharedSecretSalt: schemas.Fr,
    l2Recipient: aztecAddressSchema('l2Recipient'),
    l2RecipientPublicKeys: PublicKeys.schema,
    l2RecipientInstance: AccountInstancePreimageSchema,
    l2RecipientNhkM: GrumpkinScalar.schema,
    messageLeafIndex: schemas.Fr,
    migrationSignature: MigrationSignatureSchema,
  }),
);

export interface UnprocessedDepositRefundFinalizationOutput {
  messageHash: Fr;
  siloedNullifier: Fr;
  publicInputs: Fr[];
  finalDigest: Buffer32;
  signature: Signature;
}

export const UnprocessedDepositRefundFinalizationOutputSchema = zodFor<UnprocessedDepositRefundFinalizationOutput>()(
  z.object({
    messageHash: schemas.Fr,
    siloedNullifier: schemas.Fr,
    publicInputs: z.array(schemas.Fr),
    finalDigest: buffer32Schema,
    signature: Signature.schema,
  }),
);

/** Noir `BoundedVec` layout: zero-padded storage, then the element count */
function boundedVecFields(items: Fr[], maxLen: number): Fr[] {
  return [
    ...padArrayEnd(items, Fr.zero(), maxLen, `Set of ${items.length} exceeds max ${maxLen}`),
    new Fr(items.length),
  ];
}

export class TeeSignedData {
  constructor(
    public readonly domain: number,
    public readonly anchorBlockHash: BlockHash,
    public readonly tokenAddress: AztecAddress,
    public readonly l1Portal: EthAddress,
    public readonly teeRegistry: EthAddress,
    public readonly signedCommitment: Fr,
    public readonly requiredNullifiers: Fr[],
    public readonly committedSiloedNoteHashes: Fr[],
    public readonly withdrawalMessageHashes: Fr[],
  ) {}

  toFields(): Fr[] {
    return [
      new Fr(this.domain),
      this.anchorBlockHash.toFr(),
      this.tokenAddress.toField(),
      this.l1Portal.toField(),
      this.teeRegistry.toField(),
      this.signedCommitment,
      ...boundedVecFields(this.requiredNullifiers, MAX_NULLIFIERS_PER_TX),
      ...boundedVecFields(this.committedSiloedNoteHashes, MAX_NOTE_HASHES_PER_TX),
      ...boundedVecFields(this.withdrawalMessageHashes, MAX_L2_TO_L1_MSGS_PER_TX),
    ];
  }
}

export interface SecpPublicKey {
  x: Buffer32;
  y: Buffer32;
}

export function splitSecpCoord(coord: Buffer32): { hi: Fr; lo: Fr } {
  const buf = coord.toBuffer();
  const hiBuf = Buffer.alloc(32);
  buf.copy(hiBuf, 16, 0, 16);
  const loBuf = Buffer.alloc(32);
  buf.copy(loBuf, 16, 16, 32);
  return { hi: Fr.fromBuffer(hiBuf), lo: Fr.fromBuffer(loBuf) };
}
/** The keys of one enclave. */
export interface EnclaveIdentity {
  readonly publicKey: SecpPublicKey;
  readonly ethAddress: EthAddress;
  readonly encryptionPublicKey: P256PublicKey;
}

export interface TeeSigner {
  signTokenOperation(operation: TokenOperation): Promise<SignTokenOperationOutput>;
  signWithdrawalFinalization(input: WithdrawalFinalizationInput): Promise<WithdrawalFinalizationOutput>;
  signFrozenNotesRefundFinalization(
    input: FrozenNotesRefundFinalizationInput,
  ): Promise<FrozenNotesRefundFinalizationOutput>;
  signFrozenDepositsRefundFinalization(
    input: FrozenDepositsRefundFinalizationInput,
  ): Promise<FrozenDepositsRefundFinalizationOutput>;
  signUnprocessedDepositRefundFinalization(
    input: UnprocessedDepositRefundFinalizationInput,
  ): Promise<UnprocessedDepositRefundFinalizationOutput>;
}

export class TEEMetadata {
  constructor(
    public readonly pubKeyXHi: Fr,
    public readonly pubKeyXLo: Fr,
    public readonly pubKeyYHi: Fr,
    public readonly pubKeyYLo: Fr,
    public readonly anchorBlockHash: BlockHash,
    /** Leaf index of the signer's `TeeRegistry` registration. */
    public readonly registrationLeafIndex: Fr,
  ) {}

  static fromPublicKey(publicKey: SecpPublicKey, anchorBlockHash: BlockHash, registrationLeafIndex: Fr): TEEMetadata {
    const x = splitSecpCoord(publicKey.x);
    const y = splitSecpCoord(publicKey.y);
    return new TEEMetadata(x.hi, x.lo, y.hi, y.lo, anchorBlockHash, registrationLeafIndex);
  }

  /** Reassemble the enclave's k1 pubkey from the four `(hi, lo)` field halves. Inverse of
   *  `fromPublicKey`. */
  publicKey(): SecpPublicKey {
    return {
      x: joinSecpCoord(this.pubKeyXHi, this.pubKeyXLo),
      y: joinSecpCoord(this.pubKeyYHi, this.pubKeyYLo),
    };
  }

  toFields(): Fr[] {
    return [
      this.pubKeyXHi,
      this.pubKeyXLo,
      this.pubKeyYHi,
      this.pubKeyYLo,
      this.anchorBlockHash.toFr(),
      this.registrationLeafIndex,
    ];
  }
}

function joinSecpCoord(hi: Fr, lo: Fr): Buffer32 {
  const hiBuf = hi.toBuffer().subarray(16, 32);
  const loBuf = lo.toBuffer().subarray(16, 32);
  return Buffer32.fromBuffer(Buffer.concat([hiBuf, loBuf]));
}
