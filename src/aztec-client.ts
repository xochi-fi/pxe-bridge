import { createHash } from "node:crypto";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type {
  CreateNoteParams,
  CreateNoteResult,
  IAztecClient,
} from "./types.js";

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

  constructor(
    private readonly nodeUrl: string,
    secretKey: string,
  ) {
    this.secretKey = secretKey;
  }

  async connect(): Promise<void> {
    if (!this.secretKey) {
      throw new Error("Secret key already consumed");
    }

    console.log(`[pxe-bridge] Connecting to ${this.nodeUrl}`);

    this.wallet = await EmbeddedWallet.create(this.nodeUrl);
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

    const accountManager = await this.wallet.createSchnorrAccount(secret, salt);
    const account = await accountManager.getAccount();
    const address = account.getAddress();
    this.solverAddress = address;

    // Deploy account contract if first time
    const existing = await this.wallet.getAccounts();
    const alreadyDeployed = existing.some(
      (a) => String(a) === address.toString(),
    );

    if (!alreadyDeployed) {
      console.log("[pxe-bridge] Deploying solver account...");

      const { SponsoredFeePaymentMethod } = await import(
        "@aztec/aztec.js/fee/testing"
      );
      const { getContractInstanceFromInstantiationParams } = await import(
        "@aztec/stdlib/contract"
      );

      // Register Sponsored FPC for fee-less account deployment
      const sponsoredFPCInstance =
        await getContractInstanceFromInstantiationParams(
          SponsoredFPCContract.artifact,
          { salt: new (await import("@aztec/aztec.js/fields")).Fr(0) },
        );
      await this.wallet!.registerContract(
        sponsoredFPCInstance,
        SponsoredFPCContract.artifact,
      );
      const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
        sponsoredFPCInstance.address,
      );

      const deployMethod = await accountManager.getDeployMethod();
      await deployMethod.send({
        from: address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });
      console.log("[pxe-bridge] Account deployed");
    } else {
      console.log("[pxe-bridge] Account recovered");
    }

    console.log("[pxe-bridge] Ready");
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
