import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { AllowlistTree, ALLOWLIST_CAPACITY, type AllowlistRecipient } from "../allowlist-tree.js";
import { AllowlistRecipientsSchema } from "../types.js";

/**
 * The Oxide fresh-send recipient allowlist (xochi-fi/xochi#751, decided as
 * xochi#775 option a): an operator-held set of Aztec recipients, committed to
 * as the same seed-salted height-10 tree the spending-limit account uses
 * (`src/allowlist-tree.ts`). The root is never written on chain, put in the
 * corridor manifest, served by a public endpoint or logged. The authenticated
 * Membership response and RootUpdate relay necessarily disclose it to Xochi;
 * neither ever discloses the seed or recipient set. The bridge signs those
 * readiness records with the corridor readiness signer
 * (`src/oxide/attestation.ts`), in the exact formats the Xochi Worker already
 * verifies. `OxideReadiness.admit` supplies the membership refusal; its caller
 * must invoke it before a fresh send.
 *
 * Salted leaves are what keep the root private in practice: without the seed a
 * root cannot be tested against candidate addresses. Production reads the set
 * and seed only from owner-only secret files; neither appears in environment
 * metadata. Every message this module produces names configuration fields,
 * never an address, member position, seed, set or root.
 */

export const OXIDE_ALLOWLIST_SEED_ENV = "PXE_BRIDGE_OXIDE_ALLOWLIST_SEED";
export const OXIDE_ALLOWLIST_RECIPIENTS_ENV = "PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS";
export const OXIDE_ALLOWLIST_SEED_FILE_ENV = "PXE_BRIDGE_OXIDE_ALLOWLIST_SEED_FILE";
export const OXIDE_ALLOWLIST_RECIPIENTS_FILE_ENV = "PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS_FILE";

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
      `${OXIDE_ALLOWLIST_RECIPIENTS_ENV} must be a JSON array of valid address and index records`,
    );
  }
  const positions = new Set<number>();
  const addresses = new Map<string, number>();
  return parsed.data.map(({ address, index }, entry) => {
    const normalized = address.toLowerCase();
    if (ZERO32.test(normalized) || BigInt(normalized) >= FR_MODULUS) {
      throw new OxideAllowlistConfigError(`${OXIDE_ALLOWLIST_RECIPIENTS_ENV} has a non-field address`);
    }
    if (positions.has(index)) {
      throw new OxideAllowlistConfigError(`${OXIDE_ALLOWLIST_RECIPIENTS_ENV} reuses a member position`);
    }
    const previous = addresses.get(normalized);
    if (previous !== undefined) {
      throw new OxideAllowlistConfigError(`${OXIDE_ALLOWLIST_RECIPIENTS_ENV} repeats a member address`);
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
    /** SHA-256 of the canonical seed, for key-separation checks only. */
    readonly seedSecretDigest: string,
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
    const seedSecretDigest = createHash("sha256").update(seed.slice(2).toLowerCase()).digest("hex");
    return new OxideAllowlist(tree, members, seedSecretDigest);
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

function secretValue(env: NodeJS.ProcessEnv, valueName: string, fileName: string): string | undefined {
  const direct = env[valueName]?.trim();
  const file = env[fileName]?.trim();
  if (direct && file) throw new OxideAllowlistConfigError(`${valueName} and ${fileName} are mutually exclusive`);
  if (direct) {
    if (env["NODE_ENV"] === "production") {
      throw new OxideAllowlistConfigError(`${valueName} is not permitted in production; use ${fileName}`);
    }
    return direct;
  }
  if (!file) return undefined;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error("not an owner-only regular file");
    }
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new OxideAllowlistConfigError(`${fileName} must name a readable owner-only regular file`);
  }
}

/**
 * Loads the private set and seed from owner-only files in production. Direct
 * values remain available only in development and tests. Both values are
 * required; an empty recipient set is represented by `[]`.
 */
export async function oxideAllowlistFromEnv(env: NodeJS.ProcessEnv): Promise<OxideAllowlist> {
  const seed = secretValue(env, OXIDE_ALLOWLIST_SEED_ENV, OXIDE_ALLOWLIST_SEED_FILE_ENV);
  const raw = secretValue(env, OXIDE_ALLOWLIST_RECIPIENTS_ENV, OXIDE_ALLOWLIST_RECIPIENTS_FILE_ENV);
  if (!seed) {
    throw new OxideAllowlistConfigError(
      `${OXIDE_ALLOWLIST_SEED_FILE_ENV} (or direct value outside production) is required in Oxide mode`,
    );
  }
  if (!raw) {
    throw new OxideAllowlistConfigError(
      `${OXIDE_ALLOWLIST_RECIPIENTS_FILE_ENV} (or direct value outside production) is required in Oxide mode`,
    );
  }
  const spendingLimitSeed = env["PXE_BRIDGE_ALLOWLIST_SEED"]?.trim();
  if (spendingLimitSeed && spendingLimitSeed.toLowerCase() === seed.toLowerCase()) {
    throw new OxideAllowlistConfigError("the Oxide allowlist seed must differ from the spending-limit seed");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new OxideAllowlistConfigError("the Oxide allowlist recipients file is not valid JSON");
  }
  return OxideAllowlist.build(seed, json);
}

/** One operator change to the private set. */
export type OxideAllowlistChange =
  | { mode: "add"; address: string; index: number }
  | { mode: "revoke"; address: string };

/** Positions no recipient holds, ascending. */
export function freeOxidePositions(current: readonly AllowlistRecipient[]): number[] {
  const taken = new Set(current.map(({ index }) => index));
  return Array.from({ length: ALLOWLIST_CAPACITY }, (_, index) => index).filter((index) => !taken.has(index));
}

/**
 * The set after one change, with the same checks `scripts/update-allowlist.ts`
 * makes for the on-chain allowlist: an addition needs a free position and an
 * address not already listed (revoke first to move one), a revocation needs a
 * listed address. `sender` (the Oxide sending account) can never be added.
 * Messages never echo an address or occupied member position.
 */
export function planOxideAllowlistChange(
  current: readonly AllowlistRecipient[],
  change: OxideAllowlistChange,
  sender?: string,
): AllowlistRecipient[] {
  const members = validateOxideRecipients(current);
  const address = change.address.toLowerCase();
  if (change.mode === "revoke") {
    if (!members.some((member) => member.address === address)) {
      throw new OxideAllowlistConfigError("the address to revoke is not in the current set");
    }
    return members.filter((member) => member.address !== address);
  }
  if (!HEX32.test(address) || ZERO32.test(address) || BigInt(address) >= FR_MODULUS) {
    throw new OxideAllowlistConfigError("the address to add is not a nonzero 32-byte Aztec field element");
  }
  if (sender !== undefined && sender.toLowerCase() === address) {
    throw new OxideAllowlistConfigError("the Oxide sending account cannot be its own recipient");
  }
  if (!Number.isInteger(change.index) || change.index < 0 || change.index >= ALLOWLIST_CAPACITY) {
    throw new OxideAllowlistConfigError("the requested allowlist slot is outside the tree");
  }
  if (members.some((member) => member.index === change.index)) {
    throw new OxideAllowlistConfigError("the requested allowlist slot is already occupied");
  }
  if (members.some((member) => member.address === address)) {
    throw new OxideAllowlistConfigError("the address is already in the set; revoke it first to move it");
  }
  return validateOxideRecipients([...members, { address, index: change.index }]);
}
