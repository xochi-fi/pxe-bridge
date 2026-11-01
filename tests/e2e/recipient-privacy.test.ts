import { describe, it, expect, beforeAll } from "vitest";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Contract } from "@aztec-labs/aztec.js/contracts";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { TokenContract } from "@aztec-labs/noir-contracts.js/Token";
import {
  HandshakeRegistryArtifact,
  STANDARD_HANDSHAKE_REGISTRY_ADDRESS,
} from "@aztec-labs/standard-contracts/handshake-registry";
import { AztecClient, deriveAccountKeys } from "../../src/aztec-client.js";
import {
  FUNDER_KEY,
  feeWithHeadroom,
  gasWithHeadroom,
  getTestConfig,
  mintTo,
  recordingGate,
  registerPublished,
  requireTestToken,
  walletDataDirectory,
} from "./helpers.js";

/**
 * Recipient privacy (xochi shielded-execution.md D4, amended 2026-11-01): the
 * bridge's payout publishes nothing a holder of the recipient's address can
 * match, and an independent recipient PXE still finds the note once it
 * registers the bridge account as a sender.
 *
 * The oracle is the HandshakeRegistry's `get_non_interactive_handshakes`, the
 * registry's own lookup for handshake logs tagged by a hash of the recipient's
 * address, which is what lets anyone holding that address confirm the payment.
 * PXE scopes the lookup to the recipient's account, so it runs in the
 * recipient's PXE. The control sends the same transfer from a wallet without
 * the bridge's hook, so an empty answer means "no handshake", not "the read
 * sees nothing".
 */

const config = getTestConfig();
const AMOUNT = 1_000n;

type Call = {
  simulate: (o: unknown) => Promise<unknown>;
  send: (o: unknown) => Promise<unknown>;
};
type Methods = { methods: Record<string, (...a: unknown[]) => Call> };

// The SDK's Wallet type does not survive exactOptionalPropertyTypes, so the
// suite passes wallets as unknown, as helpers.ts does.
const at = Contract.at as unknown as (a: AztecAddress, artifact: unknown, w: unknown) => Promise<Methods>;

/** simulate() resolves to `{ result, ... }`; the value is under `result`. */
function resultOf(out: unknown): unknown {
  return out !== null && typeof out === "object" && "result" in out ? out.result : out;
}

/** A fresh account on its own PXE, registered but never deployed: discovery needs no deployment. */
async function independentRecipient(label: string): Promise<{ wallet: EmbeddedWallet; address: AztecAddress }> {
  const wallet = await EmbeddedWallet.create(config.nodeUrl, {
    pxe: { proverEnabled: false, ...walletDataDirectory(label) },
  });
  const manager = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  return { wallet, address: (await manager.getAccount()).getAddress() };
}

/** Non-interactive handshakes published for `recipient`, looked up in its own PXE. */
async function publishedHandshakes(recipient: { wallet: unknown; address: AztecAddress }): Promise<number> {
  const registry = await at(STANDARD_HANDSHAKE_REGISTRY_ADDRESS, HandshakeRegistryArtifact, recipient.wallet);
  const page = resultOf(
    await registry.methods["get_non_interactive_handshakes"]!(recipient.address, 0).simulate({
      from: recipient.address,
    }),
  );
  // HandshakePage { items: BoundedVec<DiscoveredHandshake, 32>, total_count }.
  if (page === null || typeof page !== "object" || !("total_count" in page)) {
    throw new Error(`get_non_interactive_handshakes returned ${JSON.stringify(page, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  return Number(page.total_count);
}

async function privateBalance(wallet: unknown, token: string, owner: AztecAddress): Promise<bigint> {
  await registerPublished(wallet, token, TokenContract.artifact);
  const contract = await at(AztecAddress.fromStringUnsafe(token), TokenContract.artifact, wallet);
  const value = resultOf(
    await contract.methods["balance_of_private"]!(owner).simulate({ from: owner, fee: await gasWithHeadroom() }),
  );
  return typeof value === "bigint" ? value : BigInt(String(value));
}

describe("recipient privacy (e2e)", () => {
  let bridge: AztecClient;
  let bridgeAddress: AztecAddress;
  let token: string;

  beforeAll(async () => {
    bridge = new AztecClient(
      config.nodeUrl,
      config.secretKey,
      config.feeJuiceClaim,
      undefined,
      undefined,
      walletDataDirectory("privacy-bridge"),
    );
    await bridge.connect();
    bridgeAddress = AztecAddress.fromStringUnsafe(bridge.getAddress()!);
    token = requireTestToken();
  }, 600_000);

  it("pays a recipient without a public handshake, and the recipient finds it after registerSender", async () => {
    const recipient = await independentRecipient("privacy-recipient");

    const result = await bridge.createNote(
      { recipient: recipient.address.toString(), token, amount: AMOUNT.toString() },
      recordingGate(),
    );
    expect(result.observation).toMatchObject({ kind: "mined", executionResult: "success" });

    expect(await publishedHandshakes(recipient)).toBe(0);

    // Address-derived tags are found only by a PXE that knows the sender.
    expect(await privateBalance(recipient.wallet, token, recipient.address)).toBe(0n);
    await recipient.wallet.registerSender(bridgeAddress, "pxe-bridge");
    expect(await privateBalance(recipient.wallet, token, recipient.address)).toBe(AMOUNT);
  }, 600_000);

  it("control: the same transfer from a wallet with no tagging hook publishes a handshake", async () => {
    const { secret, salt, signingKey } = await deriveAccountKeys(FUNDER_KEY);
    const control = await EmbeddedWallet.create(config.nodeUrl, {
      pxe: { proverEnabled: true, ...walletDataDirectory("privacy-control") },
    });
    const funder = (await (await control.createSchnorrAccount(secret, salt, signingKey)).getAccount()).getAddress();
    await registerPublished(control, token, TokenContract.artifact);
    await mintTo(control, token, funder.toString(), AMOUNT, funder.toString());

    const recipient = await independentRecipient("privacy-control-recipient");
    const contract = await at(AztecAddress.fromStringUnsafe(token), TokenContract.artifact, control);
    await contract.methods["transfer_to_private"]!(recipient.address, AMOUNT).send({
      from: funder,
      fee: await feeWithHeadroom(control),
    });

    expect(await publishedHandshakes(recipient)).toBe(1);
  }, 600_000);
});
