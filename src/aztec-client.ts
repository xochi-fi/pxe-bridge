import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import type { CreateNoteParams, CreateNoteResult } from "./types.js";

/**
 * Wraps Aztec SDK v4 for server-side shielded note creation.
 *
 * Uses EmbeddedWallet (Node.js entrypoint, no browser APIs)
 * with a Schnorr account derived from PXE_BRIDGE_SECRET_KEY.
 * Acts as the solver account that creates shielded notes
 * on behalf of EVM settlement.
 */
export class AztecClient {
  private wallet: EmbeddedWallet | null = null;
  private solverAddress: unknown = null;
  private tokenCache = new Map<string, TokenContract>();

  constructor(
    private readonly nodeUrl: string,
    private readonly secretKey: string,
  ) {}

  async connect(): Promise<void> {
    console.log(`[pxe-bridge] Connecting to ${this.nodeUrl}`);

    this.wallet = await EmbeddedWallet.create(this.nodeUrl);
    console.log("[pxe-bridge] EmbeddedWallet created");

    const { Fr } = await import("@aztec/aztec.js/fields");

    const rawKey = Buffer.from(this.secretKey.replace(/^0x/, ""), "hex");
    // Pad to 32 bytes if shorter (Fr requires 32 bytes)
    const keyBytes = Buffer.alloc(32);
    rawKey.copy(keyBytes, 32 - rawKey.length);
    const secret = Fr.fromBuffer(keyBytes);
    const saltBytes = Buffer.from(keyBytes).reverse();
    const salt = Fr.fromBuffer(saltBytes);

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
      const deployMethod = await accountManager.getDeployMethod();
      await deployMethod.send({ from: address });
      console.log("[pxe-bridge] Account deployed:", address.toString());
    } else {
      console.log("[pxe-bridge] Account recovered:", address.toString());
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
    const from = this.solverAddress as InstanceType<typeof AztecAddress>;

    const token = await this.getToken(tokenAddress);

    console.log("[pxe-bridge] Creating note:", {
      recipient: params.recipient,
      token: params.token,
      amount: params.amount,
      chainId: params.chainId,
    });

    const result = await token.methods
      .transfer_to_private(recipientAddress, amount)
      .send({ from });

    const receipt = result as unknown as Record<string, unknown>;
    const txHash = String(
      (receipt["receipt"] as Record<string, unknown>)?.["txHash"] ?? receipt["txHash"] ?? "unknown",
    );

    const receiptInner = (receipt["receipt"] ?? receipt) as Record<string, unknown>;
    const commitments = receiptInner["noteCommitments"] as unknown[] | undefined;
    const nullifiers = receiptInner["nullifierHashes"] as unknown[] | undefined;

    const noteCommitment = commitments?.[0]?.toString() ?? txHash;
    const nullifierHash = nullifiers?.[0]?.toString() ?? txHash;

    console.log("[pxe-bridge] Note created:", { txHash, noteCommitment, nullifierHash });

    return { noteCommitment, nullifierHash, l2TxHash: txHash };
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

  private async getToken(address: unknown): Promise<TokenContract> {
    const key = String(address);
    const cached = this.tokenCache.get(key);
    if (cached) return cached;

    if (!this.wallet) throw new Error("Client not connected");
    const contract = await TokenContract.at(
      address as Parameters<typeof TokenContract.at>[0],
      this.wallet as unknown as Parameters<typeof TokenContract.at>[1],
    );
    this.tokenCache.set(key, contract);
    return contract;
  }
}
