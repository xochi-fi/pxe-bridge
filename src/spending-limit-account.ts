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

// Must match DOM_SEP__SPENDING_LIMIT in the Noir contract (main.nr)
export const DOM_SEP_SPENDING_LIMIT = 10042;

// Must match ALLOWLIST_SIZE in main.nr. It is part of the entrypoint ABI, so a
// mismatch changes the selector and the account address.
export const ALLOWLIST_SIZE = 8;

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
   * Written to allowlist slot 0 by the constructor. Without it the allowlist is
   * empty at deployment and every addition waits out the timelock, so the
   * bridge could not transfer for 24 hours after each cutover.
   */
  seedRecipient: string; // AztecAddress as 0x-prefixed 64-char hex
  /**
   * How many allowlist slots a transfer must carry, so a degenerate client
   * cannot publish the recipient by carrying only its slot. 1 means no floor.
   * Stored on-chain and changed only through the limits timelock, so it cannot
   * rise underneath an already-proven transaction. Raise it as the allowlist
   * grows; the contract does not do so automatically.
   */
  minAnonymitySet: number;
}

const ZERO_ADDRESS = "0x" + "0".repeat(64);

/**
 * Declared spending for the next transaction.
 *
 * Held by the contract and handed to every entrypoint BY REFERENCE. The SDK
 * calls AccountContract.getAccount() afresh on each resolution and does not
 * memoize, so an entrypoint owning its own copy of the declaration is reliably
 * not the one that ends up building the request: the values are written to an
 * orphan and the payload carries (0, zero address), which the on-chain guard
 * rejects with "Transfer does not match declared spending".
 */
interface DeclaredSpending {
  amount: bigint;
  recipient: string;
  allowlistHint: string[];
}

// ============================================================
// Account contract
// ============================================================

export class SpendingLimitAccountContract implements AccountContract {
  private declared: DeclaredSpending = {
    amount: 0n,
    recipient: ZERO_ADDRESS,
    allowlistHint: new Array(ALLOWLIST_SIZE).fill(ZERO_ADDRESS),
  };

  constructor(
    private signingPrivateKey: GrumpkinScalarType,
    private config: SpendingLimitConfig,
  ) {}

  /**
   * Set declared spending for the next transaction.
   * Must be called before each createNote to bind amount/recipient
   * into the signed hash so the on-chain contract can verify them.
   */
  setDeclaredSpending(amount: bigint, recipient: string, allowlistHint: string[]): void {
    if (allowlistHint.length !== ALLOWLIST_SIZE) {
      throw new Error(`allowlistHint must have ${ALLOWLIST_SIZE} entries, got ${allowlistHint.length}`);
    }
    // Mutate in place. Replacing the object would strand the entrypoints
    // already holding the old one, which is the bug this shape exists to stop.
    this.declared.amount = amount;
    this.declared.recipient = recipient;
    this.declared.allowlistHint = allowlistHint;
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

    return {
      constructorName: "constructor",
      constructorArgs: [
        pubKey.x,
        pubKey.y,
        this.config.maxAmountPerTx,
        this.config.dailyLimit,
        AztecAddress.fromStringUnsafe(this.config.admin),
        AztecAddress.fromStringUnsafe(this.config.token),
        AztecAddress.fromStringUnsafe(this.config.seedRecipient),
        this.config.minAnonymitySet,
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
      this.declared,
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
 *   entrypoint(AppPayload, u8, bool, u128, AztecAddress, [Field; 8])
 *
 * Signs over poseidon2([payloadHash, declaredAmount, declaredRecipient],
 * DOM_SEP_SPENDING_LIMIT) instead of plain payloadHash, binding the
 * spending info to the transaction cryptographically.
 */
class SpendingLimitEntrypoint implements EntrypointInterface {
  constructor(
    private address: import("@aztec/stdlib/aztec-address").AztecAddress,
    private auth: AuthWitnessProvider,
    /** Shared with the contract and every sibling entrypoint. Never reassign. */
    private declared: DeclaredSpending,
  ) {}

  async createTxExecutionRequest(
    exec: import("@aztec/stdlib/tx").ExecutionPayload,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ): Promise<import("@aztec/stdlib/tx").TxExecutionRequest> {
    const { Fr } = await import("@aztec/foundation/curves/bn254");
    const { FunctionSelector, encodeArguments } = await import("@aztec/stdlib/abi");
    const { computeOuterAuthWitHash } = await import("@aztec/stdlib/auth-witness");
    const { HashedValues, TxContext, TxExecutionRequest } = await import("@aztec/stdlib/tx");
    const { EncodedAppEntrypointCalls } = await import("@aztec/entrypoints/encoding");
    const { AztecAddress } = await import("@aztec/aztec.js/addresses");
    const { poseidon2HashWithSeparator } = await import("@aztec/foundation/crypto/poseidon");

    const { authWitnesses, capsules, extraHashedArgs } = exec;
    const { cancellable, txNonce, feePaymentMethodOptions } = options;

    // Encode function calls (same as DefaultAccountEntrypoint)
    const encodedCalls = await EncodedAppEntrypointCalls.create(exec.calls, txNonce);

    // Build extended args: standard + declared_amount + declared_recipient
    const declaredAmountFr = new Fr(this.declared.amount);
    const declaredRecipientAddr = AztecAddress.fromStringUnsafe(this.declared.recipient);

    const abi = this.getEntrypointAbi();
    const args = [
      encodedCalls,
      feePaymentMethodOptions,
      !!cancellable,
      // Raw bigint: the ABI parameter is a u128 integer, not a field.
      this.declared.amount,
      declaredRecipientAddr,
      this.declared.allowlistHint.map((h) => Fr.fromString(h)),
    ];
    const encodedArgs = encodeArguments(abi, args);

    const functionSelector = await FunctionSelector.fromNameAndParameters(abi.name, abi.parameters);

    // Combined hash: payload + spending info
    const payloadHash = await encodedCalls.hash();
    const combinedHash = await poseidon2HashWithSeparator(
      [payloadHash, declaredAmountFr, declaredRecipientAddr.toField()],
      DOM_SEP_SPENDING_LIMIT,
    );

    // Sign over the combined hash (not just payload hash)
    const messageHash = await computeOuterAuthWitHash(
      this.address,
      chainInfo.chainId,
      chainInfo.version,
      combinedHash,
    );
    const payloadAuthWitness = await this.auth.createAuthWit(messageHash);

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
      authWitnesses: [...authWitnesses, payloadAuthWitness],
      capsules,
      salt: Fr.random(),
    });
  }

  async wrapExecutionPayload(
    exec: import("@aztec/stdlib/tx").ExecutionPayload,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ): Promise<import("@aztec/stdlib/tx").ExecutionPayload> {
    const { Fr } = await import("@aztec/foundation/curves/bn254");
    const {
      FunctionCall: FunctionCallCls,
      FunctionSelector,
      encodeArguments,
    } = await import("@aztec/stdlib/abi");
    const { computeOuterAuthWitHash } = await import("@aztec/stdlib/auth-witness");
    const { ExecutionPayload } = await import("@aztec/stdlib/tx");
    const { EncodedAppEntrypointCalls } = await import("@aztec/entrypoints/encoding");
    const { AztecAddress } = await import("@aztec/aztec.js/addresses");
    const { poseidon2HashWithSeparator } = await import("@aztec/foundation/crypto/poseidon");

    const { authWitnesses, capsules, extraHashedArgs, feePayer } = exec;
    const { cancellable, txNonce, feePaymentMethodOptions } = options;

    const encodedCalls = await EncodedAppEntrypointCalls.create(exec.calls, txNonce);

    const declaredAmountFr = new Fr(this.declared.amount);
    const declaredRecipientAddr = AztecAddress.fromStringUnsafe(this.declared.recipient);

    const abi = this.getEntrypointAbi();
    const args = [
      encodedCalls,
      feePaymentMethodOptions,
      !!cancellable,
      // Raw bigint: the ABI parameter is a u128 integer, not a field.
      this.declared.amount,
      declaredRecipientAddr,
      this.declared.allowlistHint.map((h) => Fr.fromString(h)),
    ];
    const encodedArgs = encodeArguments(abi, args);
    const functionSelector = await FunctionSelector.fromNameAndParameters(abi.name, abi.parameters);

    const payloadHash = await encodedCalls.hash();
    const combinedHash = await poseidon2HashWithSeparator(
      [payloadHash, declaredAmountFr, declaredRecipientAddr.toField()],
      DOM_SEP_SPENDING_LIMIT,
    );
    const messageHash = await computeOuterAuthWitHash(
      this.address,
      chainInfo.chainId,
      chainInfo.version,
      combinedHash,
    );
    const payloadAuthWitness = await this.auth.createAuthWit(messageHash);

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
      [payloadAuthWitness, ...authWitnesses],
      capsules,
      [...encodedCalls.hashedArguments, ...extraHashedArgs],
      feePayer ?? this.address,
    );
  }

  /**
   * ABI for the extended entrypoint signature. Matches the Noir contract's
   * entrypoint function: (AppPayload, u8, bool, Field, AztecAddress).
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
          // Hand-maintained pair with `allowlist_hint: [Field; ALLOWLIST_SIZE]`
          // in main.nr's entrypoint.
          name: "allowlist_hint",
          type: { kind: "array", length: ALLOWLIST_SIZE, type: { kind: "field" } },
        },
      ],
      returnTypes: [],
      errorTypes: {},
    } as FunctionAbi;
  }
}
