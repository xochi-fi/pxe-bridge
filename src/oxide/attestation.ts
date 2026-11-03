import type {
  AccountAttestationObservation,
  AttestationChainProbe,
  AttestationObservation,
} from "../attestation.js";
import type { OxideAllowlist } from "./allowlist.js";

/** The standard-account half of the chain observation (`AztecClient.observeStandardAccountChain`). */
export interface StandardAccountChainProbe {
  observeStandardAccountChain(
    recipient: string | undefined,
    genesisOrNetworkDigest: string,
  ): Promise<AccountAttestationObservation>;
}

/**
 * The attestation probe in Oxide mode (xochi-fi/xochi#775 option a). Chain
 * facts come from one exact finalized observation: the network, a fresh
 * finalized reference, the sending account published at the stock
 * SchnorrAccount 6.0.0 class and initialized there, and the recipient's
 * deployment. The allowlist root is the bridge's PRIVATE off-chain root, so
 * `AttestationProducer` and `RootUpdatePublisher` sign Membership and
 * RootUpdate over it exactly as they sign over the spending-limit account's
 * on-chain root, and the Worker verifies them unchanged.
 *
 * `rootBlock` therefore means the finalized block at which the bridge held
 * that root; a changed root is published only from a later block
 * (`RootUpdatePublisher`), which is what the Worker's monotonic floor needs.
 */
export class OxideAttestationProbe implements AttestationChainProbe {
  constructor(
    private readonly chain: StandardAccountChainProbe,
    private readonly allowlist: OxideAllowlist,
  ) {}

  async observeAttestationChain(
    recipient: string | undefined,
    genesisOrNetworkDigest: string,
  ): Promise<AttestationObservation> {
    const observed = await this.chain.observeStandardAccountChain(recipient, genesisOrNetworkDigest);
    if (observed.state === "unknown") return observed;
    return { state: "known", value: { ...observed.value, allowlistRoot: this.allowlist.root } };
  }
}
