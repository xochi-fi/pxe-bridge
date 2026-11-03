import { createPublicClient, getAddress, http, type Hex } from "viem";
import {
  OXIDE_DEPOSIT_PORTAL,
  OXIDE_PORTAL_ABI,
  type OxideDepositBlock,
  type OxideDepositChain,
  type OxideDepositReceipt,
  type OxideDepositTransaction,
  type OxidePortalState,
} from "./deposit.js";

/** Read-only mainnet client used by the deposit operator tool. */
export function viemOxideDepositChain(rpcUrl: string): OxideDepositChain {
  if (!rpcUrl) throw new Error("an L1 RPC URL is required");
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    chainId: () => client.getChainId(),
    receipt: async (txHash): Promise<OxideDepositReceipt> => {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success" && receipt.status !== "reverted") {
        throw new Error(`unknown receipt status ${String(receipt.status)}`);
      }
      return {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        to: receipt.to === null ? null : getAddress(receipt.to),
        logs: receipt.logs.map((log) => ({
          address: getAddress(log.address),
          data: log.data,
          topics: log.topics as readonly Hex[],
          logIndex: log.logIndex,
        })),
      };
    },
    transaction: async (txHash): Promise<OxideDepositTransaction> => {
      const transaction = await client.getTransaction({ hash: txHash });
      return {
        hash: transaction.hash,
        to: transaction.to === null ? null : getAddress(transaction.to),
        input: transaction.input,
        blockNumber: transaction.blockNumber,
        blockHash: transaction.blockHash,
      };
    },
    finalizedBlock: async (): Promise<OxideDepositBlock> => {
      const block = await client.getBlock({ blockTag: "finalized" });
      return {
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
      };
    },
    block: async (blockNumber): Promise<OxideDepositBlock> => {
      const block = await client.getBlock({ blockNumber });
      return {
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
      };
    },
    portalState: async (blockNumber, messageKey): Promise<OxidePortalState> => {
      const [
        underlying,
        l2Token,
        rollupVersion,
        txAmountCap,
        depositMessageIndex,
      ] = await Promise.all([
        client.readContract({
          address: OXIDE_DEPOSIT_PORTAL,
          abi: OXIDE_PORTAL_ABI,
          functionName: "UNDERLYING",
          blockNumber,
        }),
        client.readContract({
          address: OXIDE_DEPOSIT_PORTAL,
          abi: OXIDE_PORTAL_ABI,
          functionName: "L2_TOKEN",
          blockNumber,
        }),
        client.readContract({
          address: OXIDE_DEPOSIT_PORTAL,
          abi: OXIDE_PORTAL_ABI,
          functionName: "ROLLUP_VERSION",
          blockNumber,
        }),
        client.readContract({
          address: OXIDE_DEPOSIT_PORTAL,
          abi: OXIDE_PORTAL_ABI,
          functionName: "TX_AMOUNT_CAP",
          blockNumber,
        }),
        client.readContract({
          address: OXIDE_DEPOSIT_PORTAL,
          abi: OXIDE_PORTAL_ABI,
          functionName: "$depositMessageIndex",
          args: [messageKey],
          blockNumber,
        }),
      ]);
      return {
        underlying: getAddress(underlying),
        l2Token,
        rollupVersion,
        txAmountCap,
        depositMessageIndex,
      };
    },
  };
}
