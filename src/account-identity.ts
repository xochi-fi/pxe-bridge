/**
 * Fail-closed checks that an account derived from a key is the account the
 * operator recorded, before anything is deployed, signed or bridged for it.
 *
 * An Aztec address commits to the account's contract class as well as to its
 * key and salt. Aztec 5.2.0 changed the stock SchnorrAccount class, so every
 * plain Schnorr account this repo derives -- the bridge's own account, the
 * spending-limit deployer, the fee juice payer and the spending-limit admin --
 * derives to a new, empty address under a 5.2.0 runtime from the same key. Left
 * unchecked, the bridge deployed a fresh account there and served from it while
 * the 5.1.0 account's tokens and non-transferable fee juice stayed behind, and
 * an admin script signed as an address the account does not recognise.
 *
 * The spending-limit account's own class is pinned (CLASS_ID) and its deployer
 * is the zero address, so its address does not move with the SDK. It still
 * moves when its constructor inputs do, which the same check catches.
 */

import type { ContractArtifact } from "@aztec/stdlib/abi";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { Fr } from "@aztec/foundation/curves/bn254";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";

/** The bridge account's recorded address. Required in production. */
export const ACCOUNT_ADDRESS_ENV = "PXE_BRIDGE_ACCOUNT_ADDRESS";

/**
 * `1` lets a production bridge start without a recorded address, for a first
 * deployment only. Same name and meaning as in the deployment-record change
 * (xochi-fi/pxe-bridge#42), so the two share one convention.
 */
export const ALLOW_ACCOUNT_DEPLOY_ENV = "PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY";

/** SchnorrAccount class under the 5.1.0 SDK, from its stock artifact. */
export const SCHNORR_CLASS_ID_5_1_0 =
  "0x0191cefaf68870dd09c29d402946976c9def479ee7f343061b6574fa401af98d";

/**
 * SchnorrAccount class under the 5.2.0 SDK. Pinned against the installed
 * artifact in tests/account-identity.test.ts, so the error below cannot go on
 * naming a class the runtime no longer derives.
 */
export const SCHNORR_CLASS_ID_5_2_0 =
  "0x0833459dfb3c430326e50f2367ec093e07b4ed37d23e85cc759ef4f9aa800edd";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO = /^0x0{64}$/;

export interface AccountIdentityConfig {
  /** The recorded address, when there is one. */
  expectedAddress?: string;
  /** Production may start without a recorded address. */
  allowDeploy: boolean;
}

/**
 * Reads the bridge's account identity settings from the environment.
 *
 * Throws, naming the variable, rather than exiting, so it can be tested and
 * index.ts decides how to stop.
 *
 * In production the recorded address is REQUIRED unless the deploy flag is
 * set. That is the upgrade path this exists for: an operator who upgrades a
 * 5.1.0-runtime deployment and sets nothing gets a refusal, not a fresh account
 * at a new address. A first deployment cannot know its address before the
 * bridge derives it, so it names the flag, reads the address the bridge logs,
 * records it, and removes the flag.
 */
export function resolveAccountIdentityConfig(env: NodeJS.ProcessEnv): AccountIdentityConfig {
  const expectedAddress = env[ACCOUNT_ADDRESS_ENV];
  const allowDeploy = env[ALLOW_ACCOUNT_DEPLOY_ENV] === "1";

  if (expectedAddress !== undefined) {
    if (!HEX32.test(expectedAddress)) {
      throw new Error(`${ACCOUNT_ADDRESS_ENV} must be a 32-byte hex AztecAddress`);
    }
    // An empty-but-present variable expanding to zeros would otherwise read as
    // "recorded" and refuse every key with a confusing mismatch.
    if (ZERO.test(expectedAddress)) {
      throw new Error(`${ACCOUNT_ADDRESS_ENV} must not be the zero address`);
    }
    return { expectedAddress, allowDeploy };
  }

  if (env["NODE_ENV"] === "production" && !allowDeploy) {
    throw new Error(
      `${ACCOUNT_ADDRESS_ENV} is required when NODE_ENV=production. Without it the ` +
        "bridge uses whatever address its key derives to, and Aztec 5.2.0 changed the " +
        "stock SchnorrAccount class, so a key deployed under a 5.1.0 runtime now derives " +
        "a different, empty account. Set it to the address the bridge logged as " +
        `"Account address:". For a first deployment set ${ALLOW_ACCOUNT_DEPLOY_ENV}=1, ` +
        "then record the logged address and remove the flag.",
    );
  }
  return { allowDeploy };
}

export interface AccountIdentityCheck {
  /** What the account is, for the message: "Bridge account", "Admin signer". */
  role: string;
  /** The address the key derives to under this runtime. */
  derived: string;
  /** The derived instance's class, which is what moved under 5.2.0. */
  derivedClassId: string;
  /** The recorded or on-chain address the derived one must equal. */
  expected: string;
  /** Where `expected` came from, for the message. */
  expectedSource: string;
}

/**
 * Refuses an account whose derived address is not the recorded one.
 *
 * Compared case-insensitively: both are hex renderings of one field element,
 * and a hand-copied record may not match the SDK's lowercase.
 */
export function assertAccountIdentity(check: AccountIdentityCheck): void {
  if (check.derived.toLowerCase() === check.expected.toLowerCase()) return;
  throw new Error(
    `${check.role} derives to ${check.derived} (contract class ${check.derivedClassId}), ` +
      `but ${check.expectedSource} is ${check.expected}. Refusing to use, deploy or sign ` +
      "as any account other than the recorded one. An address commits to its contract " +
      "class as well as its key and salt (and, for the spending-limit account, its " +
      "constructor inputs). Aztec 5.2.0 changed the stock SchnorrAccount class from " +
      `${SCHNORR_CLASS_ID_5_1_0} to ${SCHNORR_CLASS_ID_5_2_0}, so a key whose account ` +
      "was deployed under a 5.1.0 runtime now derives a different, empty address. " +
      'See SECURITY.md, "Upgrading to Aztec 5.2.0".',
  );
}

/** The slice of AztecNode reading the admin needs. */
export interface ContractStateReader {
  getContract(address: AztecAddress): Promise<{ currentContractClassId: Fr } | undefined>;
  getPublicStorageAt(block: "latest", contract: AztecAddress, slot: Fr): Promise<Fr>;
}

/**
 * Reads a spending-limit account's admin from public storage.
 *
 * The contract has no admin getter and its bytecode is fixed (CLASS_ID), so
 * this reads the slot directly. `admin` is a PublicImmutable<AztecAddress>,
 * stored as aztec-nr's WithHash: the packed value at the variable's slot (one
 * field for an address) and its hash after it. The slot comes from the
 * artifact's storage layout rather than a literal.
 *
 * The instance's class is checked first. A slot read from any other contract
 * is a number with no meaning, and treating it as the admin would let a wrong
 * SPENDING_LIMIT_ACCOUNT pass or fail the check by accident.
 */
export async function readSpendingLimitAdmin(
  node: ContractStateReader,
  account: AztecAddress,
  artifact: ContractArtifact,
): Promise<string> {
  const instance = await node.getContract(account);
  if (!instance) {
    throw new Error(`No contract is published at ${account.toString()}`);
  }
  const expectedClass = (await getContractClassFromArtifact(artifact)).id.toString();
  const actualClass = instance.currentContractClassId.toString();
  if (actualClass !== expectedClass) {
    throw new Error(
      `${account.toString()} runs contract class ${actualClass}, not the spending-limit ` +
        `account class ${expectedClass}; refusing to read an admin from it`,
    );
  }

  const slot = artifact.storageLayout["admin"]?.slot;
  if (!slot) {
    throw new Error("Spending-limit artifact has no `admin` in its storage layout");
  }
  const admin = await node.getPublicStorageAt("latest", account, slot);
  if (admin.isZero()) {
    throw new Error(`${account.toString()} has no admin in storage; is it initialized?`);
  }
  return admin.toString();
}
