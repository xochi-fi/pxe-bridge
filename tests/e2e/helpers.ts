import type { FeeJuiceClaim } from "../../src/types.js";
import { FeeJuiceClaimSchema } from "../../src/types.js";

export interface E2EConfig {
  nodeUrl: string;
  secretKey: string;
  bridgePort: number;
  feeJuiceClaim?: FeeJuiceClaim;
}

// Test-only key well under BN254 Fr modulus -- never use with real funds
const DEFAULT_SECRET_KEY = "0x000000000000000000000000000000000000000000000000000000000000beef";

export function getTestConfig(): E2EConfig {
  let feeJuiceClaim: FeeJuiceClaim | undefined;
  const raw = process.env["FEE_JUICE_CLAIM"];
  if (raw) {
    const parsed = FeeJuiceClaimSchema.safeParse(JSON.parse(raw));
    if (parsed.success) feeJuiceClaim = parsed.data;
  }

  return {
    nodeUrl: process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080",
    secretKey: process.env["PXE_BRIDGE_SECRET_KEY"] ?? DEFAULT_SECRET_KEY,
    bridgePort: 0, // let OS pick
    feeJuiceClaim,
  };
}

export async function waitForNode(url: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  const statusUrl = url.replace(/\/$/, "") + "/status";

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(statusUrl);
      if (res.ok) return;
    } catch {
      // node not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Aztec node at ${url} did not become ready within ${timeoutMs}ms`);
}

/**
 * SponsoredFPC payment method, so a test account with no fee juice can still
 * send transactions. The bridge uses the same mechanism for its own account
 * deployment; without it every send() fails with "Not enough balance for fee
 * payer to pay for transaction".
 */
export async function sponsoredFee(wallet: unknown): Promise<unknown> {
  const { SponsoredFPCContract } = await import("@aztec/noir-contracts.js/SponsoredFPC");
  const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee/testing");
  const { getContractInstanceFromInstantiationParams } = await import("@aztec/stdlib/contract");
  const { Fr } = await import("@aztec/aztec.js/fields");

  const instance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await (wallet as {
    registerContract: (i: unknown, a: unknown) => Promise<unknown>;
  }).registerContract(instance, SponsoredFPCContract.artifact);
  return new SponsoredFeePaymentMethod(instance.address);
}

// Anvil's first default account. docker-compose starts anvil with the stock
// mnemonic, so this key is funded on L1 and is test-only by construction.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const L1_RPC = process.env["L1_RPC_URL"] ?? "http://localhost:8545";

/**
 * Gives `recipient` a fee juice balance, bridging from L1 and then claiming on
 * its behalf from `wallet`.
 *
 * The spending-limit account has to pay its own way with PREEXISTING_FEE_JUICE,
 * and it cannot obtain that fee juice itself. Every other payment method
 * contributes a call -- SponsoredFPC adds `sponsor_unconditionally`,
 * FeeJuicePaymentMethodWithClaim adds `claim_and_end_setup` -- and BaseWallet
 * merges that call into the SAME AppPayload the entrypoint receives
 * (mergeExecutionPayloads). It would arrive alongside the transfer and the
 * single-call guard would reject the tx with "Expected exactly one call in
 * payload".
 *
 * FeeJuice.claim names its recipient in an argument rather than taking the
 * caller, so a third party can consume the message and credit this account.
 * PREEXISTING_FEE_JUICE is also the only entrypoint branch that calls
 * end_setup(), which is the phase boundary the over-limit test exists to pin.
 */
export async function fundFeeJuice(
  nodeUrl: string,
  wallet: unknown,
  payer: string,
  recipient: string,
  amount: bigint,
  onBlockNeeded: () => Promise<void>,
): Promise<void> {
  const claim = await bridgeFeeJuice(nodeUrl, recipient, amount, onBlockNeeded);

  const { FeeJuiceContract } = await import("@aztec/noir-contracts.js/FeeJuice");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const { ProtocolContractAddress } = await import("@aztec/protocol-contracts");
  const { Fr } = await import("@aztec/aztec.js/fields");

  const feeJuice = await (
    FeeJuiceContract as unknown as {
      at: (a: unknown, w: unknown) => Promise<{
        methods: Record<
          string,
          (...a: unknown[]) => { send: (o: { from: unknown; fee: unknown }) => Promise<unknown> }
        >;
      }>;
    }
  ).at(ProtocolContractAddress.FeeJuice, wallet);

  await feeJuice.methods["claim"]!(
    AztecAddress.fromStringUnsafe(recipient),
    BigInt(claim.claimAmount),
    Fr.fromString(claim.claimSecret),
    new Fr(BigInt(claim.messageLeafIndex)),
  ).send({
    from: AztecAddress.fromStringUnsafe(payer),
    fee: { paymentMethod: await sponsoredFee(wallet) },
  });
}

/** Bridges fee juice from L1 to `recipient` and returns the unclaimed claim. */
export async function bridgeFeeJuice(
  nodeUrl: string,
  recipient: string,
  amount: bigint,
  onBlockNeeded: () => Promise<void>,
): Promise<FeeJuiceClaim> {
  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  const { L1FeeJuicePortalManager } = await import("@aztec/aztec.js/ethereum");
  const { createExtendedL1Client } = await import("@aztec/ethereum/client");
  const { createLogger } = await import("@aztec/aztec.js/log");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");

  const node = createAztecNodeClient(nodeUrl);
  const l1Client = createExtendedL1Client([L1_RPC], ANVIL_KEY);
  const manager = await L1FeeJuicePortalManager.new(
    node as Parameters<typeof L1FeeJuicePortalManager.new>[0],
    l1Client,
    createLogger("e2e:fee-juice"),
  );

  const claim = await manager.bridgeTokensPublic(
    AztecAddress.fromStringUnsafe(recipient),
    amount,
    true,
  );

  // The message is only spendable once the sequencer has pulled it off L1 and
  // built it into the tree, which needs L2 blocks. Claiming earlier fails with
  // "No L1 to L2 message found for message hash".
  await waitForL1ToL2Message(node, claim.messageHash, onBlockNeeded);

  return {
    claimAmount: claim.claimAmount.toString(),
    claimSecret: claim.claimSecret.toString(),
    messageLeafIndex: claim.messageLeafIndex.toString(),
  };
}

async function waitForL1ToL2Message(
  node: { getL1ToL2MessageMembershipWitness: (b: string, m: unknown) => Promise<unknown> },
  messageHash: string,
  onBlockNeeded: () => Promise<void>,
  attempts = 12,
): Promise<void> {
  const { Fr } = await import("@aztec/aztec.js/fields");
  const message = Fr.fromString(messageHash);

  for (let i = 0; i < attempts; i++) {
    const witness = await node.getL1ToL2MessageMembershipWitness("latest", message);
    if (witness !== undefined) return;
    // An idle sandbox may not build a block on its own, so drive one.
    await onBlockNeeded();
  }

  throw new Error(`L1 to L2 message ${messageHash} was not synced after ${attempts} blocks`);
}

/**
 * Sends one cheap transaction, so the sequencer builds an L2 block. Mints are
 * the cheapest thing the funder is already able to do.
 */
export async function mintOne(
  wallet: unknown,
  token: string,
  minter: string,
): Promise<void> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const minterAddress = AztecAddress.fromStringUnsafe(minter);
  const contract = await (
    TokenContract as unknown as {
      at: (a: unknown, w: unknown) => Promise<{
        methods: Record<
          string,
          (...a: unknown[]) => { send: (o: { from: unknown; fee: unknown }) => Promise<unknown> }
        >;
      }>;
    }
  ).at(AztecAddress.fromStringUnsafe(token), wallet);

  await contract.methods["mint_to_public"]!(minterAddress, 1n).send({
    from: minterAddress,
    fee: { paymentMethod: await sponsoredFee(wallet) },
  });
}

/**
 * Deploys an 18-decimal test token with `admin` as its minter.
 *
 * v5.1.0 requires an explicit `from` on send(), and send() resolves to
 * { contract, instance, receipt } after waiting -- not to the contract itself.
 * This helper had never been called (the note tests skip without
 * E2E_TOKEN_ADDRESS) so both mismatches went unnoticed.
 */
export async function deployTestToken(wallet: unknown, admin: string): Promise<string> {
  const { TokenContract } = await import("@aztec/noir-contracts.js/Token");
  const { AztecAddress } = await import("@aztec/aztec.js/addresses");
  const adminAddress = AztecAddress.fromStringUnsafe(admin);

  const { contract } = await (
    TokenContract as unknown as {
      deploy: (
        wallet: unknown,
        admin: unknown,
        name: string,
        symbol: string,
        decimals: number,
      ) => {
        send: (o: { from: unknown; fee: unknown }) => Promise<{
          contract: { address: { toString: () => string } };
        }>;
      };
    }
  )
    .deploy(wallet, adminAddress, "TestToken", "TST", 18)
    .send({ from: adminAddress, fee: { paymentMethod: await sponsoredFee(wallet) } });

  return contract.address.toString();
}
