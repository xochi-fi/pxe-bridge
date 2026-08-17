import { createHash } from "node:crypto";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { GasFees } from "@aztec/stdlib/gas";
import { PostSubmissionError } from "./types.js";
import type { CreateNoteParams, CreateNoteResult, FeeJuiceClaim, IAztecClient } from "./types.js";
import {
  ALLOWLIST_SIZE,
  SpendingLimitAccountContract,
  type SpendingLimitConfig,
} from "./spending-limit-account.js";

const MAX_TOKEN_CACHE_SIZE = 100;
const TX_TIMEOUT_MS = 120_000; // 2 minutes

// Multiplier applied to the worst predicted base fee when deploying the
// account. Deployment happens once at startup and the max is a ceiling rather
// than a charge, so this trades an unused allowance for not failing to boot
// during a congestion spike.
const DEPLOY_FEE_HEADROOM = 10n;

/** The slice of AztecNode createNote needs to read a tx effect back. */
interface TxEffectFields {
  noteHashes?: { toString(): string }[];
  nullifiers?: { toString(): string }[];
}
interface AztecNodeLike {
  getTxReceipt(
    txHash: never,
    options: { includeTxEffect: true },
  ): Promise<{ txEffect?: (TxEffectFields & { data?: TxEffectFields }) | undefined } | undefined>;
}

/** Distinguishable so createNote can tell a deadline from a rejection. */
class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError("Operation timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wraps Aztec SDK v4 for server-side shielded note creation.
 *
 * Uses EmbeddedWallet (Node.js entrypoint, no browser APIs)
 * with a Schnorr account derived from PXE_BRIDGE_SECRET_KEY.
 * Acts as the solver account that creates shielded notes
 * on behalf of EVM settlement.
 */
export class AztecClient implements IAztecClient {
  private wallet: EmbeddedWallet | null = null;
  private solverAddress: AztecAddress | null = null;
  private tokenCache = new Map<string, TokenContract>();
  private secretKey: string | null;
  private spendingLimitContract: SpendingLimitAccountContract | null = null;

  constructor(
    private readonly nodeUrl: string,
    secretKey: string,
    private readonly feeJuiceClaim?: FeeJuiceClaim,
    private readonly spendingLimitConfig?: SpendingLimitConfig,
  ) {
    this.secretKey = secretKey;
  }

  async connect(): Promise<void> {
    if (!this.secretKey) {
      throw new Error("Secret key already consumed");
    }

    console.log(`[pxe-bridge] Connecting to ${this.nodeUrl}`);

    this.wallet = await EmbeddedWallet.create(this.nodeUrl, {
      pxe: { proverEnabled: true },
    });
    console.log("[pxe-bridge] EmbeddedWallet created");

    const { Fr } = await import("@aztec/aztec.js/fields");

    const rawKey = Buffer.from(this.secretKey.replace(/^0x/, ""), "hex");
    this.secretKey = null; // clear string reference immediately

    const keyBytes = Buffer.alloc(32);
    rawKey.copy(keyBytes, 32 - rawKey.length);
    rawKey.fill(0); // zero raw key buffer

    const secret = Fr.fromBuffer(keyBytes);
    const saltBytes = createHash("sha256")
      .update(Buffer.from("pxe-bridge-account-salt-v1"))
      .update(keyBytes)
      .digest();
    // Reduce, not fromBuffer. A sha256 digest is a uniform 256-bit value and
    // the BN254 Fr modulus is ~0.189 of 2^256, so ~81% of otherwise valid keys
    // produced a digest the field could not hold and connect() threw here
    // before deriving or deploying anything. Reduction is the identity for a
    // digest already in range, so no account that ever deployed moves.
    const salt = Fr.fromBufferReduce(saltBytes);

    keyBytes.fill(0);
    saltBytes.fill(0);
    // Note: Fr objects (secret, salt) hold key material on the JS heap
    // until GC'd after connect() returns. The wallet also retains the
    // signing key internally -- we cannot zero SDK-owned memory.

    const { deriveMasterMessageSigningSecretKey } = await import("@aztec/stdlib/keys");
    const accountManager = this.spendingLimitConfig
      ? await this.createSpendingLimitAccount(secret, salt)
      : await this.wallet.createSchnorrAccount(
          secret,
          salt,
          deriveMasterMessageSigningSecretKey(secret),
        );

    const account = await accountManager.getAccount();
    const address = account.getAddress();
    this.solverAddress = address;

    // Deploy account contract if not already on-chain.
    // Cannot rely on wallet.getAccounts() since the local WalletDB is
    // ephemeral (Docker restarts clear it). Query the node instead.
    const alreadyDeployed = await this.isContractDeployed(address);

    if (!alreadyDeployed) {
      console.log("[pxe-bridge] Deploying solver account...");

      const { NO_FROM } = await import("@aztec/aztec.js/account");
      const paymentMethod = await this.buildFeePaymentMethod(address);

      // The spending-limit account cannot deploy itself. Self-deployment routes
      // through the account's OWN entrypoint (only the account can name itself
      // fee payer), and that call carries a fee-related payload rather than a
      // transfer, so the single-call guard rejects it with "Transfer does not
      // match declared spending". This is NM-1019 [Info], reproduced in e2e.
      //
      // Deploying from a separate funded account runs only the constructor, so
      // the guard is never reached. DeployAccountMethod hardcodes
      // universalDeploy, i.e. deployer = AztecAddress.ZERO in the address
      // preimage, so which account pays does not move the address.
      //
      // A standard Schnorr account has no such guard and still self-deploys.
      const deployer = this.spendingLimitConfig
        ? await this.ensureDeployer(secret, salt)
        : NO_FROM;

      const deployMethod = await accountManager.getDeployMethod();
      try {
        await deployMethod.send({
          from: deployer,
          fee: { paymentMethod, gasSettings: await this.deployGasSettings() },
          // Both default to true, which leaves the account initialized but
          // unpublished: the node cannot resolve it and its public functions
          // cannot execute. Publication costs more than a self-paying account
          // could cover, which is why it only became affordable once a
          // separately funded deployer pays.
          skipClassPublication: false,
          skipInstancePublication: false,
        });
        console.log("[pxe-bridge] Account deployed");
      } catch (err) {
        // A concurrent deploy of the same account is not an error. The init
        // nullifier is the authoritative signal: it can only already exist if
        // the constructor has run, and it is emitted before the instance
        // becomes visible to the node, so checking it avoids the window where
        // isContractDeployed still reports false.
        const message = err instanceof Error ? err.message : String(err);
        const alreadyInitialized = message.includes("Existing nullifier");
        if (alreadyInitialized || (await this.isContractDeployed(address))) {
          console.log("[pxe-bridge] Account deployed by another process");
        } else {
          throw err;
        }
      }
    } else {
      console.log("[pxe-bridge] Account recovered");
    }

    if (this.spendingLimitConfig) {
      console.log(
        `[pxe-bridge] Spending limit account active (max/tx: ${this.spendingLimitConfig.maxAmountPerTx}, daily: ${this.spendingLimitConfig.dailyLimit})`,
      );
    }
    console.log("[pxe-bridge] Ready");
  }

  /**
   * Create a SpendingLimitAccountContract and register it with the wallet.
   *
   * The spending limit contract uses the same Schnorr signature scheme but
   * extends the entrypoint with declared_amount and declared_recipient fields
   * that are bound to the signed hash and verified on-chain.
   *
   * Wallet integration: we store the account in WalletDB as type 'schnorr'
   * so the wallet's simulation path (gas estimation) can find it. The actual
   * tx send path is patched to use our custom entrypoint via an override of
   * getAccountFromAddress. Simulation uses a Schnorr stub which gives
   * approximate gas estimates; the built-in gas padding covers the delta.
   */
  private async createSpendingLimitAccount(
    secret: import("@aztec/aztec.js/fields").Fr,
    salt: import("@aztec/aztec.js/fields").Fr,
  ): Promise<import("@aztec/aztec.js/wallet").AccountManager> {
    const { AccountManager } = await import("@aztec/aztec.js/wallet");
    const { deriveMasterMessageSigningSecretKey } = await import("@aztec/stdlib/keys");

    const signingKey = deriveMasterMessageSigningSecretKey(secret);

    this.spendingLimitContract = new SpendingLimitAccountContract(
      signingKey,
      this.spendingLimitConfig!,
    );

    const accountManager = await AccountManager.create(
      this.wallet! as unknown as Parameters<typeof AccountManager.create>[0],
      secret,
      this.spendingLimitContract,
      { salt },
    );

    // Register the contract artifact with PXE so proving works.
    const instance = accountManager.getInstance();
    const w = this.wallet as unknown as Record<string, unknown>;
    const pxe = w["pxe"] as {
      getContractInstance: (addr: AztecAddress) => Promise<unknown>;
      getContractArtifact: (classId: unknown) => Promise<unknown>;
    };
    // Register unconditionally. This was guarded on
    // pxe.getContractInstance(address) being empty, but AccountManager.create()
    // has already registered the instance by this point, so the guard always
    // skipped and our artifact was never associated with the class. The wallet
    // then resolved the address against the default account artifact and
    // rejected our entrypoint selector with "Function with selector ... not
    // found in the registered artifact ... (SimulatedSchnorrAccount)".
    const artifact = await this.spendingLimitContract.getContractArtifact();
    await this.wallet!.registerContract(instance, artifact, secret);

    // Store in WalletDB as 'schnorr' so simulation can find the account.
    // The actual send uses our custom entrypoint via the patched method below.
    const db = w["walletDB"] as {
      storeAccount: (addr: AztecAddress, data: Record<string, unknown>) => Promise<void>;
    };
    await db.storeAccount(instance.address, {
      type: "schnorr",
      secretKey: secret,
      salt,
      alias: "",
      signingKey: signingKey.toBuffer(),
    });

    // EmbeddedWallet simulates through a STUB account: buildAccountOverrides
    // rewrites the address's currentContractClassId to the stub class, and
    // simulateTx builds the request with a 3-parameter DefaultAccountEntrypoint
    // chosen from the WalletDB `type`. The SDK does this deliberately to skip
    // the private kernel and real authorization during simulation.
    //
    // That is incompatible with a custom entrypoint. Ours takes six parameters,
    // so its selector is absent from the stub artifact and simulation fails
    // with "Function with selector ... not found in the registered artifact ...
    // (SimulatedSchnorrAccount)". The override is also why gas was
    // mis-estimated: under the stub class, check_spending_public is never
    // enqueued, so the estimate omits the entire public half of the tx.
    //
    // Three patches, all scoped to this one address, so every other account
    // keeps the fast stub path:
    //   1. getAccountFromAddress  -- the send path builds our entrypoint
    //   2. createStubAccount      -- simulation builds it too
    //   3. buildAccountOverrides  -- simulation keeps our real contract class
    // 2 and 3 must move together: our entrypoint against the stub class fails
    // on the selector, and the stub entrypoint against our class omits the
    // spending check.
    const customAccount = await accountManager.getAccount();
    const walletAny = this.wallet as unknown as {
      getAccountFromAddress: (addr: AztecAddress) => Promise<unknown>;
      buildAccountOverrides: (addrs: AztecAddress[]) => Promise<Record<string, unknown>>;
      accountContracts: {
        createStubAccount: (completeAddress: unknown, type: string) => Promise<unknown>;
      };
    };

    const originalGetAccount = walletAny.getAccountFromAddress.bind(this.wallet);
    walletAny.getAccountFromAddress = async (addr: AztecAddress) => {
      if (addr.equals(instance.address)) {
        return customAccount;
      }
      return originalGetAccount(addr);
    };

    const provider = walletAny.accountContracts;
    const originalCreateStub = provider.createStubAccount.bind(provider);
    provider.createStubAccount = async (completeAddress: unknown, type: string) => {
      const addr = (completeAddress as { address: AztecAddress }).address;
      if (addr && addr.equals(instance.address)) {
        return customAccount;
      }
      return originalCreateStub(completeAddress, type);
    };

    const originalOverrides = walletAny.buildAccountOverrides.bind(this.wallet);
    walletAny.buildAccountOverrides = async (addrs: AztecAddress[]) => {
      const overrides = await originalOverrides(addrs);
      // Leave our class intact. Simulation then runs the real private kernel
      // for this account, which is slower but is the only way the simulated
      // transaction matches the one that gets sent.
      delete overrides[instance.address.toString()];
      return overrides;
    };

    return accountManager;
  }

  /**
   * Deploys (once) a plain Schnorr account to act as deployer for the
   * spending-limit account, and returns its address.
   *
   * Derived from the same master secret under a different salt, so it needs no
   * separate key material and is reproducible across restarts. It self-deploys
   * via SponsoredFPC, which a standard Schnorr account can do because its
   * entrypoint has no single-call restriction.
   */
  private async ensureDeployer(
    secret: import("@aztec/aztec.js/fields").Fr,
    baseSalt: import("@aztec/aztec.js/fields").Fr,
  ): Promise<AztecAddress> {
    const { NO_FROM } = await import("@aztec/aztec.js/account");
    const { deriveMasterMessageSigningSecretKey } = await import("@aztec/stdlib/keys");
    const { Fr } = await import("@aztec/aztec.js/fields");

    const deployerSalt = new Fr(baseSalt.toBigInt() + 1n);
    const manager = await this.wallet!.createSchnorrAccount(
      secret,
      deployerSalt,
      deriveMasterMessageSigningSecretKey(secret),
    );
    const deployerAddress = (await manager.getAccount()).getAddress();

    if (!(await this.isContractDeployed(deployerAddress))) {
      console.log("[pxe-bridge] Deploying deployer account...");
      const paymentMethod = await this.buildFeePaymentMethod(deployerAddress);
      try {
        await (await manager.getDeployMethod()).send({
          from: NO_FROM,
          // Same headroom as the account it exists to deploy. This one runs
          // first, so a spike here strands the account deployment behind it.
          fee: { paymentMethod, gasSettings: await this.deployGasSettings() },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("Existing nullifier")) {
          throw err;
        }
      }
    }
    return deployerAddress;
  }

  /** Deployed account address. Null until connect() completes. */
  getAddress(): string | null {
    return this.solverAddress ? this.solverAddress.toString() : null;
  }

  async createNote(params: CreateNoteParams): Promise<CreateNoteResult> {
    if (!this.wallet || !this.solverAddress) {
      throw new Error("Client not connected");
    }

    const { AztecAddress } = await import("@aztec/aztec.js/addresses");

    const tokenAddress = AztecAddress.fromStringUnsafe(params.token);
    const recipientAddress = AztecAddress.fromStringUnsafe(params.recipient);
    const amount = BigInt(params.amount);
    const from = this.solverAddress;

    const token = await this.getToken(tokenAddress);

    if (params.tradeId !== undefined) {
      console.log(
        "[pxe-bridge] Creating note for chainId:",
        params.chainId,
        "tradeId:",
        params.tradeId,
        "subTrade:",
        params.subTradeIndex + "/" + params.totalSubTrades,
      );
    } else {
      console.log("[pxe-bridge] Creating note for chainId:", params.chainId);
    }

    const submit = async () => {
      if (this.spendingLimitContract) {
        // The hint must mask live storage POSITIONALLY, so it has to be read
        // fresh: check_spending_public re-derives the allowlist at inclusion
        // time and rejects a hint built against a superseded list. Carrying
        // every live slot maximises the set the recipient hides in; the
        // contract only enforces a floor.
        //
        // The declared amount and recipient are NOT set here. The entrypoint
        // reads them off the payload it is signing, so there is no per-call
        // state for a concurrent send to overwrite and nothing to serialize
        // around.
        this.spendingLimitContract.setAllowlistHint(await this.readAllowlist());
      }

      return withTimeout(
        token.methods.transfer_to_private(recipientAddress, amount).send({ from }),
        TX_TIMEOUT_MS,
      );
    };

    let result: unknown;
    try {
      result = await submit();
    } catch (err) {
      // A deadline is the one ambiguous case: send() may already have
      // broadcast. Everything else here failed while building, proving or
      // simulating, before the network saw anything, or landed as a revert
      // that moved no funds.
      if (err instanceof TimeoutError) {
        throw new PostSubmissionError(
          `Transaction did not confirm within ${TX_TIMEOUT_MS}ms and may still be included`,
          undefined,
          { cause: err },
        );
      }
      throw err;
    }

    // Past this point the transfer is on chain. Everything below reads the
    // result back, so a failure here is a reporting failure over a transfer
    // that already happened, and must not be reported as a clean rejection.
    return await this.readNoteResult(result);
  }

  /**
   * Turns a settled send into a CreateNoteResult.
   *
   * Split out so every throw on this path is a PostSubmissionError: the
   * transfer has landed by the time any of it runs.
   */
  private async readNoteResult(result: unknown): Promise<CreateNoteResult> {
    const raw = result as unknown as Record<string, unknown>;
    const receiptInner =
      typeof raw["receipt"] === "object" && raw["receipt"] !== null
        ? (raw["receipt"] as Record<string, unknown>)
        : raw;

    const rawTxHash = receiptInner["txHash"] ?? raw["txHash"];
    if (rawTxHash === undefined || rawTxHash === null) {
      throw new PostSubmissionError("Missing txHash in transaction receipt");
    }
    const txHash = String(rawTxHash);

    // v5 dropped noteCommitments/nullifierHashes from the receipt. The note
    // hashes and nullifiers live on the tx effect, which send() does not
    // attach, so it has to be fetched. Reading the old fields silently yielded
    // undefined and every successful transfer reported "Incomplete transaction
    // receipt".
    const node = (this.wallet as unknown as { aztecNode: AztecNodeLike }).aztecNode;
    let detailed;
    try {
      detailed = await node.getTxReceipt(rawTxHash as never, { includeTxEffect: true });
    } catch (err) {
      throw new PostSubmissionError(
        "Transfer landed but its effects could not be read back",
        txHash,
        { cause: err },
      );
    }
    const effect = detailed?.txEffect?.data ?? detailed?.txEffect;

    // A transfer_to_private emits 2 note hashes and 3 nullifiers, so no single
    // value identifies the note. Return both sets and let the caller choose,
    // rather than picking an index here and calling it "the" note.
    const noteHashes = (effect?.noteHashes ?? []).map((h) => h.toString());
    const nullifiers = (effect?.nullifiers ?? []).map((n) => n.toString());

    const noteCommitment = noteHashes[0];
    const nullifierHash = nullifiers[0];
    if (!noteCommitment || !nullifierHash) {
      // The node has the transaction but not yet its effects. The transfer
      // happened; only this read is early.
      throw new PostSubmissionError("Incomplete transaction receipt", txHash);
    }

    console.log("[pxe-bridge] Note created, txHash:", txHash);

    return { noteHashes, nullifiers, l2TxHash: txHash, noteCommitment, nullifierHash };
  }

  async getVersion(): Promise<string> {
    if (!this.wallet) {
      throw new Error("Client not connected");
    }

    const info = this.wallet as unknown as Record<string, unknown>;
    if (typeof info["getNodeInfo"] === "function") {
      const nodeInfo = await (info["getNodeInfo"] as () => Promise<Record<string, unknown>>)();
      return String(nodeInfo["nodeVersion"] ?? "unknown");
    }

    return "unknown";
  }

  /**
   * Reads the account's allowlist slots via its get_allowlist utility function.
   * Returns entries in slot order, zero-padded, which is the shape the
   * entrypoint's allowlist_hint expects.
   */
  private async readAllowlist(): Promise<string[]> {
    if (!this.wallet || !this.solverAddress || !this.spendingLimitContract) {
      throw new Error("Spending limit account not initialized");
    }
    const { Contract } = await import("@aztec/aztec.js/contracts");
    const artifact = await this.spendingLimitContract.getContractArtifact();
    const account = await Contract.at(
      this.solverAddress as Parameters<typeof Contract.at>[0],
      artifact as Parameters<typeof Contract.at>[1],
      this.wallet as unknown as Parameters<typeof Contract.at>[2],
    );
    // `from` scopes the utility execution. Without it PXE throws, and its own
    // error formatter then crashes on undefined args, masking the cause.
    const entries = (await account.methods["get_allowlist"]!().simulate({
      from: this.solverAddress,
    })) as unknown;

    // simulate() resolves to { result, offchainEffects, offchainMessages };
    // the utility's [Field; N] return value is under `result`.
    const value = (entries as { result?: unknown })?.result ?? entries;
    const raw: unknown[] = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.values(value as Record<string, unknown>)
        : [];
    if (raw.length !== ALLOWLIST_SIZE) {
      throw new Error(
        `get_allowlist returned ${raw.length} entries, expected ${ALLOWLIST_SIZE}`,
      );
    }

    return raw.map((e) => {
      const v = typeof e === "bigint" ? e : BigInt((e as { toString(): string }).toString());
      return "0x" + v.toString(16).padStart(64, "0");
    });
  }

  /**
   * Whether the account exists ON CHAIN.
   *
   * This must ask the node, not the PXE. AccountManager.create() registers the
   * instance with the local PXE before anything is deployed, so a PXE-side
   * lookup always answers "yes": connect() would log "Account recovered", skip
   * the constructor, and leave the signing-key note uncreated. Every later
   * transaction then fails inside is_valid_impl with "Failed to get a note".
   * That went unnoticed because no test ever sent a transaction from an
   * account this client had deployed.
   */
  private async isContractDeployed(address: AztecAddress): Promise<boolean> {
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    const node = createAztecNodeClient(this.nodeUrl);
    const instance = await node.getContract(address);
    return instance !== undefined;
    // NOTE: this reflects PUBLICATION. We do not force publication on deploy
    // (it raised the fee beyond what SponsoredFPC covers), so a deployed but
    // unpublished account reads as absent here. That is why the concurrent
    // deploy path also treats "Existing nullifier" as success -- the init
    // nullifier is the signal that survives either way.
  }

  /**
   * `maxFeesPerGas` for the account deployment, with headroom over the worst
   * fee predicted for the inclusion window.
   *
   * The SDK's own estimate is a point prediction and goes stale. A single
   * unrelated account deployment landing between the estimate and validation
   * was enough to fail this with "maxFeesPerGas.feePerL2Gas must be greater
   * than or equal to gasFees.feePerL2Gas" at 9748636365 against a base fee of
   * 95484800000, roughly 10x.
   *
   * `getPredictedMinFees` returns the current slot's fees followed by one entry
   * per predicted slot, so taking the maximum covers the whole window rather
   * than the instant of the estimate. The multiplier is on top of that.
   *
   * Overshooting is close to free: the max is a ceiling, and what is actually
   * charged is the base fee at inclusion. Undershooting fails startup, so the
   * asymmetry justifies a wide margin.
   */
  private async deployGasSettings(): Promise<{ maxFeesPerGas: GasFees }> {
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    const { GasFees, ManaUsageEstimate } = await import("@aztec/stdlib/gas");

    const node = createAztecNodeClient(this.nodeUrl);
    const predicted = await node.getPredictedMinFees(ManaUsageEstimate.Limit);

    const worst = predicted.reduce(
      (acc, fees) => ({
        da: fees.feePerDaGas > acc.da ? fees.feePerDaGas : acc.da,
        l2: fees.feePerL2Gas > acc.l2 ? fees.feePerL2Gas : acc.l2,
      }),
      { da: 0n, l2: 0n },
    );

    return {
      maxFeesPerGas: new GasFees(
        worst.da * DEPLOY_FEE_HEADROOM,
        worst.l2 * DEPLOY_FEE_HEADROOM,
      ),
    };
  }

  private async buildFeePaymentMethod(
    accountAddress: AztecAddress,
  ): Promise<import("@aztec/aztec.js/fee").FeePaymentMethod> {
    // A claim commits to its L2 recipient in the message hash, so it can only
    // pay for the account it was bridged to. The deployer is a different
    // account; handing it the solver's claim fails the message lookup with
    // "No L1 to L2 message found for message hash".
    const claimIsForThisAccount =
      this.solverAddress !== null && this.solverAddress.equals(accountAddress);

    if (this.feeJuiceClaim && claimIsForThisAccount) {
      console.log("[pxe-bridge] Using Fee Juice claim for deployment fee");
      const { FeeJuicePaymentMethodWithClaim } = await import("@aztec/aztec.js/fee");
      const { Fr } = await import("@aztec/aztec.js/fields");
      return new FeeJuicePaymentMethodWithClaim(accountAddress, {
        claimAmount: BigInt(this.feeJuiceClaim.claimAmount),
        claimSecret: Fr.fromString(this.feeJuiceClaim.claimSecret),
        messageLeafIndex: BigInt(this.feeJuiceClaim.messageLeafIndex),
      });
    }

    console.log("[pxe-bridge] Using SponsoredFPC for deployment fee");
    const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee/testing");
    const { getContractInstanceFromInstantiationParams } = await import("@aztec/stdlib/contract");
    const { Fr } = await import("@aztec/aztec.js/fields");

    const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContract.artifact,
      { salt: new Fr(0) },
    );
    await this.wallet!.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
    return new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);
  }

  private async getToken(address: AztecAddress): Promise<TokenContract> {
    const key = address.toString();
    const cached = this.tokenCache.get(key);
    if (cached) return cached;

    if (!this.wallet) throw new Error("Client not connected");
    const contract = await TokenContract.at(
      address as Parameters<typeof TokenContract.at>[0],
      this.wallet as unknown as Parameters<typeof TokenContract.at>[1],
    );
    if (this.tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
      const oldest = this.tokenCache.keys().next().value;
      if (oldest !== undefined) this.tokenCache.delete(oldest);
    }
    this.tokenCache.set(key, contract);
    return contract;
  }
}
