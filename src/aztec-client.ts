import { createHash } from "node:crypto";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type {
  CreateNoteParams,
  CreateNoteResult,
  FeeJuiceClaim,
  IAztecClient,
} from "./types.js";
import {
  SpendingLimitAccountContract,
  type SpendingLimitConfig,
} from "./spending-limit-account.js";

const MAX_TOKEN_CACHE_SIZE = 100;
const TX_TIMEOUT_MS = 120_000; // 2 minutes

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Operation timed out")), ms);
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
    const salt = Fr.fromBuffer(saltBytes);

    keyBytes.fill(0);
    saltBytes.fill(0);
    // Note: Fr objects (secret, salt) hold key material on the JS heap
    // until GC'd after connect() returns. The wallet also retains the
    // signing key internally -- we cannot zero SDK-owned memory.

    const accountManager = this.spendingLimitConfig
      ? await this.createSpendingLimitAccount(secret, salt)
      : await this.wallet.createSchnorrAccount(secret, salt);

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

      const deployMethod = await accountManager.getDeployMethod();
      // Self-deployment: NO_FROM tells EmbeddedWallet.sendTx() to use
      // DefaultEntrypoint (bypassing account lookup in WalletDB), and
      // DeployAccountMethod maps it to deployer=AztecAddress.ZERO which
      // triggers the multicall self-deploy path where the contract is
      // constructed before it pays for its own fee.
      try {
        await deployMethod.send({
          from: NO_FROM,
          fee: { paymentMethod },
        });
        console.log("[pxe-bridge] Account deployed");
      } catch (err) {
        // Another instance may have deployed concurrently
        if (await this.isContractDeployed(address)) {
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
    const { deriveSigningKey } = await import("@aztec/stdlib/keys");

    const signingKey = deriveSigningKey(secret);

    this.spendingLimitContract = new SpendingLimitAccountContract(
      signingKey,
      this.spendingLimitConfig!,
    );

    const accountManager = await AccountManager.create(
      this.wallet! as unknown as Parameters<typeof AccountManager.create>[0],
      secret,
      this.spendingLimitContract,
      salt,
    );

    // Register the contract artifact with PXE so proving works.
    const instance = accountManager.getInstance();
    const w = this.wallet as unknown as Record<string, unknown>;
    const pxe = w["pxe"] as {
      getContractInstance: (addr: AztecAddress) => Promise<unknown>;
      getContractArtifact: (classId: unknown) => Promise<unknown>;
    };
    const existingInstance = await pxe.getContractInstance(instance.address);
    if (!existingInstance) {
      const existingArtifact = await pxe.getContractArtifact(
        instance.currentContractClassId,
      );
      const artifact = existingArtifact
        ? undefined
        : await this.spendingLimitContract.getContractArtifact();
      await this.wallet!.registerContract(instance, artifact, secret);
    }

    // Store in WalletDB as 'schnorr' so simulation can find the account.
    // The actual send uses our custom entrypoint via the patched method below.
    const db = w["walletDB"] as {
      storeAccount: (
        addr: AztecAddress,
        data: Record<string, unknown>,
      ) => Promise<void>;
    };
    await db.storeAccount(instance.address, {
      type: "schnorr",
      secretKey: secret,
      salt,
      alias: "",
      signingKey: signingKey.toBuffer(),
    });

    // Patch getAccountFromAddress so the real tx send path uses our
    // custom entrypoint (with declared_amount/declared_recipient) instead
    // of reconstructing a standard Schnorr account from WalletDB.
    const customAccount = await accountManager.getAccount();
    const walletAny = this.wallet as unknown as {
      getAccountFromAddress: (addr: AztecAddress) => Promise<unknown>;
    };
    const originalGetAccount =
      walletAny.getAccountFromAddress.bind(this.wallet);
    walletAny.getAccountFromAddress = async (addr: AztecAddress) => {
      if (addr.equals(instance.address)) {
        return customAccount;
      }
      return originalGetAccount(addr);
    };

    return accountManager;
  }

  async createNote(params: CreateNoteParams): Promise<CreateNoteResult> {
    if (!this.wallet || !this.solverAddress) {
      throw new Error("Client not connected");
    }

    const { AztecAddress } = await import("@aztec/aztec.js/addresses");

    const tokenAddress = AztecAddress.fromString(params.token);
    const recipientAddress = AztecAddress.fromString(params.recipient);
    const amount = BigInt(params.amount);
    const from = this.solverAddress;

    // Bind declared spending to the next tx for on-chain enforcement.
    // The entrypoint signs over (payloadHash, amount, recipient) so these
    // values cannot be forged. Must be set before send().
    if (this.spendingLimitContract) {
      this.spendingLimitContract.setDeclaredSpending(amount, params.recipient);
    }

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

    const result = await withTimeout(
      token.methods
        .transfer_to_private(recipientAddress, amount)
        .send({ from }),
      TX_TIMEOUT_MS,
    );

    const raw = result as unknown as Record<string, unknown>;
    const receiptInner = (raw["receipt"] ?? raw) as Record<string, unknown>;

    const txHash = String(receiptInner["txHash"] ?? raw["txHash"]);
    if (!txHash || txHash === "undefined") {
      throw new Error("Missing txHash in transaction receipt");
    }

    const commitments = receiptInner["noteCommitments"] as
      | unknown[]
      | undefined;
    const nullifiers = receiptInner["nullifierHashes"] as unknown[] | undefined;
    const noteCommitment = commitments?.[0]?.toString();
    const nullifierHash = nullifiers?.[0]?.toString();

    if (!noteCommitment || !nullifierHash) {
      throw new Error("Incomplete transaction receipt");
    }

    console.log("[pxe-bridge] Note created, txHash:", txHash);

    return { noteCommitment, nullifierHash, l2TxHash: txHash };
  }

  async getVersion(): Promise<string> {
    if (!this.wallet) {
      throw new Error("Client not connected");
    }

    const info = this.wallet as unknown as Record<string, unknown>;
    if (typeof info["getNodeInfo"] === "function") {
      const nodeInfo = await (
        info["getNodeInfo"] as () => Promise<Record<string, unknown>>
      )();
      return String(nodeInfo["nodeVersion"] ?? "unknown");
    }

    return "unknown";
  }

  private async isContractDeployed(address: AztecAddress): Promise<boolean> {
    const w = this.wallet as unknown as Record<string, unknown>;
    if (!w["pxe"] || typeof w["pxe"] !== "object") {
      throw new Error("Wallet missing PXE interface");
    }
    const pxe = w["pxe"] as {
      getContractInstance: (addr: AztecAddress) => Promise<unknown>;
    };
    if (typeof pxe.getContractInstance !== "function") {
      throw new Error("PXE missing getContractInstance method");
    }
    const instance = await pxe.getContractInstance(address);
    return instance !== undefined;
  }

  private async buildFeePaymentMethod(
    accountAddress: AztecAddress,
  ): Promise<import("@aztec/aztec.js/fee").FeePaymentMethod> {
    if (this.feeJuiceClaim) {
      console.log("[pxe-bridge] Using Fee Juice claim for deployment fee");
      const { FeeJuicePaymentMethodWithClaim } =
        await import("@aztec/aztec.js/fee");
      const { Fr } = await import("@aztec/aztec.js/fields");
      return new FeeJuicePaymentMethodWithClaim(accountAddress, {
        claimAmount: BigInt(this.feeJuiceClaim.claimAmount),
        claimSecret: Fr.fromString(this.feeJuiceClaim.claimSecret),
        messageLeafIndex: BigInt(this.feeJuiceClaim.messageLeafIndex),
      });
    }

    console.log("[pxe-bridge] Using SponsoredFPC for deployment fee");
    const { SponsoredFeePaymentMethod } =
      await import("@aztec/aztec.js/fee/testing");
    const { getContractInstanceFromInstantiationParams } =
      await import("@aztec/stdlib/contract");
    const { Fr } = await import("@aztec/aztec.js/fields");

    const sponsoredFPCInstance =
      await getContractInstanceFromInstantiationParams(
        SponsoredFPCContract.artifact,
        { salt: new Fr(0) },
      );
    await this.wallet!.registerContract(
      sponsoredFPCInstance,
      SponsoredFPCContract.artifact,
    );
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
