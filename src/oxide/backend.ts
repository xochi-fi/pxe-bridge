import { readFileSync } from "node:fs";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { BatchCall, Contract, type ContractFunctionInteraction, toSimulateOptions } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { Tx, TxHash } from "@aztec-labs/aztec.js/tx";
import type { Wallet } from "@aztec-labs/aztec.js/wallet";
import { sha256ToField } from "@aztec-labs/foundation/crypto/sha256";
import { loadContractArtifact, type ContractArtifact } from "@aztec-labs/stdlib/abi";
import { EthAddress, type BlockHash } from "@aztec-labs/stdlib/block";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { Gas, GasFees, ManaUsageEstimate } from "@aztec-labs/stdlib/gas";
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash";
import { FEE_JUICE_BALANCES_SLOT } from "@aztec-labs/constants";
import { ProtocolContractAddress } from "@aztec-labs/protocol-contracts";
import { deriveAccountKeys } from "../aztec-client.js";
import type { NodeObservation } from "../settlement.js";
import {
  buildNoteSignatureCapsules,
  buildPublishDaCapsules,
  buildSeedCapsule,
  buildStrictModeCapsule,
} from "./vendor/oxide-client/capsules.js";
import { FleetSigner } from "./vendor/oxide-client/fleet_signer.js";
import { buildSpendMetadata } from "./vendor/oxide-client/spend_metadata.js";
import {
  collectAccountingEffects,
  hydrateTokenOperation,
  type CollectedAccountingEffects,
  type SpendMetadata,
} from "./vendor/oxide-client/token_operations_collector.js";
import {
  isOxideTokenLockedToArtifact,
  registerOxideTokenWithArtifact,
} from "./vendor/oxide-client/token_registration.js";
import type { RegisteredSignTokenOperationOutput } from "./vendor/oxide-client/types.js";
import { computeSiloedNoteHash } from "./vendor/oxide-lib-tee/hash.js";
import { ethAddressFromSecpPublicKey } from "./vendor/oxide-lib/attestation/user_data.js";
import type { OxideTokenImmutables } from "./vendor/oxide-lib/token_immutables.js";
import type { TokenOperation } from "./vendor/oxide-lib/types.js";
import type { BlockHeader, Capsule, ExecutionPayload } from "@aztec-labs/stdlib/tx";
import { OxideFleetRegistry, type OxideL1Reader } from "./enclave.js";
import { oxideFeeLimit, type OxideSendEvidence } from "./operation.js";
import { OXIDE_V6_MAINNET, type OxidePins } from "./pins.js";
import {
  type OxideBackend,
  type OxidePayout,
  type OxideProvenTx,
  type OxideSigned,
  type OxideSimulation,
  type OxideSized,
  type TokenOperationSummary,
} from "./sender.js";
import { decodeTxBytes, identifyTx, type TxIdentity } from "../tx-identity.js";

/**
 * The real `OxideBackend`: Oxide's own send pipeline (upstream
 * `oxide-client/l2_operations.ts` `submit()`, transfer only) split at the
 * points the journal needs, on the bridge's PXE and standard Schnorr account.
 *
 * Differences from upstream `submit()`, each deliberate:
 * - prove and send are separate: the proven tx is journaled before it is sent;
 * - the final batch (strict mode, TEE capsules) is simulated once more to size
 *   an explicit gas limit, instead of the client's network-maximum default,
 *   which made the node demand ~22 AZTEC of balance per tx (spike, #84);
 * - the TokenOperation is checked against the payout before the enclave sees
 *   it (`payoutNoteIndex` in sender.ts), and the enclave's answer is checked
 *   against the notes it was asked to sign;
 * - the token's immutables come from the pinned manifest, never from
 *   `readOxideTokenImmutables`.
 */

/** Gas limit headroom over the simulated final batch, in basis points. */
export const DEFAULT_GAS_MARGIN_BPS = 2_000n;
/** Multiplier on the worst predicted min fee per gas. A ceiling, not a charge. */
export const DEFAULT_FEE_MULTIPLIER = 2n;

/** Explicit gas settings for one send. */
export interface OxideGasSettings {
  gasLimits: { daGas: number; l2Gas: number };
  teardownGasLimits: { daGas: number; l2Gas: number };
  maxFeesPerGas: { feePerDaGas: bigint; feePerL2Gas: bigint };
}

/**
 * Explicit gas settings from the simulation. The node admits a tx only if its
 * fee payer holds `gasLimits x maxFeesPerGas`, so both are sized: limits from
 * what the batch used plus a margin, fees from the worst predicted slot.
 */
export function oxideGasSettings(
  used: { daGas: number; l2Gas: number },
  teardown: { daGas: number; l2Gas: number },
  worstFees: { feePerDaGas: bigint; feePerL2Gas: bigint },
  options: { gasMarginBps?: bigint; feeMultiplier?: bigint } = {},
): OxideGasSettings {
  const margin = options.gasMarginBps ?? DEFAULT_GAS_MARGIN_BPS;
  const multiplier = options.feeMultiplier ?? DEFAULT_FEE_MULTIPLIER;
  if (margin < 0n || multiplier < 1n) throw new Error("gas margin must be >= 0 and fee multiplier >= 1");
  const pad = (gas: number) => Number((BigInt(gas) * (10_000n + margin) + 9_999n) / 10_000n);
  return {
    gasLimits: { daGas: pad(used.daGas), l2Gas: pad(used.l2Gas) },
    teardownGasLimits: { daGas: pad(teardown.daGas), l2Gas: pad(teardown.l2Gas) },
    maxFeesPerGas: {
      feePerDaGas: worstFees.feePerDaGas * multiplier,
      feePerL2Gas: worstFees.feePerL2Gas * multiplier,
    },
  };
}

const ORDER_FINGERPRINT_META_TAG = sha256ToField([Buffer.from("pxe-bridge/oxide-order-fingerprint/v1")]);

/**
 * The transfer's private `meta` (delivered encrypted to recipient and sender
 * only): a version tag, then the 32-byte order fingerprint as two 128-bit
 * halves (a bytes32 does not fit one field), then zeros.
 */
export function orderFingerprintMeta(orderFingerprint: string, metaLen: number): Fr[] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(orderFingerprint)) throw new Error("orderFingerprint must be 32-byte hex");
  if (metaLen < 3) throw new Error(`transfer meta has ${metaLen} fields; the order fingerprint needs 3`);
  const hex = orderFingerprint.slice(2);
  const meta = [ORDER_FINGERPRINT_META_TAG, new Fr(BigInt(`0x${hex.slice(0, 32)}`)), new Fr(BigInt(`0x${hex.slice(32)}`))];
  while (meta.length < metaLen) meta.push(Fr.ZERO);
  return meta;
}

/** `transfer(meta)` length from the artifact; upstream `getTransferMetaLen`. */
function transferMetaLen(artifact: ContractArtifact): number {
  const meta = artifact.functions.find((f) => f.name === "transfer")?.parameters.find((p) => p.name === "meta");
  if (meta?.type.kind !== "array") throw new Error("transfer(meta) array parameter not found in the OxideToken artifact");
  return meta.type.length;
}

/** The pinned immutables in the shape the vendored code takes. */
export function pinnedTokenImmutables(pins: OxidePins = OXIDE_V6_MAINNET): OxideTokenImmutables {
  const m = pins.bridge.l2TokenImmutables;
  return {
    portal: EthAddress.fromString(m.portal),
    teeRegistry: EthAddress.fromString(m.teeRegistry),
    name: m.name,
    symbol: m.symbol,
    decimals: m.decimals,
    maxNoteAmount: m.maxNoteAmount,
  };
}

/** Where `npm run build:oxide-token` writes the artifact, relative to the repository root. */
export const OXIDE_TOKEN_ARTIFACT = "contracts/oxide/oxide_token_contract/target/oxide_token_contract-OxideToken.json";

/**
 * Loads the compiled OxideToken artifact (`PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT`)
 * and refuses one whose class is not the deployed OXDAI class. Not committed:
 * ~4 MB, built from the Noir sources vendored in contracts/oxide by
 * `npm run build:oxide-token` (VENDORED.md).
 */
export async function loadOxideTokenArtifact(path: string, pins: OxidePins = OXIDE_V6_MAINNET): Promise<ContractArtifact> {
  const artifact = loadContractArtifact(JSON.parse(readFileSync(path, "utf8")));
  const klass = await getContractClassFromArtifact(artifact);
  if (klass.id.toString() !== pins.oxideTokenClassId) {
    throw new Error(`OxideToken artifact ${path} has class ${klass.id.toString()}, not the pinned ${pins.oxideTokenClassId}`);
  }
  return artifact;
}

/**
 * PXE setup for the OXDAI token: checks the deployed instance is locked to the
 * pinned class, registers it with the wallet under the pinned immutables (which
 * must derive its address) and runs `store_immutables`. Idempotent.
 */
export async function registerOxideToken(
  wallet: Wallet,
  node: AztecNode,
  artifact: ContractArtifact,
  pins: OxidePins = OXIDE_V6_MAINNET,
): Promise<Contract> {
  const address = AztecAddress.fromStringUnsafe(pins.bridge.l2Token);
  if (!(await isOxideTokenLockedToArtifact(node, artifact, address))) {
    throw new Error(`OXDAI ${address.toString()} is not published and locked to the pinned OxideToken class`);
  }
  return registerOxideTokenWithArtifact(wallet, artifact, pinnedTokenImmutables(pins), address);
}

/**
 * Records a landed L1 deposit (its `Deposit` event's inbox index and net
 * amount) into this PXE so the account's next transfer can spend it. A utility
 * call: no tx, no gas. Fails until the L1->L2 message is settled; re-storing an
 * index the contract already holds is refused by the contract.
 */
export async function storeOxideDeposit(
  token: Contract,
  deposit: { inboxIndex: bigint; amount: bigint; recipient: AztecAddress; sharedSecretSalt: Fr },
): Promise<void> {
  await token.methods["store_deposit"]!(new Fr(deposit.inboxIndex), deposit.amount, deposit.recipient, deposit.sharedSecretSalt).simulate({
    from: deposit.recipient,
  });
}

interface Simulated {
  call: ContractFunctionInteraction;
  seed: Capsule;
  collected: CollectedAccountingEffects;
  tokenOperation: TokenOperation;
  anchor: BlockHeader;
}

interface Signed extends Simulated {
  signOutput: RegisteredSignTokenOperationOutput;
}

interface Sized extends Signed {
  payload: ExecutionPayload;
  anchorBlockHash: BlockHash;
  gas: OxideGasSettings;
}

/** The BaseWallet internals proving goes through; checked at construction so an SDK change fails closed. */
interface ProvingInternals {
  completeFeeOptions(config: { from: AztecAddress; feePayer: AztecAddress | undefined; gasSettings: unknown }): Promise<unknown>;
  createTxExecutionRequestFromPayloadAndFee(payload: unknown, from: AztecAddress, feeOptions: unknown): Promise<unknown>;
  scopesFrom(from: AztecAddress, additionalScopes: AztecAddress[], sendMessagesAs: AztecAddress | undefined): AztecAddress[];
  senderForTagsFrom(from: AztecAddress, sendMessagesAs?: AztecAddress): AztecAddress | undefined;
  pxe: { proveTx(request: unknown, opts: { scopes: AztecAddress[]; senderForTags: AztecAddress | undefined }): Promise<{ toTx(): Promise<Tx> }> };
}

export interface PxeOxideBackendOptions {
  wallet: Wallet;
  account: AztecAddress;
  /** The ungated node client (AztecClient.oxideContext). */
  node: AztecNode;
  observeTx: (txHash: string) => Promise<NodeObservation>;
  token: Contract;
  artifact: ContractArtifact;
  l1: OxideL1Reader;
  /** The bridge secret, derived exactly as standard mode does (`deriveAccountKeys`). Used in `create` only, never stored. */
  secretKey: string;
  gasMarginBps?: bigint;
  feeMultiplier?: bigint;
  pins?: OxidePins;
}

export class PxeOxideBackend implements OxideBackend {
  readonly account: string;

  private constructor(
    private readonly options: Omit<PxeOxideBackendOptions, "secretKey">,
    private readonly fleet: FleetSigner,
    private readonly spend: SpendMetadata,
    private readonly proving: ProvingInternals,
  ) {
    this.account = options.account.toString().toLowerCase();
  }

  static async create(options: PxeOxideBackendOptions): Promise<PxeOxideBackend> {
    const pins = options.pins ?? OXIDE_V6_MAINNET;
    const proving = options.wallet as unknown as Partial<ProvingInternals>;
    for (const method of ["completeFeeOptions", "createTxExecutionRequestFromPayloadAndFee", "scopesFrom", "senderForTagsFrom"] as const) {
      if (typeof proving[method] !== "function") throw new Error(`EmbeddedWallet has no ${method}; the Oxide backend needs SDK 6.0.0`);
    }
    if (typeof proving.pxe?.proveTx !== "function") throw new Error("Wallet has no pxe.proveTx");

    // The spend metadata the enclave needs for every note this account spends:
    // its address preimage and master nullifier hiding key. Derived from the
    // one bridge secret exactly as `standard` mode derives the account, and
    // refused unless it reproduces the connected account.
    const { secretKey, ...retained } = options;
    const keys = await deriveAccountKeys(secretKey);
    const spend = await buildSpendMetadata({ ...keys, creationTxHash: TxHash.zero() });
    if (!spend.ownerAddressPreimage.address.equals(options.account)) {
      throw new Error("Oxide spend metadata does not derive the connected standard account");
    }
    const fleet = await FleetSigner.connect(pins.enclaveUrl, new OxideFleetRegistry(options.l1, pins));
    return new PxeOxideBackend({ ...retained, pins }, fleet, spend, proving as ProvingInternals);
  }

  private get pins(): OxidePins {
    return this.options.pins ?? OXIDE_V6_MAINNET;
  }

  async simulate(payout: OxidePayout): Promise<OxideSimulation> {
    const { wallet, account, token, artifact, node } = this.options;
    const recipient = AztecAddress.fromStringUnsafe(payout.recipient);
    const meta = orderFingerprintMeta(payout.orderFingerprint, transferMetaLen(artifact));
    const call = token.methods["transfer"]!(account, recipient, payout.amount, meta, Fr.ZERO);
    // One seed for both passes, so the token draws the same note randomness in each.
    const seed = buildSeedCapsule(token.address);
    const payload = await new BatchCall(wallet, [call]).request({ capsules: [seed] });
    const result = await wallet.simulateTx(payload, toSimulateOptions({ from: account }));
    const anchor = result.publicInputs.constants.anchorBlockHeader;
    const collected = collectAccountingEffects(token.address, result.offchainEffects);
    const tokenOperation = await hydrateTokenOperation(node, {
      tokenAddress: token.address,
      teeRegistry: this.fleet.teeRegistry,
      anchorBlockHeader: anchor,
      collected,
      resolveSpendMetadata: async (nullified) => {
        if (!nullified.owner.equals(account)) throw new Error("nullified note is not the sending account's");
        return { ...this.spend, creationTxHash: nullified.creationTxHash };
      },
      resolveDepositSpendMetadata: async (depositRecipient) => {
        if (!depositRecipient.equals(account)) throw new Error("spent deposit is not the sending account's");
        return { ownerAddressPreimage: this.spend.ownerAddressPreimage, masterNullifierHidingKey: this.spend.masterNullifierHidingKey };
      },
    });
    const summary: TokenOperationSummary = {
      nullifiers: result.publicInputs.getNonEmptyNullifiers().map((n) => n.toString().toLowerCase()),
      anchorBlockNumber: Number(anchor.globalVariables.blockNumber),
      createdNotes: tokenOperation.createdNotes.map((n) => ({ owner: n.owner.toString(), amount: n.amount })),
      spentNoteOwners: tokenOperation.spentNotes.map((s) => s.note.owner.toString()),
      depositRecipients: tokenOperation.deposits.map((d) => d.recipient.toString()),
      withdrawals: tokenOperation.withdrawals.length,
    };
    const handle: Simulated = { call, seed, collected, tokenOperation, anchor };
    // The transfer alone, sized as `size` sizes the final batch: a floor under
    // that batch's fee limit (it adds `publish_da`), known before the enclave.
    const floor = this.gasSettings(result.gasUsed, await this.worstPredictedFees());
    return { summary, feeLimitFloor: oxideFeeLimit(floor), handle };
  }

  async sign(simulation: OxideSimulation): Promise<OxideSigned> {
    const simulated = simulation.handle as Simulated;
    const signOutput = await this.fleet.signTokenOperation(simulated.tokenOperation);
    // The enclave must have signed exactly the notes it was asked to.
    const notes = simulated.tokenOperation.createdNotes;
    if (signOutput.signatures.length !== notes.length || signOutput.teeNotes.length !== notes.length) {
      throw new Error("enclave answer does not cover the TokenOperation's notes");
    }
    const l2Token = this.options.token.address;
    const siloed = await Promise.all(notes.map((n) => computeSiloedNoteHash({ ...n, l2Token })));
    if (!siloed.every((h, i) => h.equals(signOutput.teeNotes[i]!))) {
      throw new Error("enclave signed note hashes other than the TokenOperation's");
    }
    return { handle: { ...simulated, signOutput } satisfies Signed };
  }

  async size(signed: OxideSigned): Promise<OxideSized> {
    const { wallet, account, token } = this.options;
    const s = signed.handle as Signed;
    const capsules = [
      s.seed,
      buildStrictModeCapsule(token.address),
      ...(await buildNoteSignatureCapsules(token.address, s.collected, s.signOutput.signatures)),
    ];
    const anchorBlockHash = await s.anchor.hash();
    const calls = [
      s.call,
      token.methods["publish_da"]!().with({ capsules: buildPublishDaCapsules(token.address, s.signOutput, anchorBlockHash) }),
    ];
    const payload = await new BatchCall(wallet, calls).request({ capsules });

    // Size the gas from the batch that will be proven.
    const final = await wallet.simulateTx(payload, toSimulateOptions({ from: account }));
    const gas = this.gasSettings(final.gasUsed, await this.worstPredictedFees());
    const handle: Sized = { ...s, payload, anchorBlockHash, gas };
    return { feeLimit: oxideFeeLimit(gas), handle };
  }

  async prove(sized: OxideSized): Promise<OxideProvenTx> {
    const { account } = this.options;
    const s = sized.handle as Sized;
    const { payload, anchorBlockHash, gas } = s;

    const feeOptions = await this.proving.completeFeeOptions({
      from: account,
      feePayer: payload.feePayer,
      gasSettings: {
        gasLimits: new Gas(gas.gasLimits.daGas, gas.gasLimits.l2Gas),
        teardownGasLimits: new Gas(gas.teardownGasLimits.daGas, gas.teardownGasLimits.l2Gas),
        maxFeesPerGas: new GasFees(gas.maxFeesPerGas.feePerDaGas, gas.maxFeesPerGas.feePerL2Gas),
      },
    });
    const request = await this.proving.createTxExecutionRequestFromPayloadAndFee(payload, account, feeOptions);
    const proven = await this.proving.pxe.proveTx(request, {
      scopes: this.proving.scopesFrom(account, [], undefined),
      senderForTags: this.proving.senderForTagsFrom(account, undefined),
    });
    const tx = await proven.toTx();

    const notes = s.tokenOperation.createdNotes;
    const recipientNoteIndex = notes.findIndex((n) => !n.owner.equals(account));
    const evidence: OxideSendEvidence = {
      anchorBlockHash: anchorBlockHash.toString(),
      enclave: {
        // From the key that signed, not the current pin: FleetSigner can re-pin
        // to another enclave between this sign and any later read.
        address: ethAddressFromSecpPublicKey(s.signOutput.publicKey).toString(),
        registrationLeafIndex: s.signOutput.registrationLeafIndex.toString(),
        publicKeyX: s.signOutput.publicKey.x.toString(),
        publicKeyY: s.signOutput.publicKey.y.toString(),
      },
      createdNotes: notes.map((n) => ({ owner: n.owner.toString(), amount: n.amount.toString(), randomness: n.randomness.toString() })),
      recipientNoteIndex,
      teeNotes: s.signOutput.teeNotes.map((h) => h.toString()),
      requiredNullifiers: s.signOutput.requiredNullifiers.map((h) => h.toString()),
      txNullifiers: tx.data.getNonEmptyNullifiers().map((n) => n.toString().toLowerCase()),
      signatures: s.signOutput.signatures.map((g) => ({
        sLo: g.sLo.toString(),
        sHi: g.sHi.toString(),
        rLo: g.rLo.toString(),
        rHi: g.rHi.toString(),
      })),
      gasLimits: gas.gasLimits,
      maxFeesPerGas: {
        feePerDaGas: gas.maxFeesPerGas.feePerDaGas.toString(),
        feePerL2Gas: gas.maxFeesPerGas.feePerL2Gas.toString(),
      },
    };
    const identity = await identifyTx(tx);
    return {
      txHash: identity.txHash,
      txBytes: tx.toBuffer(),
      expirationTimestamp: identity.expirationTimestamp,
      evidence,
    };
  }

  async identify(txBytes: Buffer): Promise<TxIdentity> {
    return (await decodeTxBytes(txBytes)).identity;
  }

  /** Exact journaled bytes to the ungated node, with nothing awaited before the call. */
  send(txBytes: Buffer): Promise<void> {
    return this.options.node.sendTx(Tx.fromBuffer(txBytes));
  }

  observe(txHash: string): Promise<NodeObservation> {
    return this.options.observeTx(txHash);
  }

  async feeJuiceBalance(): Promise<bigint> {
    // Standard mode's read (aztec-client.ts feeRunway), at the latest state the node admits against.
    const slot = await deriveStorageSlotInMap(new Fr(FEE_JUICE_BALANCES_SLOT), this.options.account);
    return (await this.options.node.getPublicStorageAt("latest", ProtocolContractAddress.FeeJuice, slot)).toBigInt();
  }

  async maxSendFeeLimit(): Promise<bigint> {
    const [{ txsLimits }, worst] = await Promise.all([this.options.node.getNodeInfo(), this.worstPredictedFees()]);
    const multiplier = this.options.feeMultiplier ?? DEFAULT_FEE_MULTIPLIER;
    return oxideFeeLimit({
      gasLimits: txsLimits.gas,
      maxFeesPerGas: { feePerDaGas: worst.feePerDaGas * multiplier, feePerL2Gas: worst.feePerL2Gas * multiplier },
    });
  }

  /** The worst predicted min fee per gas over the node's samples. No samples is refused: it would price the send at zero. */
  private async worstPredictedFees(): Promise<{ feePerDaGas: bigint; feePerL2Gas: bigint }> {
    const predicted = await this.options.node.getPredictedMinFees(ManaUsageEstimate.Limit);
    if (predicted.length === 0) throw new Error("node returned no predicted fee samples");
    return predicted.reduce(
      (acc, f) => ({
        feePerDaGas: f.feePerDaGas > acc.feePerDaGas ? f.feePerDaGas : acc.feePerDaGas,
        feePerL2Gas: f.feePerL2Gas > acc.feePerL2Gas ? f.feePerL2Gas : acc.feePerL2Gas,
      }),
      { feePerDaGas: 0n, feePerL2Gas: 0n },
    );
  }

  private gasSettings(
    used: { totalGas: { daGas: number; l2Gas: number }; teardownGas: { daGas: number; l2Gas: number } },
    worst: { feePerDaGas: bigint; feePerL2Gas: bigint },
  ): OxideGasSettings {
    return oxideGasSettings(used.totalGas, used.teardownGas, worst, {
      ...(this.options.gasMarginBps !== undefined ? { gasMarginBps: this.options.gasMarginBps } : {}),
      ...(this.options.feeMultiplier !== undefined ? { feeMultiplier: this.options.feeMultiplier } : {}),
    });
  }
}
