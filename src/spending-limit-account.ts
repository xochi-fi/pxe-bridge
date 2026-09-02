/**
 * SpendingLimitAccountContract -- Aztec account contract with on-chain
 * spending limits, recipient allowlist, and timelocked parameter changes.
 *
 * Extends the standard Schnorr account by adding two extra parameters to the
 * entrypoint: `declared_amount` (u128) and `declared_recipient` (AztecAddress).
 * The contract verifies these against on-chain limits and includes them in the
 * signed hash so they cannot be forged.
 *
 * Usage:
 *   1. Compile: cd contracts/spending_limit_account && aztec compile
 *   2. Copy artifact to src/artifacts/ (or adjust ARTIFACT_PATH below)
 *   3. Use SpendingLimitAccountContract instead of SchnorrAccountContract
 *      when creating the AccountManager
 *
 * Integration with aztec-client.ts:
 *   const contract = new SpendingLimitAccountContract(signingKey, {
 *     maxAmountPerTx: 1000000n,
 *     dailyLimit: 10000000n,
 *     admin: adminAddress,
 *     token: tokenAddress,
 *   });
 *   const manager = await AccountManager.create(wallet, secret, contract, salt);
 */

import type { Fr as FrType } from "@aztec/foundation/curves/bn254";
import type { GrumpkinScalar as GrumpkinScalarType } from "@aztec/foundation/curves/grumpkin";
import type { ContractArtifact, FunctionAbi } from "@aztec/stdlib/abi";
import type {
  AuthWitnessProvider,
  EntrypointInterface,
  ChainInfo,
} from "@aztec/entrypoints/interfaces";
import type { DefaultAccountEntrypointOptions } from "@aztec/entrypoints/account";
import type { GasSettings } from "@aztec/stdlib/gas";
import type { CompleteAddress } from "@aztec/stdlib/contract";
import { BaseAccount, type Account, type AccountContract } from "@aztec/aztec.js/account";
import {
  ALLOWLIST_TREE_HEIGHT,
  AllowlistTree,
  type AllowlistRecipient,
} from "./allowlist-tree.js";

// Must match DOM_SEP__SPENDING_LIMIT in the Noir contract (main.nr)
export const DOM_SEP_SPENDING_LIMIT = 10042;

// The only call this account may make. The entrypoint reads the declared
// amount and recipient out of this call's args, and main.nr pins the same
// selector as a comptime constant.
export const TRANSFER_TO_PRIVATE_SIGNATURE = "transfer_to_private((Field),u128)";
// Pinned so a signature typo shows up as a failing unit test rather than as an
// account that silently declares nothing. Mirrors transfer_to_private_selector_pin.
export const TRANSFER_TO_PRIVATE_SELECTOR = "0x89758b40";

// Built by `aztec compile`; gitignored, produced by CI.
const ARTIFACT_PATH =
  "../contracts/spending_limit_account/target/spending_limit_account_contract-SpendingLimitAccount.json";

export interface SpendingLimitConfig {
  maxAmountPerTx: bigint;
  dailyLimit: bigint;
  admin: string; // AztecAddress as 0x-prefixed 64-char hex
  /** Single token this account may move. Fixed at construction, no setter. */
  token: string; // AztecAddress as 0x-prefixed 64-char hex
  /**
   * Secret seed every leaf salt derives from. SENSITIVE: it is what makes the
   * allowlist a secret set rather than an unpublished one. Anyone holding it
   * can test a candidate address against a leaf.
   *
   * Losing it is unrecoverable. The account stores only a root, so the set
   * cannot be read back off chain the way the old array could, and without the
   * seed no witness can be built and no allowlist change can be made. Archive
   * it with the same discipline as the contract artifact.
   */
  allowlistSeed: string; // 32-byte hex
  /**
   * The allowlist, as (address, tree position) pairs. Positions not named here
   * hold a commitment to the zero address under that position's own salt, so
   * they are indistinguishable from occupied ones without the seed.
   *
   * The whole set installs at construction as one root, which is why there is
   * no seed recipient any more: the array could only seed one entry and every
   * further addition waited out a 24h timelock.
   */
  allowlistRecipients: readonly AllowlistRecipient[];
}

// ============================================================
// Account contract
// ============================================================

export class SpendingLimitAccountContract implements AccountContract {
  /**
   * The allowlist tree, shared with every entrypoint BY REFERENCE through this
   * holder and populated in place.
   *
   * A holder rather than a field because the SDK calls
   * AccountContract.getAccount() afresh on each resolution and does not
   * memoize, so an entrypoint capturing the tree by value at construction is
   * reliably not the one that ends up building the request.
   *
   * Sharing one tree across concurrent sends is safe. It is not per-call state:
   * every caller wants the same set, the witness derived from it is not signed,
   * and the contract revalidates the root it produces against live storage at
   * inclusion time. Whichever version of the tree a payload ends up proving
   * against either matches the stored root or does not.
   */
  private readonly treeRef: { tree: AllowlistTree | null } = { tree: null };

  constructor(
    private signingPrivateKey: GrumpkinScalarType,
    private config: SpendingLimitConfig,
  ) {}

  /**
   * Build the tree once and cache it.
   *
   * Costs 2 * ALLOWLIST_CAPACITY hashes, roughly 0.7s, because per-leaf salts
   * leave no canonical empty subtrees to short-circuit. Paid at deploy or at
   * first send, not per transfer.
   */
  async allowlistTree(): Promise<AllowlistTree> {
    this.treeRef.tree ??= await AllowlistTree.build(
      this.config.allowlistSeed,
      this.config.allowlistRecipients,
    );
    return this.treeRef.tree;
  }

  // v5 AccountContract interface member. Address derivation includes an
  // optional immutables hash; the Schnorr-derived account has none, so this
  // returns undefined (matching the default Schnorr account contract).
  async getImmutablesHash(): Promise<FrType | undefined> {
    return undefined;
  }

  async getContractArtifact(): Promise<ContractArtifact> {
    // Must go through loadContractArtifact. The file on disk is raw nargo
    // output -- functions are named __aztec_nr_internals__* with their ABI
    // nested under `abi` -- and casting it straight to ContractArtifact left
    // consumers reading fields that do not exist, failing with "Cannot read
    // properties of undefined (reading 'map')" during deployment.
    //
    // loadContractArtifact also rejects an untranspiled artifact outright,
    // which is the check that catches a build done with plain nargo instead of
    // `aztec compile`.
    const { loadContractArtifact } = await import("@aztec/stdlib/abi");
    const artifact = await import(ARTIFACT_PATH, {
      with: { type: "json" },
    });
    return loadContractArtifact(artifact.default as Parameters<typeof loadContractArtifact>[0]);
  }

  async getInitializationFunctionAndArgs(): Promise<{
    constructorName: string;
    constructorArgs: unknown[];
  }> {
    const { Schnorr } = await import("@aztec/foundation/crypto/schnorr");
    const { AztecAddress } = await import("@aztec/aztec.js/addresses");

    const schnorr = new Schnorr();
    const pubKey = await schnorr.computePublicKey(this.signingPrivateKey);
    const tree = await this.allowlistTree();

    return {
      constructorName: "constructor",
      constructorArgs: [
        pubKey.x,
        pubKey.y,
        this.config.maxAmountPerTx,
        this.config.dailyLimit,
        AztecAddress.fromStringUnsafe(this.config.admin),
        AztecAddress.fromStringUnsafe(this.config.token),
        // The whole allowlist, as one root. This value feeds address
        // derivation through the constructor args, so a different seed or a
        // different set is a different account.
        tree.root,
      ],
    };
  }

  getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    // Standard Schnorr signatures. The spending limit entrypoint changes
    // WHAT gets signed (combined hash including spending info), not HOW
    // the signature is produced.
    return new SpendingLimitAuthWitnessProvider(this.signingPrivateKey);
  }

  getAccount(completeAddress: CompleteAddress): Account {
    const authProvider = this.getAuthWitnessProvider(completeAddress);
    const entrypoint = new SpendingLimitEntrypoint(
      completeAddress.address,
      authProvider,
      this.treeRef,
    );
    return new BaseAccount(entrypoint, authProvider, completeAddress);
  }
}

// ============================================================
// Auth witness provider (Schnorr signatures)
// ============================================================

class SpendingLimitAuthWitnessProvider implements AuthWitnessProvider {
  constructor(private signingPrivateKey: GrumpkinScalarType) {}

  async createAuthWit(
    messageHash: FrType,
  ): Promise<import("@aztec/stdlib/auth-witness").AuthWitness> {
    const { Schnorr } = await import("@aztec/foundation/crypto/schnorr");
    const { AuthWitness } = await import("@aztec/stdlib/auth-witness");

    const schnorr = new Schnorr();
    const signature = await schnorr.constructSignature(
      messageHash,
      this.signingPrivateKey,
    );
    // Four limb Fields, not 64 bytes. is_valid_impl reads [Field; 4].
    return new AuthWitness(messageHash, signature.toLimbFields());
  }
}

// ============================================================
// Custom entrypoint (adds declared_amount + declared_recipient)
// ============================================================

/**
 * Entrypoint that encodes the spending limit contract's extended signature:
 *   entrypoint(AppPayload, u8, bool, u128, AztecAddress, Field, Field,
 *              [Field; ALLOWLIST_TREE_HEIGHT])
 *
 * Signs over poseidon2([payloadHash, declaredAmount, declaredRecipient],
 * DOM_SEP_SPENDING_LIMIT) instead of plain payloadHash, binding the
 * spending info to the transaction cryptographically.
 *
 * The membership witness is deliberately NOT signed, for the same reason the
 * allowlist hint was not: it is a snapshot of state the signer cannot know at
 * signing time, and the circuit rebuilds the leaf from the signed recipient, so
 * a witness for anyone else proves nothing about this transfer.
 */
class SpendingLimitEntrypoint implements EntrypointInterface {
  constructor(
    private address: import("@aztec/stdlib/aztec-address").AztecAddress,
    private auth: AuthWitnessProvider,
    /** Shared with the contract and every sibling entrypoint. Never reassign. */
    private treeRef: { tree: AllowlistTree | null },
  ) {}

  /**
   * Reads the declared amount and recipient out of the payload being signed.
   *
   * They used to be pushed in beforehand, as mutable state on the contract
   * object. That made the declaration a second source of truth for something
   * the payload already said, and the two could disagree: two overlapping
   * sends each set it, and whichever built its payload second signed the
   * other's declaration, so the first reverted on assert_single_call_matches.
   * The bridge serialized every send to stop that happening, at one
   * transaction at a time.
   *
   * Deriving from `exec.calls` -- the same array that gets encoded into the
   * payload the circuit inspects -- makes declared == actual true by
   * construction here, and leaves the circuit to prove it rather than to
   * catch us out.
   */
  private async deriveDeclaration(
    calls: readonly import("@aztec/stdlib/abi").FunctionCall[],
  ): Promise<{ amount: bigint; recipient: import("@aztec/stdlib/aztec-address").AztecAddress }> {
    const { FunctionSelector } = await import("@aztec/stdlib/abi");
    const { AztecAddress } = await import("@aztec/aztec.js/addresses");

    const transferSelector = await FunctionSelector.fromSignature(TRANSFER_TO_PRIVATE_SIGNATURE);
    const transfers = calls.filter((c) => c.selector.equals(transferSelector));

    // Two or more is unresolvable here: there is one declaration and no basis
    // for picking which transfer it describes. The circuit rejects this too,
    // but failing here costs nothing while failing there costs a fee, since
    // set_as_fee_payer runs in the non-revertible setup phase.
    //
    // The total call count is deliberately not policed: a fee payment method
    // merges its own call into this payload, and where that merge happens
    // relative to this code is the SDK's business. The circuit is the
    // authority on the payload's shape.
    if (transfers.length > 1) {
      throw new Error(
        `Spending limit account requires at most one ${TRANSFER_TO_PRIVATE_SIGNATURE} call, ` +
          `found ${transfers.length}`,
      );
    }

    // No transfer is NOT an error. Every call the SDK routes through this
    // entrypoint arrives here, including simulating a private view such as
    // verify_private_authwit, and refusing those broke reads that have nothing
    // to do with spending. A zero declaration is what the old code produced by
    // default in exactly these cases.
    //
    // Fail-closed for anything that actually moves value: the circuit asserts
    // !declared_recipient.is_zero() in private, and assert_single_call_matches
    // rejects the payload before that, so a real send built from a zero
    // declaration cannot land.
    if (transfers.length === 0) {
      return { recipient: AztecAddress.ZERO, amount: 0n };
    }

    // transfer_to_private(to: AztecAddress, amount: u128) encodes as two
    // fields, a u128 packing into one. Same layout main.nr reconstructs in
    // assert_declared_matches_transfer.
    const args = transfers[0]!.args;
    if (args.length !== 2) {
      throw new Error(`Expected 2 args on transfer_to_private, found ${args.length}`);
    }

    // Unsafe as in "not range-checked as a valid address". It came out of a
    // call the SDK already encoded, and the circuit re-derives the args hash
    // from it either way.
    return {
      recipient: AztecAddress.fromFieldUnsafe(args[0]!),
      amount: args[1]!.toBigInt(),
    };
  }

  /**
   * Membership witness for the recipient this payload actually pays.
   *
   * Looked up here rather than pushed in beforehand for the same reason the
   * declaration is derived rather than declared: the recipient comes off the
   * payload being signed, so there is no per-call state for a concurrent send
   * to overwrite and nothing to serialize around.
   *
   * An unlisted recipient fails HERE, before a fee is committed. The circuit
   * would catch it too, at the root comparison in public, but set_as_fee_payer
   * runs in the non-revertible setup phase so that failure costs money.
   */
  private async witnessFor(
    recipient: import("@aztec/stdlib/aztec-address").AztecAddress,
  ): Promise<import("./allowlist-tree.js").AllowlistWitness> {
    // No recipient means no transfer: a private view simulation routed through
    // the entrypoint. The arguments still have to encode. See deriveDeclaration.
    if (recipient.isZero()) {
      return AllowlistTree.zeroWitness();
    }

    const tree = this.treeRef.tree;
    if (tree === null) {
      throw new Error(
        "Spending limit account has no allowlist tree; call allowlistTree() before sending",
      );
    }

    const witness = tree.witnessFor(recipient.toString());
    if (witness === undefined) {
      throw new Error(
        `Recipient ${recipient.toString()} is not in the allowlist. The bridge holds the ` +
          `allowlist off chain, so this means either the recipient was never added or the ` +
          `configured set has drifted from the account's stored root.`,
      );
    }
    return witness;
  }

  /**
   * Everything both entrypoint paths need: encoded args, selector, signature.
   *
   * Extracted because the two used to build it independently, line for line,
   * and a drift between them would have signed one declaration while sending
   * another.
   */
  private async buildEntrypointArgs(
    exec: import("@aztec/stdlib/tx").ExecutionPayload,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ): Promise<{
    encodedCalls: import("@aztec/entrypoints/encoding").EncodedAppEntrypointCalls;
    encodedArgs: FrType[];
    functionSelector: import("@aztec/stdlib/abi").FunctionSelector;
    abi: FunctionAbi;
    authWitness: import("@aztec/stdlib/auth-witness").AuthWitness;
  }> {
    const { Fr } = await import("@aztec/foundation/curves/bn254");
    const { FunctionSelector, encodeArguments } = await import("@aztec/stdlib/abi");
    const { computeOuterAuthWitHash } = await import("@aztec/stdlib/auth-witness");
    const { EncodedAppEntrypointCalls } = await import("@aztec/entrypoints/encoding");
    const { poseidon2HashWithSeparator } = await import("@aztec/foundation/crypto/poseidon");

    const { cancellable, txNonce, feePaymentMethodOptions } = options;

    const encodedCalls = await EncodedAppEntrypointCalls.create(exec.calls, txNonce);
    const { amount, recipient } = await this.deriveDeclaration(exec.calls);
    const witness = await this.witnessFor(recipient);

    const abi = this.getEntrypointAbi();
    const encodedArgs = encodeArguments(abi, [
      encodedCalls,
      feePaymentMethodOptions,
      // Read and ignored by the contract since the cancellation branch was
      // deleted. The parameter stays because arguments are positional.
      !!cancellable,
      // Raw bigint: the ABI parameter is a u128 integer, not a field.
      amount,
      recipient,
      witness.leafSalt,
      new Fr(BigInt(witness.leafIndex)),
      witness.siblingPath,
    ]);
    const functionSelector = await FunctionSelector.fromNameAndParameters(abi.name, abi.parameters);

    // Sign over payload + declared spending, not the payload alone, so the
    // declaration cannot be swapped under a valid signature.
    const combinedHash = await poseidon2HashWithSeparator(
      [await encodedCalls.hash(), new Fr(amount), recipient.toField()],
      DOM_SEP_SPENDING_LIMIT,
    );
    const messageHash = await computeOuterAuthWitHash(
      this.address,
      chainInfo.chainId,
      chainInfo.version,
      combinedHash,
    );

    return {
      encodedCalls,
      encodedArgs,
      functionSelector,
      abi,
      authWitness: await this.auth.createAuthWit(messageHash),
    };
  }

  async createTxExecutionRequest(
    exec: import("@aztec/stdlib/tx").ExecutionPayload,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ): Promise<import("@aztec/stdlib/tx").TxExecutionRequest> {
    const { Fr } = await import("@aztec/foundation/curves/bn254");
    const { HashedValues, TxContext, TxExecutionRequest } = await import("@aztec/stdlib/tx");

    const { authWitnesses, capsules, extraHashedArgs } = exec;
    const { encodedCalls, encodedArgs, functionSelector, authWitness } =
      await this.buildEntrypointArgs(exec, chainInfo, options);

    const entrypointHashedArgs = await HashedValues.fromArgs(encodedArgs);
    return TxExecutionRequest.from({
      firstCallArgsHash: entrypointHashedArgs.hash,
      origin: this.address,
      functionSelector,
      txContext: new TxContext(
        chainInfo.chainId.toNumber(),
        chainInfo.version.toNumber(),
        gasSettings,
      ),
      argsOfCalls: [...encodedCalls.hashedArguments, entrypointHashedArgs, ...extraHashedArgs],
      authWitnesses: [...authWitnesses, authWitness],
      capsules,
      salt: Fr.random(),
    });
  }

  async wrapExecutionPayload(
    exec: import("@aztec/stdlib/tx").ExecutionPayload,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ): Promise<import("@aztec/stdlib/tx").ExecutionPayload> {
    const { FunctionCall: FunctionCallCls } = await import("@aztec/stdlib/abi");
    const { ExecutionPayload } = await import("@aztec/stdlib/tx");

    const { authWitnesses, capsules, extraHashedArgs, feePayer } = exec;
    const { encodedCalls, encodedArgs, functionSelector, abi, authWitness } =
      await this.buildEntrypointArgs(exec, chainInfo, options);

    const entrypointCall = FunctionCallCls.from({
      name: abi.name,
      to: this.address,
      selector: functionSelector,
      type: abi.functionType,
      hideMsgSender: false,
      isStatic: abi.isStatic,
      args: encodedArgs,
      returnTypes: abi.returnTypes,
    });

    return new ExecutionPayload(
      [entrypointCall],
      [authWitness, ...authWitnesses],
      capsules,
      [...encodedCalls.hashedArguments, ...extraHashedArgs],
      feePayer ?? this.address,
    );
  }

  /**
   * ABI for the extended entrypoint signature. Hand-maintained against the
   * Noir contract's entrypoint:
   *
   *   entrypoint(AppPayload, u8, bool, u128, AztecAddress, Field, Field,
   *              [Field; ALLOWLIST_TREE_HEIGHT])
   *
   * Drift is not a type error anywhere, and it does NOT move the account
   * address: the class ID derives from the compiled artifact, not from this
   * table. What drift produces is a wrong selector or misplaced arguments
   * against the SAME address, which is a transaction that fails on chain.
   * `entrypoint_abi_matches_artifact` in tests/spending-limit-account.test.ts
   * is what catches it.
   */
  private getEntrypointAbi(): FunctionAbi {
    return {
      name: "entrypoint",
      isInitializer: false,
      functionType: "private",
      isOnlySelf: false,
      isStatic: false,
      parameters: [
        // Standard parameters (identical to DefaultAccountEntrypoint)
        {
          name: "app_payload",
          type: {
            kind: "struct",
            path: "authwit::entrypoint::app::AppPayload",
            fields: [
              {
                name: "function_calls",
                type: {
                  kind: "array",
                  length: 5,
                  type: {
                    kind: "struct",
                    path: "authwit::entrypoint::function_call::FunctionCall",
                    fields: [
                      { name: "args_hash", type: { kind: "field" } },
                      {
                        name: "function_selector",
                        type: {
                          kind: "struct",
                          path: "authwit::aztec::protocol_types::abis::function_selector::FunctionSelector",
                          fields: [
                            {
                              name: "inner",
                              type: {
                                kind: "integer",
                                sign: "unsigned",
                                width: 32,
                              },
                            },
                          ],
                        },
                      },
                      {
                        name: "target_address",
                        type: {
                          kind: "struct",
                          path: "authwit::aztec::protocol_types::address::AztecAddress",
                          fields: [{ name: "inner", type: { kind: "field" } }],
                        },
                      },
                      { name: "is_public", type: { kind: "boolean" } },
                      { name: "hide_msg_sender", type: { kind: "boolean" } },
                      { name: "is_static", type: { kind: "boolean" } },
                    ],
                  },
                },
              },
              { name: "tx_nonce", type: { kind: "field" } },
            ],
          },
          visibility: "public",
        },
        {
          name: "fee_payment_method",
          type: { kind: "integer", sign: "unsigned", width: 8 },
        },
        {
          name: "cancellable",
          type: { kind: "boolean" },
        },
        // Extended parameters for spending limit enforcement
        {
          // Hand-maintained pair with `declared_amount: u128` in main.nr.
          // Drift encodes args at a different width and breaks the binding.
          name: "declared_amount",
          type: { kind: "integer", sign: "unsigned", width: 128 },
        },
        {
          name: "declared_recipient",
          type: {
            kind: "struct",
            path: "authwit::aztec::protocol_types::address::AztecAddress",
            fields: [{ name: "inner", type: { kind: "field" } }],
          },
        },
        {
          // Hand-maintained triple with `leaf_salt`, `leaf_index` and
          // `sibling_path` in main.nr's entrypoint. Order matters: arguments
          // are encoded positionally.
          name: "leaf_salt",
          type: { kind: "field" },
        },
        {
          name: "leaf_index",
          type: { kind: "field" },
        },
        {
          name: "sibling_path",
          type: { kind: "array", length: ALLOWLIST_TREE_HEIGHT, type: { kind: "field" } },
        },
      ],
      returnTypes: [],
      errorTypes: {},
    } as FunctionAbi;
  }
}
