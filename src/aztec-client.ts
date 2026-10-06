import { createHash } from "node:crypto";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { FeePaymentMethod } from "@aztec/aztec.js/fee";
import type { Fr } from "@aztec/aztec.js/fields";
import type { GasFees } from "@aztec/stdlib/gas";
import { PostSubmissionError } from "./types.js";
import type { CreateNoteParams, CreateNoteResult, FeeJuiceClaim, IAztecClient } from "./types.js";
import {
  SpendingLimitAccountContract,
  type SpendingLimitConfig,
} from "./spending-limit-account.js";

const MAX_TOKEN_CACHE_SIZE = 100;
export const TX_TIMEOUT_MS = 120_000; // 2 minutes

// Multiplier applied to the worst predicted base fee. Named for the deploy
// because that is where it was first needed, but it is not deploy-specific:
// the max is a ceiling rather than a charge, so this trades an unused
// allowance for not failing during a congestion spike, and that trade is the
// same for any send.
const FEE_HEADROOM = 10n;

/**
 * `maxFeesPerGas` with headroom over the worst fee predicted for the inclusion
 * window.
 *
 * The SDK's own estimate is a point prediction and goes stale. A single
 * unrelated account deployment landing between the estimate and validation was
 * enough to fail with "maxFeesPerGas.feePerL2Gas must be greater than or equal
 * to gasFees.feePerL2Gas" at 9748636365 against a base fee of 95484800000,
 * roughly 10x.
 *
 * `getPredictedMinFees` returns the current slot's fees followed by one entry
 * per predicted slot, so taking the maximum covers the whole window rather than
 * the instant of the estimate. The multiplier is on top of that.
 *
 * Overshooting is close to free: the max is a ceiling, and what is charged is
 * the base fee at inclusion. Undershooting fails the send, so the asymmetry
 * justifies a wide margin.
 *
 * Exported because the e2e suite needs the same treatment and had none. Its
 * sends took the SDK default and flaked on exactly the failure above, right
 * after a test deployed an account of its own. One implementation rather than
 * two that drift, the same reason fee-juice.ts was promoted out of the helpers.
 */
export async function headroomGasSettings(nodeUrl: string): Promise<{ maxFeesPerGas: GasFees }> {
  const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
  const { GasFees, ManaUsageEstimate } = await import("@aztec/stdlib/gas");

  const node = createAztecNodeClient(nodeUrl);
  const predicted = await node.getPredictedMinFees(ManaUsageEstimate.Limit);

  const worst = predicted.reduce(
    (acc, fees) => ({
      da: fees.feePerDaGas > acc.da ? fees.feePerDaGas : acc.da,
      l2: fees.feePerL2Gas > acc.l2 ? fees.feePerL2Gas : acc.l2,
    }),
    { da: 0n, l2: 0n },
  );

  return {
    maxFeesPerGas: new GasFees(worst.da * FEE_HEADROOM, worst.l2 * FEE_HEADROOM),
  };
}

/**
 * Why a fee juice claim and the spending-limit account cannot be combined.
 *
 * The claim is bridged to the account it names, so `buildFeePaymentMethod`
 * hands the deploy a `FeeJuicePaymentMethodWithClaim` naming the limit account
 * while the deploy is sent from the separate deployer. Three things then go
 * wrong, any one of which is fatal:
 *
 *   1. The payment method's ExecutionPayload carries `feePayer = limit
 *      account`, and `BaseWallet.completeFeeOptions` gives the sending account
 *      `FEE_JUICE_WITH_CLAIM` only when `from.equals(feePayer)`. Here it does
 *      not, so the deployer's entrypoint gets `EXTERNAL`, whose branch in
 *      `authwit/account.nr` is a no-op.
 *   2. `FeeJuice.claim_and_end_setup` claims and calls `end_setup()`; it never
 *      calls `set_as_fee_payer`. With (1) nothing else does either, so the
 *      transaction has no fee payer at all.
 *   3. The claim credits the limit account, so even a fee payer that was set
 *      would be the deployer, paying from a balance the claim did not create.
 *
 * The supported paths are a claim bridged to the DEPLOYER, which pays for both
 * deploys (`DEPLOYER_FEE_JUICE_CLAIM_ENV`), and `scripts/top-up-fee-juice.ts`
 * for the account's running costs: it claims on the account's behalf from a
 * funded payer, leaving a PREEXISTING_FEE_JUICE balance, which is the only fee
 * branch this account can use.
 */
export const FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR =
  "FEE_JUICE_CLAIM cannot be used with the spending limit account: the claim " +
  "names the limit account while the deploy is sent from the deployer, so no " +
  "fee payer is set. Bridge to the deployer instead (npm run bridge-fee-juice -- " +
  "--deployer --recipient <Deployer address>) and set PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM; fund the account's " +
  "transfers with scripts/top-up-fee-juice.ts.";

/** A fee juice claim bridged to the spending-limit account's deployer. */
export const DEPLOYER_FEE_JUICE_CLAIM_ENV = "PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM";

/**
 * Why a deployer claim without the spending-limit account is refused.
 *
 * The deployer exists only to deploy the limit account. A plain Schnorr bridge
 * never derives it, so the claim would sit unconsumed while the operator
 * believed the deploy was paid for, and the bridge would fall through to
 * FEE_JUICE_CLAIM or SponsoredFPC instead.
 */
export const DEPLOYER_CLAIM_WITHOUT_SPENDING_LIMIT_ERROR =
  `${DEPLOYER_FEE_JUICE_CLAIM_ENV} is only used by the spending limit account, whose ` +
  "separate deployer it pays for; the plain Schnorr account never derives a deployer, so " +
  "the claim would go unused. Set PXE_BRIDGE_SPENDING_LIMIT_ADMIN, or bridge to the " +
  "account itself and use FEE_JUICE_CLAIM.";

/** Opts a production bridge into the SponsoredFPC deployment fee fallback. */
export const ALLOW_SPONSORED_FPC_ENV = "PXE_BRIDGE_ALLOW_SPONSORED_FPC";

export interface SponsoredFpcSetting {
  allowed: boolean;
  /** The setting that decided, as `NAME=value`, for the log. */
  reason: string;
}

/**
 * A boolean env flag: "true", "false", or unset. Anything else, the empty
 * string included, throws naming the variable, so a typo fails rather than
 * silently meaning either one.
 */
export function booleanEnv(env: Record<string, string | undefined>, name: string): boolean | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "false") return raw === "true";
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
}

/**
 * Whether an undeployed account may pay its deployment fee via SponsoredFPC.
 *
 * SponsoredFPC is a testing contract (`@aztec/aztec.js/fee/testing`) that
 * exists only on sandbox and testnet. It is what an account falls back to when
 * no FEE_JUICE_CLAIM covers it, and what the spending-limit deployer and
 * account use when no deployer claim is configured. On any other network there
 * is nothing at its address, and the deploy fails inside the SDK with a
 * message that names neither the fee path nor the configuration that chose it.
 *
 * Permitted outside production, which is where the sandbox and the e2e suite
 * run. In production only on explicit opt-in: the image sets
 * NODE_ENV=production for every deployment, testnet included, so NODE_ENV
 * alone cannot tell a testnet from a network that charges.
 *
 * Only "true" and "false" are accepted, so a typo fails at startup rather than
 * silently meaning either one. An empty value is rejected too: `VAR=` reads as
 * a deliberate setting, not as unset. `reason` names the variable that decided.
 */
export function sponsoredFpcSetting(env: Record<string, string | undefined>): SponsoredFpcSetting {
  const flag = booleanEnv(env, ALLOW_SPONSORED_FPC_ENV);
  if (flag !== undefined) {
    return { allowed: flag, reason: `${ALLOW_SPONSORED_FPC_ENV}=${flag}` };
  }
  return {
    allowed: env["NODE_ENV"] !== "production",
    reason: `NODE_ENV=${env["NODE_ENV"] ?? "(unset)"}`,
  };
}

export const SPONSORED_FPC_REFUSED_ERROR =
  "Refusing to pay its deployment fee via SponsoredFPC, a testing contract that exists " +
  "only on sandbox and testnet. It is refused when NODE_ENV=production unless " +
  `${ALLOW_SPONSORED_FPC_ENV}=true, and whenever ${ALLOW_SPONSORED_FPC_ENV}=false. For the ` +
  "plain Schnorr account, set FEE_JUICE_CLAIM (npm run bridge-fee-juice -- --recipient " +
  `<Account address>). For the spending-limit account, set ${DEPLOYER_FEE_JUICE_CLAIM_ENV} ` +
  "(npm run bridge-fee-juice -- --deployer --recipient <Deployer address>), which pays for " +
  "both the deployer and the account. Set " +
  `${ALLOW_SPONSORED_FPC_ENV}=true only if this node is a sandbox or testnet.`;

/**
 * State of the configured deployer claim's L1 to L2 message, or with no claim
 * configured, whether the deployer's fee juice balance funds a deploy
 * (`funded`, see `balanceFundsDeploy`) or not (`absent`).
 */
export type DeployerClaimState = "absent" | "funded" | "unspent" | "spent";

/**
 * How the spending-limit account's deployment, sent from the deployer, is paid.
 *
 * - `sponsored`: no deployer claim and no balance that funds a deploy; SponsoredFPC,
 *   subject to `sponsoredFpcSetting`.
 * - `claim`: the claim is unspent, because the deployer was initialized by
 *   other means (another run, a manual deploy). The deploy consumes it, with
 *   the deployer as both sender and fee payer.
 * - `preexisting`: the claim is spent, normally by the deployer's own deploy
 *   on this or an earlier run, or there is no claim and the deployer holds
 *   fee juice (a top-up, a claim since removed). The deployer pays from its
 *   balance.
 */
function limitAccountFeePath(claim: DeployerClaimState): "sponsored" | "claim" | "preexisting" {
  switch (claim) {
    case "absent":
      return "sponsored";
    case "unspent":
      return "claim";
    case "spent":
    case "funded":
      return "preexisting";
  }
}

/**
 * Whether a send failed because its fee payer could not cover the fee: the
 * node's admission check (stdlib TX_ERROR_INSUFFICIENT_FEE_PAYER_BALANCE) or
 * the public simulator's assert, which EmbeddedWallet.sendTx's estimating
 * simulation hits first. Neither names the fee payer.
 */
function deployerUnderfunded(message: string): boolean {
  return (
    message.includes("Insufficient fee payer balance") ||
    message.includes("Not enough balance for fee payer")
  );
}

/**
 * Hash of the L1 to L2 message FeeJuicePortal.depositToAztecPublic emits for
 * `claim` bridged to `beneficiary`: the leaf FeeJuice.claim consumes.
 *
 * The sender is FEE_JUICE_ADDRESS, not the portal's L1 address: Inbox.sol
 * rewrites a message from FEE_ASSET_PORTAL to that magic address, and the
 * FeeJuice contract consumes it with portal_address = FEE_JUICE_ADDRESS.
 */
export async function feeJuiceMessageHash(
  beneficiary: string,
  claim: FeeJuiceClaim,
  l1ChainId: number,
  rollupVersion: number,
): Promise<string> {
  const { AztecAddress, EthAddress } = await import("@aztec/aztec.js/addresses");
  const { Fr } = await import("@aztec/aztec.js/fields");
  const { FEE_JUICE_ADDRESS } = await import("@aztec/constants");
  const { keccak256String } = await import("@aztec/foundation/crypto/keccak");
  const { sha256ToField } = await import("@aztec/foundation/crypto/sha256");
  const { toBufferBE } = await import("@aztec/foundation/bigint-buffer");
  const { ProtocolContractAddress } = await import("@aztec/protocol-contracts");
  const { computeSecretHash } = await import("@aztec/stdlib/hash");
  const { L1Actor, L1ToL2Message, L2Actor } = await import("@aztec/stdlib/messaging");

  // FeeJuicePortal.depositToAztecPublic:
  // sha256ToField(abi.encodeWithSignature("claim(bytes32,uint256)", to, amount)).
  const selector = Buffer.from(keccak256String("claim(bytes32,uint256)").replace(/^0x/, ""), "hex").subarray(0, 4);
  const content = sha256ToField([
    selector,
    AztecAddress.fromStringUnsafe(beneficiary).toBuffer(),
    toBufferBE(BigInt(claim.claimAmount), 32),
  ]);
  return new L1ToL2Message(
    new L1Actor(EthAddress.fromNumber(FEE_JUICE_ADDRESS), l1ChainId),
    new L2Actor(ProtocolContractAddress.FeeJuice, rollupVersion),
    content,
    await computeSecretHash(Fr.fromString(claim.claimSecret)),
    new Fr(BigInt(claim.messageLeafIndex)),
  )
    .hash()
    .toString();
}

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

/** What the account derivation produces, named so callers cannot swap two Frs. */
export interface AccountKeys {
  secret: import("@aztec/aztec.js/fields").Fr;
  salt: import("@aztec/aztec.js/fields").Fr;
  signingKey: ReturnType<
    typeof import("@aztec/stdlib/keys").deriveMasterMessageSigningSecretKey
  >;
}

/**
 * Derives the account material the bridge uses from its secret key.
 *
 * Exported because the operator scripts have to reach the same address, and
 * while they derived it themselves they drifted: `scripts/bridge-fee-juice.ts`
 * built the salt with `Fr.fromBuffer` and omitted the signing key, so it
 * produced a claim for the wrong account when it produced one at all.
 *
 * The intermediate buffers are zeroed here. The returned `Fr` objects still
 * hold key material on the JS heap until GC, and the wallet retains the signing
 * key internally -- SDK-owned memory cannot be zeroed.
 */
export async function deriveAccountKeys(secretKey: string): Promise<AccountKeys> {
  const { Fr } = await import("@aztec/aztec.js/fields");
  const { deriveMasterMessageSigningSecretKey } = await import("@aztec/stdlib/keys");

  const rawKey = Buffer.from(secretKey.replace(/^0x/, ""), "hex");
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

  return { secret, salt, signingKey: deriveMasterMessageSigningSecretKey(secret) };
}

/**
 * The salt of the spending-limit account's deployer: the account salt plus one.
 *
 * One definition, because the deployer's address is something an operator
 * bridges fee juice to before the bridge has ever run, and a claim commits to
 * the address it was bridged to. A script that derived it independently and
 * drifted would strand the bridged amount at an address nothing controls.
 */
async function deployerSalt(accountSalt: Fr): Promise<Fr> {
  const fields = await import("@aztec/aztec.js/fields");
  return new fields.Fr(accountSalt.toBigInt() + 1n);
}

/**
 * `deriveAccountKeys` for the deployer: the same secret and signing key, under
 * `deployerSalt`. A plain Schnorr account, so `createSchnorrAccount` on these
 * keys yields the address the bridge deploys from.
 */
export async function deriveDeployerKeys(secretKey: string): Promise<AccountKeys> {
  const keys = await deriveAccountKeys(secretKey);
  return { ...keys, salt: await deployerSalt(keys.salt) };
}

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
  private readonly allowSponsoredFpc: boolean;
  // Captured with the value, so the log names what actually permitted it.
  private readonly sponsoredFpcReason: string;

  constructor(
    private readonly nodeUrl: string,
    secretKey: string,
    private readonly feeJuiceClaim?: FeeJuiceClaim,
    private readonly spendingLimitConfig?: SpendingLimitConfig,
    private readonly deployerFeeJuiceClaim?: FeeJuiceClaim,
    options: { allowSponsoredFpc?: boolean } = {},
  ) {
    // Refused here rather than in index.ts alone, so a library caller gets the
    // same answer. Left unchecked the combination fails deep in the SDK during
    // deployment, with a message about the fee payer that says nothing about
    // the claim that caused it.
    if (feeJuiceClaim && spendingLimitConfig) {
      throw new Error(FEE_CLAIM_WITH_SPENDING_LIMIT_ERROR);
    }
    if (deployerFeeJuiceClaim && !spendingLimitConfig) {
      throw new Error(DEPLOYER_CLAIM_WITHOUT_SPENDING_LIMIT_ERROR);
    }
    // Defaults to the env, read at construction, so index.ts and a library
    // caller are gated alike, the log names the variable that decided, and a
    // malformed value fails before connecting.
    if (options.allowSponsoredFpc !== undefined) {
      this.allowSponsoredFpc = options.allowSponsoredFpc;
      this.sponsoredFpcReason = `allowSponsoredFpc=${options.allowSponsoredFpc}`;
    } else {
      const setting = sponsoredFpcSetting(process.env);
      this.allowSponsoredFpc = setting.allowed;
      this.sponsoredFpcReason = setting.reason;
    }
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

    const secretKey = this.secretKey;
    this.secretKey = null; // clear string reference immediately
    const { secret, salt, signingKey } = await deriveAccountKeys(secretKey);

    const accountManager = this.spendingLimitConfig
      ? await this.createSpendingLimitAccount(secret, salt)
      : await this.wallet.createSchnorrAccount(secret, salt, signingKey);

    const account = await accountManager.getAccount();
    const address = account.getAddress();
    this.solverAddress = address;
    // Logged because the operator needs it: the spending-limit account cannot
    // obtain fee juice for itself, and topping it up means naming this address
    // to scripts/top-up-fee-juice.ts. Public on chain either way.
    console.log(`[pxe-bridge] Account address: ${address.toString()}`);

    // Deploy account contract if not already on-chain.
    // Cannot rely on wallet.getAccounts() since the local WalletDB is
    // ephemeral (Docker restarts clear it). The initialization nullifier is
    // checked against the node. Publication is not the test: v0.1.2 deployed
    // accounts unpublished, and treating those as absent sent upgrades into
    // the deploy path, where production refuses SponsoredFPC.
    const metadata = await this.wallet.getContractMetadata(address);
    const { ContractInitializationStatus } = await import("@aztec/aztec.js/wallet");
    const alreadyDeployed =
      metadata.initializationStatus === ContractInitializationStatus.INITIALIZED;

    if (!alreadyDeployed) {
      console.log("[pxe-bridge] Deploying solver account...");

      const { NO_FROM } = await import("@aztec/aztec.js/account");

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
        : undefined;
      const gasSettings = await this.deployGasSettings();
      const paymentMethod = deployer
        ? await this.limitAccountPaymentMethod(address, deployer.address, deployer.claim)
        : await this.buildFeePaymentMethod(address, this.feeJuiceClaim);

      const deployMethod = await accountManager.getDeployMethod();
      try {
        await deployMethod.send({
          from: deployer?.address ?? NO_FROM,
          // No paymentMethod means the sender pays from its own balance; see
          // limitAccountPaymentMethod.
          fee: {
            ...(paymentMethod ? { paymentMethod } : {}),
            gasSettings,
          },
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
        // A concurrent deploy of the same account is not an error. "Existing
        // nullifier" does not establish one: a spent fee claim's message
        // nullifier fails the send the same way with nothing deployed. The
        // initialization status settles it, for that error and any other.
        const message = err instanceof Error ? err.message : String(err);
        if (await this.isInitialized(address)) {
          console.log("[pxe-bridge] Account deployed by another process");
        } else if (deployer && deployer.claim !== "absent" && deployerUnderfunded(message)) {
          throw new Error(
            `Deployer ${deployer.address.toString()} cannot pay the fee for deploying ` +
              `${address.toString()}. Top it up: read -s FEE_JUICE_PAYER_KEY; export FEE_JUICE_PAYER_KEY ` +
              `(or op run), then FEE_JUICE_RECIPIENT=${deployer.address.toString()} ` +
              "npm run top-up-fee-juice, or bridge a new " +
              `claim to it (npm run bridge-fee-juice -- --deployer --recipient ${deployer.address.toString()}). ` +
              `Cause: ${message}`,
            { cause: err },
          );
        } else {
          throw err;
        }
      }
    } else if (!metadata.isContractPublished) {
      // Initialized but unpublished (v0.1.2 deployments). Not redeployed: the
      // constructor already ran and cannot run again.
      console.log("[pxe-bridge] Account recovered (initialized, not published)");
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
   * spending-limit account. Returns its address and the state of the deployer
   * claim, which decides how the account deploy is paid
   * (`limitAccountFeePath`).
   *
   * Derived from the same master secret as the solver, under `deployerSalt`,
   * so it needs no separate key material and is reproducible across restarts.
   * A standard Schnorr account can self-deploy because its entrypoint has no
   * single-call restriction. It pays with the deployer claim when one is
   * configured and unspent, from its own balance when the claim is spent or
   * absent and it holds one, else SponsoredFPC, subject to `sponsoredFpcSetting`.
   */
  private async ensureDeployer(
    secret: Fr,
    baseSalt: Fr,
  ): Promise<{ address: AztecAddress; claim: DeployerClaimState }> {
    const { NO_FROM } = await import("@aztec/aztec.js/account");
    const { deriveMasterMessageSigningSecretKey } = await import("@aztec/stdlib/keys");

    const manager = await this.wallet!.createSchnorrAccount(
      secret,
      await deployerSalt(baseSalt),
      deriveMasterMessageSigningSecretKey(secret),
    );
    const deployerAddress = (await manager.getAccount()).getAddress();
    // Logged for the same reason as the account address: it is the address an
    // operator passes to `npm run bridge-fee-juice -- --deployer --recipient`.
    console.log(`[pxe-bridge] Deployer address: ${deployerAddress.toString()}`);

    // Initialization, not publication. A self-deploy leaves the instance
    // unpublished (DeployAccountMethod defaults skipInstancePublication), and
    // a retry after a failed account deploy would otherwise resend the
    // deployer's deployment, including a claim that was already consumed.
    // createSchnorrAccount has registered the instance, so the status is
    // definitive.
    const claim = this.deployerFeeJuiceClaim;
    if (await this.isInitialized(deployerAddress)) {
      if (!claim) {
        const funded = await this.balanceFundsDeploy(await this.feeJuiceBalance(deployerAddress));
        return { address: deployerAddress, claim: funded ? "funded" : "absent" };
      }
      const spent = await this.deployerClaimSpent(deployerAddress, claim);
      return { address: deployerAddress, claim: spent ? "spent" : "unspent" };
    }

    // Checked before sending. A claim with no message would fail the deploy
    // with "No L1 to L2 message found", which deployerClaimSpent names; a
    // spent one with an existing nullifier, though the balance it credited
    // may still pay for the deploy. With no claim, a balance that covers the
    // deploy pays before SponsoredFPC is considered.
    const spent = claim ? await this.deployerClaimSpent(deployerAddress, claim) : false;
    let fromBalance = false;
    if (!claim || spent) {
      const balance = await this.feeJuiceBalance(deployerAddress);
      // A spent claim leaves the balance as the only fee source, so any of it
      // is tried; see balanceFundsDeploy for the no-claim case.
      if (spent ? balance > 0n : await this.balanceFundsDeploy(balance)) {
        fromBalance = true;
        console.log(
          `[pxe-bridge] ${claim ? `${DEPLOYER_FEE_JUICE_CLAIM_ENV} is spent; paying` : "Paying"} ` +
            `the deployer's deployment from its fee juice balance (${balance})`,
        );
      } else if (spent) {
        throw new Error(
          `Deployer ${deployerAddress.toString()} is not initialized, ${DEPLOYER_FEE_JUICE_CLAIM_ENV} ` +
            "is already spent and the deployer holds no fee juice. Bridge a new claim to the " +
            `deployer (npm run bridge-fee-juice -- --deployer --recipient ${deployerAddress.toString()}).`,
        );
      }
    }

    console.log(`[pxe-bridge] Deploying deployer account ${deployerAddress.toString()}...`);
    // No payment method from NO_FROM: AccountEntrypointMetaPaymentMethod wraps
    // an empty fee payload as PREEXISTING_FEE_JUICE, the deployer paying from
    // its own balance.
    const paymentMethod = fromBalance
      ? undefined
      : await this.buildFeePaymentMethod(deployerAddress, claim);
    try {
      await (await manager.getDeployMethod()).send({
        from: NO_FROM,
        // Same headroom as the account it exists to deploy. This one runs
        // first, so a spike here strands the account deployment behind it.
        fee: {
          ...(paymentMethod ? { paymentMethod } : {}),
          gasSettings: await this.deployGasSettings(),
        },
      });
      console.log("[pxe-bridge] Deployer deployed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (fromBalance && deployerUnderfunded(message)) {
        throw new Error(
          `Deployer ${deployerAddress.toString()} cannot pay the fee for its own deployment. Bridge ` +
            `a new claim to it (npm run bridge-fee-juice -- --deployer --recipient ${deployerAddress.toString()}). ` +
            `Cause: ${message}`,
          { cause: err },
        );
      }
      if (!message.includes("Existing nullifier")) throw err;
      // Either the deployer's init nullifier (a concurrent deploy won) or the
      // claim's message nullifier (claim spent between the check above and
      // the send, deployer still uninitialized). Only the first is success.
      if (!(await this.isInitialized(deployerAddress))) {
        if (!claim || fromBalance) throw err;
        throw new Error(
          `Deployer ${deployerAddress.toString()} is not initialized and its deploy hit an ` +
            `existing nullifier: ${DEPLOYER_FEE_JUICE_CLAIM_ENV} is already spent. Restart to ` +
            `pay from the balance it credited, or bridge a new claim to the deployer (npm run ` +
            `bridge-fee-juice -- --deployer --recipient ${deployerAddress.toString()}). Cause: ${message}`,
          { cause: err },
        );
      }
      console.log("[pxe-bridge] Deployer deployed by another process");
    }
    return {
      address: deployerAddress,
      claim: claim ? "spent" : fromBalance ? "funded" : "absent",
    };
  }

  /** Public fee juice balance of `address`, read from FeeJuice storage on the node. */
  private async feeJuiceBalance(address: AztecAddress): Promise<bigint> {
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    const { getFeeJuiceBalance } = await import("@aztec/aztec.js/utils");
    return getFeeJuiceBalance(address, createAztecNodeClient(this.nodeUrl));
  }

  /**
   * Whether a deployer with no claim configured pays from `balance` rather
   * than via SponsoredFPC.
   *
   * Anyone can deposit fee juice to any address, so treating any positive
   * balance as funding let a 1 wei deposit steer the deploy away from a
   * SponsoredFPC that would pay and into a send that fails. Where SponsoredFPC
   * is permitted, the balance must cover the most a deploy can be charged: the
   * per-tx gas the node admits (`txsLimits.gas`, what the wallet declares
   * before it has an estimate) at the deploy's max fees. Where it is refused,
   * the balance is the only fee source, so any of it is tried.
   */
  private async balanceFundsDeploy(balance: bigint): Promise<boolean> {
    if (balance === 0n) return false;
    if (!this.allowSponsoredFpc) return true;
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    const { txsLimits } = await createAztecNodeClient(this.nodeUrl).getNodeInfo();
    const { maxFeesPerGas } = await this.deployGasSettings();
    const feeLimit =
      BigInt(txsLimits.gas.daGas) * maxFeesPerGas.feePerDaGas +
      BigInt(txsLimits.gas.l2Gas) * maxFeesPerGas.feePerL2Gas;
    if (balance >= feeLimit) return true;
    console.log(
      `[pxe-bridge] Deployer fee juice balance ${balance} is below a deployment's fee limit ` +
        `${feeLimit}; not used`,
    );
    return false;
  }

  /**
   * Whether the deployer claim's L1 to L2 message has been consumed.
   *
   * Recomputes the message hash the FeeJuice portal emitted for a deposit to
   * `beneficiary`, then looks up the nullifier `FeeJuice.claim` emits for it.
   * The message must be in the tree: a missing one means the claim does not
   * name this deployer, is not yet synced, or this derivation has drifted from
   * the portal's, and none of those should be read as "spent".
   */
  private async deployerClaimSpent(beneficiary: AztecAddress, claim: FeeJuiceClaim): Promise<boolean> {
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    const { Fr } = await import("@aztec/aztec.js/fields");
    const { ProtocolContractAddress } = await import("@aztec/protocol-contracts");
    const { siloNullifier } = await import("@aztec/stdlib/hash");
    const { computeFeeJuiceMessageNullifier } = await import("@aztec/stdlib/messaging");
    const { MerkleTreeId } = await import("@aztec/stdlib/trees");

    const node = createAztecNodeClient(this.nodeUrl);
    const info = await node.getNodeInfo();
    const secret = Fr.fromString(claim.claimSecret);
    const messageHash = Fr.fromString(
      await feeJuiceMessageHash(beneficiary.toString(), claim, info.l1ChainId, info.rollupVersion),
    );

    if (!(await node.getL1ToL2MessageMembershipWitness("latest", messageHash))) {
      throw new Error(
        `${DEPLOYER_FEE_JUICE_CLAIM_ENV} has no L1 to L2 message for deployer ` +
          `${beneficiary.toString()} (hash ${messageHash.toString()}): it was bridged to a ` +
          "different address or is not yet synced.",
      );
    }
    const nullifier = await siloNullifier(
      ProtocolContractAddress.FeeJuice,
      await computeFeeJuiceMessageNullifier(messageHash, secret),
    );
    const [index] = await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, [nullifier]);
    return index !== undefined;
  }

  /**
   * How the spending-limit account's own deployment, sent from the deployer,
   * is paid for; see `limitAccountFeePath`.
   *
   * `claim`: FeeJuicePaymentMethodWithClaim naming the deployer. Its payload's
   * feePayer equals `from`, so BaseWallet.completeFeeOptions selects
   * FEE_JUICE_WITH_CLAIM and the deployer's entrypoint names itself fee payer.
   *
   * `preexisting`: no payment method. completeFeeOptions then selects
   * PREEXISTING_FEE_JUICE and the deployer pays from its balance. v5 has no
   * FeeJuicePaymentMethod to name explicitly. No balance precheck: the fee
   * limit the deploy declares comes from EmbeddedWallet.sendTx's own gas
   * estimate, which only exists inside the send, so an underfunded deployer
   * is reported by wrapping the rejection instead (`deployerUnderfunded`).
   */
  private async limitAccountPaymentMethod(
    accountAddress: AztecAddress,
    deployer: AztecAddress,
    claim: DeployerClaimState,
  ): Promise<FeePaymentMethod | undefined> {
    switch (limitAccountFeePath(claim)) {
      case "sponsored":
        return this.buildFeePaymentMethod(accountAddress, undefined);
      case "claim":
        return this.buildFeePaymentMethod(deployer, this.deployerFeeJuiceClaim);
      case "preexisting":
        console.log(
          `[pxe-bridge] Paying deployment of ${accountAddress.toString()} from the deployer's fee juice balance`,
        );
        return undefined;
    }
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
        // Reconcile before spending a fee. The bridge holds the allowlist off
        // chain now, so a drift between its copy and the account's stored root
        // would otherwise surface as every transfer reverting in public, with
        // nothing on chain to say which side is stale.
        //
        // Cheap: one utility read, the same shape the allowlist read used to
        // be. The tree itself is built once and cached.
        //
        // Neither the declared amount and recipient nor the membership witness
        // are pushed in here. The entrypoint derives all three from the payload
        // it is signing, so there is no per-call state for a concurrent send to
        // overwrite and nothing to serialize around.
        await this.assertAllowlistRootCurrent();
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
   * Checks the configured allowlist against the account's stored root.
   *
   * Replaces the old readAllowlist. There is no set on chain to read any more,
   * so this reconciles in the other direction: the bridge asserts that the tree
   * it holds is the one the account is enforcing.
   *
   * This is checkable rather than trusted, which matters for monitoring. A
   * compromised admin cannot publish one set and commit another, because the
   * root commits to exactly the set that produces it.
   */
  private async assertAllowlistRootCurrent(): Promise<void> {
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
    const raw = (await account.methods["get_allowlist_root"]!().simulate({
      from: this.solverAddress,
    })) as unknown;

    // simulate() resolves to { result, offchainEffects, offchainMessages };
    // the utility's Field return value is under `result`.
    const value = (raw as { result?: unknown })?.result ?? raw;
    if (value === undefined || value === null) {
      throw new Error("get_allowlist_root returned nothing");
    }
    const onChain =
      typeof value === "bigint" ? value : BigInt((value as { toString(): string }).toString());

    const tree = await this.spendingLimitContract.allowlistTree();
    const local = tree.root.toBigInt();
    if (onChain !== local) {
      throw new Error(
        `Allowlist root mismatch: the account is enforcing ` +
          `0x${onChain.toString(16).padStart(64, "0")} but the configured allowlist produces ` +
          `0x${local.toString(16).padStart(64, "0")}. Either an admin changed the allowlist ` +
          `and this bridge's configuration was not updated, or the configuration is for a ` +
          `different account. Reconcile before sending; no transfer can succeed until the ` +
          `two agree.`,
      );
    }
  }

  /**
   * Whether the account's constructor has run ON CHAIN.
   *
   * Reads the initialization nullifier from the node, not PXE registration.
   * AccountManager.create() registers the instance with the local PXE before
   * anything is deployed, so a registration lookup always answers "yes":
   * connect() would log "Account recovered", skip the constructor, and leave
   * the signing-key note uncreated. Publication is not the test either: the
   * deployer and v0.1.2 accounts are initialized but unpublished.
   */
  private async isInitialized(address: AztecAddress): Promise<boolean> {
    const { ContractInitializationStatus } = await import("@aztec/aztec.js/wallet");
    const { initializationStatus } = await this.wallet!.getContractMetadata(address);
    return initializationStatus === ContractInitializationStatus.INITIALIZED;
  }

  private async deployGasSettings(): Promise<{ maxFeesPerGas: GasFees }> {
    return headroomGasSettings(this.nodeUrl);
  }

  /**
   * The fee payment for an account's deployment: `claim` if given, else
   * SponsoredFPC where permitted.
   *
   * The caller picks the claim because a claim commits to its L2 recipient in
   * the message hash, so it can only pay for the account it was bridged to:
   * FEE_JUICE_CLAIM for the plain Schnorr solver, the deployer claim for the
   * deployer. Handing one to the other fails the message lookup with "No L1 to
   * L2 message found for message hash".
   */
  private async buildFeePaymentMethod(
    accountAddress: AztecAddress,
    claim: FeeJuiceClaim | undefined,
  ): Promise<FeePaymentMethod> {
    if (claim) {
      console.log(
        `[pxe-bridge] Using Fee Juice claim for deployment fee of ${accountAddress.toString()}`,
      );
      const { FeeJuicePaymentMethodWithClaim } = await import("@aztec/aztec.js/fee");
      const fields = await import("@aztec/aztec.js/fields");
      return new FeeJuicePaymentMethodWithClaim(accountAddress, {
        claimAmount: BigInt(claim.claimAmount),
        claimSecret: fields.Fr.fromString(claim.claimSecret),
        messageLeafIndex: BigInt(claim.messageLeafIndex),
      });
    }

    // Checked before anything is registered or sent. Without a deployer claim
    // this runs for the deployer before it is deployed, so a refused
    // spending-limit deployment stops before sending anything.
    if (!this.allowSponsoredFpc) {
      throw new Error(
        `Account ${accountAddress.toString()} is not deployed. ${SPONSORED_FPC_REFUSED_ERROR}`,
      );
    }
    console.warn(
      `[pxe-bridge] Paying deployment of ${accountAddress.toString()} via SponsoredFPC ` +
        `(sandbox and testnet only; permitted by ${this.sponsoredFpcReason})`,
    );
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
