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
}

/**
 * Builds the Oxide sender and the fresh-send admission predicate on a
 * connected standard-mode client. Refuses, before anything can be sent,
 * unless L1, the Oxide manifest and the zk.money profile all describe the
 * pinned v6 deployment and the artifact is the deployed class. The settlement
 * layer (wired in #89) asks `readiness.admit` before a fresh send, then calls
 * `OxideSender.send`; nothing here serves HTTP or invokes admission itself.
 */
export async function createOxideSender(config: OxideSenderConfig): Promise<OxideRuntime> {
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
  sender = new OxideSender({ journal, backend, caps, mayBroadcast: config.mayBroadcast, preflight });
  return { sender, readiness };
}
