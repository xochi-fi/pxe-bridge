import type { Wallet } from "@aztec-labs/aztec.js/wallet";
import type { AztecClient } from "../aztec-client.js";
import type { MayBroadcastClient } from "../may-broadcast.js";
import { capsFromEnv, type OxideCapsConfig } from "./caps.js";
import { assertL1Pinned, viemL1Reader, type OxideL1Reader } from "./enclave.js";
import { OxideJournal } from "./journal.js";
import { OxidePinChecker, OXIDE_V6_MAINNET } from "./pins.js";
import { loadOxideTokenArtifact, PxeOxideBackend, registerOxideToken } from "./backend.js";
import { OxideSender } from "./sender.js";

export { OxideSender } from "./sender.js";
export type { OxideSendAnswer, OxideSendOutcome, OxidePayoutIdentity } from "./sender.js";

export interface OxideSenderConfig {
  /** A connected AztecClient in `standard` mode (its account pays). */
  client: AztecClient;
  /** The same bridge secret the client was built from; derived with `deriveAccountKeys`, not retained. */
  secretKey: string;
  /** `PXE_BRIDGE_OXIDE_JOURNAL`: its own SQLite file, beside (never the same as) the settlement journal. */
  journalPath: string;
  /** `PXE_BRIDGE_OXIDE_L1_RPC_URL`: Ethereum mainnet, read-only. */
  l1RpcUrl: string;
  /** `PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT`: compiled OxideToken JSON at the pinned class. */
  tokenArtifactPath: string;
  mayBroadcast: MayBroadcastClient;
  caps?: OxideCapsConfig;
  l1?: OxideL1Reader;
}

/**
 * Builds the Oxide sender on a connected standard-mode client. Refuses, before
 * anything can be sent, unless L1, the Oxide manifest and the zk.money profile
 * all describe the pinned v6 deployment and the artifact is the deployed class.
 * The settlement layer calls `OxideSender.send`; nothing here serves HTTP.
 */
export async function createOxideSender(config: OxideSenderConfig): Promise<OxideSender> {
  const l1 = config.l1 ?? viemL1Reader(config.l1RpcUrl);
  await assertL1Pinned(l1);
  const pins = new OxidePinChecker();
  await pins.assertPinned();

  const { wallet: embedded, account, node } = config.client.oxideContext();
  // EmbeddedWallet implements Wallet; its declared optional members do not
  // satisfy this repo's exactOptionalPropertyTypes (aztec-client.ts casts the
  // same way for TokenContract.at).
  const wallet = embedded as unknown as Wallet;
  const artifact = await loadOxideTokenArtifact(config.tokenArtifactPath);
  const token = await registerOxideToken(wallet, node, artifact);
  const backend = await PxeOxideBackend.create({
    wallet,
    account,
    node,
    observeTx: (txHash) => config.client.observeTx(txHash),
    token,
    artifact,
    l1,
    secretKey: config.secretKey,
  });

  const journal = OxideJournal.open(config.journalPath);
  return new OxideSender({
    journal,
    backend,
    caps: config.caps ?? capsFromEnv(process.env),
    mayBroadcast: config.mayBroadcast,
    preflight: {
      // Per fresh attempt: the published pins (cached 5 min) and L1, which
      // also refuses a frozen portal.
      assertPinned: async () => {
        await pins.assertPinned();
        await assertL1Pinned(l1, OXIDE_V6_MAINNET);
      },
    },
  });
}
