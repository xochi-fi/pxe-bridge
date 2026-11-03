import { AllowlistTree, ALLOWLIST_CAPACITY, type AllowlistRecipient } from "../allowlist-tree.js";
import { AllowlistRecipientsSchema } from "../types.js";

/**
 * The Oxide sender's recipient allowlist (xochi-fi/xochi#751, decided as
 * xochi#775 option a): an operator-held set of Aztec recipients, committed to
 * as the same seed-salted height-10 tree the spending-limit account uses
 * (`src/allowlist-tree.ts`), whose root is NEVER written on chain, put in the
 * corridor manifest, served by an endpoint or logged. The bridge signs
 * Membership and RootUpdate readiness records over that root with the corridor
 * readiness signer (src/oxide/attestation.ts), in the exact formats the Xochi
 * Worker already verifies, and the sender refuses any recipient outside it
 * (`OxideReadiness.admit`).
 *
 * Salted leaves are what keep the root private in practice: without the seed
 * a root cannot be tested against candidate addresses. The set and the seed
 * live in the bridge's environment (secret store) and its journal snapshot,
 * nowhere else. Every message this module produces names positions and
 * variables, never an address.
 */

export const OXIDE_ALLOWLIST_SEED_ENV = "PXE_BRIDGE_OXIDE_ALLOWLIST_SEED";
export const OXIDE_ALLOWLIST_RECIPIENTS_ENV = "PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO32 = /^0x0{64}$/;
// BN254 scalar field modulus: a leaf commits to the address as a field element.
const FR_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/** An allowlist configuration error. The message never contains an address. */
export class OxideAllowlistConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OxideAllowlistConfigError";
  }
}

/**
 * Validates a recipient set without echoing any address: positions in
 * range, no position or address twice, every address a nonzero field element.
 * Returns the set normalized to lowercase.
 */
export function validateOxideRecipients(input: unknown): AllowlistRecipient[] {
  const parsed = AllowlistRecipientsSchema.safeParse(input);
  if (!parsed.success) {
    throw new OxideAllowlistConfigError(
      `${OXIDE_ALLOWLIST_RECIPIENTS_ENV} must be a JSON array of {address: 32-byte hex, index: ` +
        `integer in [0, ${ALLOWLIST_CAPACITY})}: ` +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const positions = new Set<number>();
  const addresses = new Map<string, number>();
  return parsed.data.map(({ address, index }, entry) => {
    const normalized = address.toLowerCase();
    if (ZERO32.test(normalized) || BigInt(normalized) >= FR_MODULUS) {
      throw new OxideAllowlistConfigError(
        `${OXIDE_ALLOWLIST_RECIPIENTS_ENV}[${entry}] is not a nonzero Aztec field element`,
      );
    }
    if (positions.has(index)) {
      throw new OxideAllowlistConfigError(
        `${OXIDE_ALLOWLIST_RECIPIENTS_ENV}[${entry}] reuses position ${index}`,
      );
    }
    const previous = addresses.get(normalized);
    if (previous !== undefined) {
      throw new OxideAllowlistConfigError(
        `${OXIDE_ALLOWLIST_RECIPIENTS_ENV}[${entry}] repeats the address of entry ${previous}`,
      );
    }
    positions.add(index);
    addresses.set(normalized, entry);
    return { address: normalized, index };
  });
}

/** The private set and its tree. Holds no method that lists or logs members. */
export class OxideAllowlist {
  private constructor(
    readonly tree: AllowlistTree,
    private readonly members: readonly AllowlistRecipient[],
  ) {}

  static async build(seed: string, recipients: unknown): Promise<OxideAllowlist> {
    if (!HEX32.test(seed) || ZERO32.test(seed)) {
      throw new OxideAllowlistConfigError(`${OXIDE_ALLOWLIST_SEED_ENV} must be a nonzero 32-byte hex value`);
    }
    if (BigInt(seed) >= FR_MODULUS) {
      throw new OxideAllowlistConfigError(`${OXIDE_ALLOWLIST_SEED_ENV} must be below the BN254 field modulus`);
    }
    const members = validateOxideRecipients(recipients);
    let tree: AllowlistTree;
    try {
      tree = await AllowlistTree.build(seed, members);
    } catch {
      // AllowlistTree's own messages name addresses; this one must not.
      throw new OxideAllowlistConfigError("the Oxide allowlist tree could not be built from its configuration");
    }
    return new OxideAllowlist(tree, members);
  }

  /** The private root, lowercase 0x hex. Never log it or put it on chain. */
  get root(): string {
    return this.tree.root.toString().toLowerCase();
  }

  /** Whether `recipient` holds a position whose witness reproduces the root. */
  admits(recipient: string): boolean {
    return HEX32.test(recipient) && this.tree.witnessFor(recipient) !== undefined;
  }

  /** The set as the journal snapshot records it (src/journal.ts `recordAllowlistSnapshot`). */
  snapshot(): AllowlistRecipient[] {
    return this.members.map((member) => ({ ...member }));
  }
}

/**
 * The allowlist from `PXE_BRIDGE_OXIDE_ALLOWLIST_SEED` and
 * `PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS`, both required. The seed must
 * differ from the spending-limit account's `PXE_BRIDGE_ALLOWLIST_SEED`: two
 * modes sharing salts would let one set's leaves be tested against the
 * other's. An empty set is valid: the bridge then admits nobody until the
 * operator approves a recipient (`npm run oxide-allowlist`).
 */
export async function oxideAllowlistFromEnv(env: NodeJS.ProcessEnv): Promise<OxideAllowlist> {
  const seed = env[OXIDE_ALLOWLIST_SEED_ENV]?.trim();
  const raw = env[OXIDE_ALLOWLIST_RECIPIENTS_ENV];
  if (!seed) throw new OxideAllowlistConfigError(`${OXIDE_ALLOWLIST_SEED_ENV} is required in Oxide mode`);
  if (raw === undefined || raw.trim() === "") {
    throw new OxideAllowlistConfigError(
      `${OXIDE_ALLOWLIST_RECIPIENTS_ENV} is required in Oxide mode ("[]" for an empty set)`,
    );
  }
  const spendingLimitSeed = env["PXE_BRIDGE_ALLOWLIST_SEED"]?.trim();
  if (spendingLimitSeed && spendingLimitSeed.toLowerCase() === seed.toLowerCase()) {
    throw new OxideAllowlistConfigError(
      `${OXIDE_ALLOWLIST_SEED_ENV} must differ from PXE_BRIDGE_ALLOWLIST_SEED`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new OxideAllowlistConfigError(`${OXIDE_ALLOWLIST_RECIPIENTS_ENV} is not valid JSON`);
  }
  return OxideAllowlist.build(seed, json);
}
