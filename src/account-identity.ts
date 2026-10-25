/**
 * Fail-closed checks that an account derived from a key is the account the
 * operator recorded, before anything is deployed, signed or bridged for it.
 *
 * An Aztec address commits to the account's contract class as well as to its
 * key and salt. Every SDK line so far has changed the stock SchnorrAccount
 * class (5.1.0 -> 5.2.0 -> 6.0.0), so every plain Schnorr account this repo
 * derives -- the bridge's own account, the spending-limit deployer, the fee
 * juice payer and the spending-limit admin -- derives to a new, empty address
 * under a newer runtime from the same key. Left unchecked, the bridge deployed
 * a fresh account there and served from it while the old account's tokens and
 * non-transferable fee juice stayed behind, and an admin script signed as an
 * address the account does not recognise.
 *
 * The spending-limit account's own class is pinned (CLASS_ID) and its deployer
 * is the zero address, so its address moves only when that pin is deliberately
 * moved (a recompile) or when its constructor inputs change, which the same
 * check catches.
 */

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

/** SchnorrAccount class under the `@aztec-labs/*` 5.2.0 SDK (mainnet's line). */
export const SCHNORR_CLASS_ID_5_2_0 =
  "0x0833459dfb3c430326e50f2367ec093e07b4ed37d23e85cc759ef4f9aa800edd";

/**
 * SchnorrAccount class under the `@aztec-labs/*` 6.0.0 SDK, the runtime this
 * bridge ships. Pinned against the installed artifact in
 * tests/account-identity.test.ts, so the error below cannot go on naming a
 * class the runtime no longer derives. Matches the class the 6.0.0 public
 * testnet published (tag evidence/633-recipient-schnorr-testnet-6.0.0).
 */
export const SCHNORR_CLASS_ID_6_0_0 =
  "0x2f7d07db78643da21eefb63ee07d28d1cc23dd86ec9b3a9fa29323bf17269d15";

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
 * deployment to a runtime with a different SchnorrAccount class and sets
 * nothing gets a refusal, not a fresh account at a new address. A first
 * deployment cannot know its address before the bridge derives it, so it
 * names the flag, reads the address the bridge logs, records it, and removes
 * the flag.
 */
export function resolveAccountIdentityConfig(env: NodeJS.ProcessEnv): AccountIdentityConfig {
  const expectedAddress = env[ACCOUNT_ADDRESS_ENV];
  const allowDeploy = env[ALLOW_ACCOUNT_DEPLOY_ENV] === "1";

  if (expectedAddress !== undefined) {
    // Fail-closed like any other bad value, but named: `VAR=` in an env file
    // reads as "unset" to an operator and as "malformed" to the regex below.
    if (expectedAddress === "") {
      throw new Error(
        `${ACCOUNT_ADDRESS_ENV} is set but empty. Unset it, or set it to the recorded ` +
          "account address.",
      );
    }
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
        "bridge uses whatever address its key derives to, and every Aztec SDK line " +
        "has changed the stock SchnorrAccount class, so a key deployed under an older " +
        "runtime now derives a different, empty account. Set it to the address the " +
        `bridge logged as "Account address:". For a first deployment set ` +
        `${ALLOW_ACCOUNT_DEPLOY_ENV}=1, ` +
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
  /** The derived instance's class, which is what moves with the SDK. */
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
  // The SDK class change explains a mismatch only when the derived instance is
  // the stock SchnorrAccount of this runtime (6.0.0). The spending-limit
  // account's class is pinned, so its address moves with its constructor
  // inputs instead. Any other class gets the constructor-inputs message: the
  // check refuses either way.
  const cause =
    check.derivedClassId.toLowerCase() === SCHNORR_CLASS_ID_6_0_0
      ? "An address commits to its contract class as well as its key and salt, so an " +
        "SDK whose stock SchnorrAccount class differs moves it: Aztec 5.2.0 changed that " +
        `class from ${SCHNORR_CLASS_ID_5_1_0} to ${SCHNORR_CLASS_ID_5_2_0}, and 6.0.0 ` +
        `changed it again to ${SCHNORR_CLASS_ID_6_0_0}. `
      : "An address commits to its contract class and to the account's constructor " +
        "inputs (for the spending-limit account: signing key, admin, token, " +
        "PXE_BRIDGE_MAX_AMOUNT, PXE_BRIDGE_DAILY_LIMIT and the allowlist root), so one " +
        "of those differs from the deployment's. ";
  throw new Error(
    `${check.role} derives to ${check.derived} (contract class ${check.derivedClassId}), ` +
      `but ${check.expectedSource} is ${check.expected}. Refusing to use, deploy or sign ` +
      "as any account other than the recorded one. " +
      cause +
      "Do not re-record the derived address to make this start. " +
      'See SECURITY.md, "Account address pinning".',
  );
}
