import type { Wallet } from "@aztec-labs/aztec.js/wallet";
import type { AztecClient } from "../aztec-client.js";
import type { MayBroadcastClient } from "../may-broadcast.js";
import type { CorridorConfig } from "../settlement.js";
import { unknown } from "../readiness.js";
import type { OxideAllowlist } from "./allowlist.js";
import { capsFromEnv, type OxideCapsConfig } from "./caps.js";
import { assertL1Pinned, viemL1Reader, type OxideL1Reader } from "./enclave.js";
import { OxideJournal } from "./journal.js";
import { OxidePinChecker, OXIDE_V6_MAINNET } from "./pins.js";
import { loadOxideTokenArtifact, PxeOxideBackend, registerOxideToken } from "./backend.js";
import { OxideReadiness } from "./readiness.js";
import { OxideSender } from "./sender.js";

export { OxideSender } from "./sender.js";
export type { OxideSendAnswer, OxideSendOutcome, OxidePayoutIdentity } from "./sender.js";
export { OxideAllowlist, oxideAllowlistFromEnv } from "./allowlist.js";
export { OxideAttestationProbe } from "./attestation.js";
export { OxideReadiness } from "./readiness.js";
export type { OxideAdmissionVerdict, OxideReadinessProjection } from "./readiness.js";

export interface OxideSenderConfig {
  /** A connected AztecClient in `standard` mode (its account pays). */
  client: AztecClient;
  /** The same bridge secret the client was built from; derived with `deriveAccountKeys`, not retained. */
  secretKey: string;
  /** `PXE_BRIDGE_OXIDE_JOURNAL`: its own SQLite file, beside (never the same as) the settlement journal. */
  journalPath: string;
  /**
   * One-shot `PXE_BRIDGE_OXIDE_JOURNAL_INITIALIZE=true` acknowledgement for
   * first creation. Remove it after the first successful start.
   */
  initializeJournal: boolean;
  /** `PXE_BRIDGE_OXIDE_L1_RPC_URL`: Ethereum mainnet, read-only. */
  l1RpcUrl: string;
  /** `PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT`: compiled OxideToken JSON at the pinned class. */
  tokenArtifactPath: string;
  mayBroadcast: MayBroadcastClient;
  /** The private recipient allowlist (`oxideAllowlistFromEnv`) supplied to the fresh-send admission predicate. */
  allowlist: OxideAllowlist;
  /** Whether readiness attestations run (index.ts built an AttestationProducer); `/ready` is not ready without them. */
  attestationConfigured: boolean;
  /** `PXE_BRIDGE_SETTLEMENT_CORRIDOR`, published on `/ready` for Riddler's pre-pull recheck. */
  corridor: CorridorConfig | undefined;
  caps?: OxideCapsConfig;
  l1?: OxideL1Reader;
}

/** The sender and the readiness predicate behind Oxide `/ready` and fresh-send admission. */
export interface OxideRuntime {
  sender: OxideSender;
  readiness: OxideReadiness;
  journal: OxideJournal;
}

/**
 * Builds the Oxide sender on a connected standard-mode client. Refuses only
 * what is local and fixed: an artifact that is not the deployed class, an
 * OXDAI instance not locked to it, spend keys that do not derive the account.
 * The live deployment (L1, the Oxide manifest, the zk.money profile, the
 * portal, the enclave) is NOT asserted here: an outage of any of them must
 * not stop the bridge from serving `aztec_getSettlement` and recovering
 * journaled payouts. It is checked before every fresh attempt and every
 * resend (`preflight.assertPinned`), the enclave is connected on first sign,
 * and readiness reports all of it (`/ready`, admission).
 */
export async function createOxideSender(config: OxideSenderConfig): Promise<OxideRuntime> {
  const l1 = config.l1 ?? viemL1Reader(config.l1RpcUrl);
  const pins = new OxidePinChecker();

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

  const journal = OxideJournal.open(config.journalPath, {
    allowCreate: config.initializeJournal,
    identity: {
      account: backend.account,
      token: OXIDE_V6_MAINNET.bridge.l2Token,
      deployment: `${OXIDE_V6_MAINNET.deploymentId}:${OXIDE_V6_MAINNET.gitSha}`,
    },
  });
  const caps = config.caps ?? capsFromEnv(process.env);
  const preflight = {
    // Per fresh attempt: the published pins (cached 5 min) and L1, which
    // also refuses a frozen portal.
    assertPinned: async () => {
      await pins.assertPinned();
      await assertL1Pinned(l1, OXIDE_V6_MAINNET);
    },
  };
  // The readiness exists before the sender, which takes it as its admission;
  // the fee runway it reports is the sender's own read.
  let sender: OxideSender | undefined;
  const readiness = new OxideReadiness({
    allowlist: config.allowlist,
    account: backend.account,
    token: OXIDE_V6_MAINNET.bridge.l2Token,
    caps,
    journal,
    balance: backend,
    feeRunway: () => (sender ? sender.feeRunway() : Promise.resolve(unknown("fee_runway_unknown"))),
    manifestPins: pins,
    l1Pins: {
      assertPinned: () => assertL1Pinned(l1, OXIDE_V6_MAINNET),
      portalFrozen: async () => (await l1.portal()).frozen,
    },
    enclave: backend,
    node,
    network: config.client,
    corridor: config.corridor,
    attestationConfigured: config.attestationConfigured,
  });
  sender = new OxideSender({ journal, backend, caps, mayBroadcast: config.mayBroadcast, preflight, admission: readiness });
  return { sender, readiness, journal };
}
