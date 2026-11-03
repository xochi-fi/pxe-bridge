// Modified for pxe-bridge (see ../VENDORED.md): the L1 reads go through an
// injected FleetRegistry instead of @oxide/l1-contracts' OxidePortalContract and
// TeeRegistryContract, the portal domain is the pinned one, and verifyAndPin
// runs registry.verifyAttestation before trusting any key in the attestation.
import type { Buffer32 } from '@aztec-labs/foundation/buffer';
import { EthAddress } from '@aztec-labs/stdlib/block';

import type { AttestationData } from '../oxide-lib/attestation/attestation_data.js';
import { ethAddressFromSecpPublicKey } from '../oxide-lib/attestation/user_data.js';
import type { RpcMethod, RpcParams, RpcResult } from '../oxide-lib/codec.js';
import type {
  PortalDomain,
  FrozenDepositsRefundFinalizationInput,
  FrozenDepositsRefundFinalizationOutput,
  FrozenNotesRefundFinalizationInput,
  FrozenNotesRefundFinalizationOutput,
  TokenOperation,
  UnprocessedDepositRefundFinalizationInput,
  UnprocessedDepositRefundFinalizationOutput,
  WithdrawalFinalizationInput,
  WithdrawalFinalizationOutput,
} from '../oxide-lib/types.js';

import { DEFAULT_TIMEOUTS, type Timeouts, fetchUnverifiedAttestation } from './enclave_transport.js';
import { EnclaveUnavailable } from './errors.js';
import { PinnedEnclave, type SealedCall } from './pinned_enclave.js';
import type { RegisteredSignTokenOperationOutput, RegisteredTeeSigner } from './types.js';

export interface FleetSignerOptions {
  timeouts?: Partial<Timeouts>;
  /** Attempts for one operation. An attempt is "obtain a usable pin, then send", so a re-pin that
   *  fails spends one — a fleet with nothing to pin cannot be spun on. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/** The keys a `TeeRegistry` holds for one enclave. Upstream: `TEEKeys` in `@oxide/l1-contracts/tee_registry.js`. */
export interface TEEKeys {
  pubKeyX: Buffer32;
  pubKeyY: Buffer32;
  encPubKeyX: Buffer32;
  encPubKeyY: Buffer32;
}

/**
 * What pinning needs from L1, in place of upstream's `OxidePortalContract` (pxe-bridge change). `portalDomain` is
 * the pinned corridor's, not read from the portal at pin time; `verifyAttestation` runs before any key the
 * attestation carries is compared or trusted, and throws to refuse it.
 */
export interface FleetRegistry {
  readonly portalDomain: PortalDomain;
  getRegistration(tee: EthAddress): Promise<{ leafIndex: bigint; keys: TEEKeys }>;
  verifyAttestation(attestation: AttestationData): Promise<void>;
}

/**
 * A `TeeSigner` over a fleet of enclaves reached at one URL.
 *
 * Every registered enclave is an equal peer, so this pins one — verified against the portal's
 * `TeeRegistry` — and seals every request to it. When the fleet reports that pin is gone, it
 * pins another and retries. A fleet reporting no routable enclave at all fails on the spot instead:
 * capacity comes back only when a replacement host boots and registers, minutes later, so retrying
 * here would burn the budget to reach the same conclusion and hide the condition from the caller's
 * retry loop, which is the only thing on the right timescale.
 */
export class FleetSigner implements RegisteredTeeSigner {
  private pinned: PinnedEnclave;
  private repinning?: Promise<PinnedEnclave>;
  private readonly maxAttempts: number;

  private constructor(
    readonly url: string,
    private readonly registry: FleetRegistry,
    private readonly timeouts: Timeouts,
    options: FleetSignerOptions,
    pinned: PinnedEnclave,
  ) {
    this.pinned = pinned;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** Fetch an attestation from the fleet, verify it against the portal's `TeeRegistry`, and pin that enclave. */
  static async connect(
    url: string,
    registry: FleetRegistry,
    options: FleetSignerOptions = {},
  ): Promise<FleetSigner> {
    const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    return new FleetSigner(url, registry, timeouts, options, await verifyAndPin(url, registry, timeouts));
  }

  /** The enclave currently serving this signer. Immutable, so it stays valid as an identity even after
   *  the fleet moves on. */
  get enclave(): PinnedEnclave {
    return this.pinned;
  }

  get teeRegistry(): EthAddress {
    return this.pinned.teeRegistry;
  }

  async signTokenOperation(operation: TokenOperation): Promise<RegisteredSignTokenOperationOutput> {
    const { result, enclave } = await this.callReturningEnclave('signTokenOperation', operation);
    return { ...result, publicKey: enclave.publicKey, registrationLeafIndex: enclave.registrationLeafIndex };
  }

  signWithdrawalFinalization(input: WithdrawalFinalizationInput): Promise<WithdrawalFinalizationOutput> {
    return this.call('signWithdrawalFinalization', input);
  }

  signFrozenNotesRefundFinalization(
    input: FrozenNotesRefundFinalizationInput,
  ): Promise<FrozenNotesRefundFinalizationOutput> {
    return this.call('signFrozenNotesRefundFinalization', input);
  }

  signFrozenDepositsRefundFinalization(
    input: FrozenDepositsRefundFinalizationInput,
  ): Promise<FrozenDepositsRefundFinalizationOutput> {
    return this.call('signFrozenDepositsRefundFinalization', input);
  }

  signUnprocessedDepositRefundFinalization(
    input: UnprocessedDepositRefundFinalizationInput,
  ): Promise<UnprocessedDepositRefundFinalizationOutput> {
    return this.call('signUnprocessedDepositRefundFinalization', input);
  }

  private async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const { result } = await this.callReturningEnclave(method, params);
    return result;
  }

  private async callReturningEnclave<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
  ): Promise<{ result: RpcResult<M>; enclave: PinnedEnclave }> {
    let sealedRequest: SealedCall<M> | undefined = await this.pinned.prepare(method, params);
    let resentThisPin = false;
    let firstError: EnclaveUnavailable | undefined;
    let lastError: EnclaveUnavailable | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        // Re-pinning is part of the attempt, so its own failure spends the budget rather than escaping
        // and hiding why the operation actually failed.
        sealedRequest ??= await (await this.repin()).prepare(method, params);
        const result = await sealedRequest.send();
        return { result, enclave: sealedRequest.enclave };
      } catch (err) {
        // An enclave's refusal is deterministic and a failed verification is not ours to paper over.
        if (!(err instanceof EnclaveUnavailable)) {
          throw err;
        }
        firstError ??= err;
        lastError = err;
        const step = nextStep(err, sealedRequest !== undefined, resentThisPin);
        if (step === 'stop') {
          throw err;
        }
        resentThisPin = step === 'resend';
        sealedRequest = step === 'resend' ? sealedRequest : undefined;
      }
    }

    throw new EnclaveUnavailable(
      `${method} failed after ${this.maxAttempts} attempts against the fleet at ${this.url} (last: ${lastError?.message})`,
      { status: firstError?.status, routerCode: firstError?.routerCode, cause: firstError },
    );
  }

  /** Concurrent failures share one re-pin, so N in-flight calls cost one attestation fetch and agree
   *  on the enclave they move to. */
  private repin(): Promise<PinnedEnclave> {
    this.repinning ??= verifyAndPin(this.url, this.registry, this.timeouts)
      .then(pinned => {
        this.pinned = pinned;
        return pinned;
      })
      .finally(() => {
        this.repinning = undefined;
      });
    return this.repinning;
  }
}

/**
 * Fetch an attestation and pin the enclave it names, having established that the portal's `TeeRegistry`
 * registered exactly these keys. Upstream relies on that alone, because the registry registers only enclaves that
 * run its PCR0; pxe-bridge also runs `registry.verifyAttestation` first (Nitro chain, user data, PCR0).
 * Throws rather than returning a signer pointed at unverified key material.
 */
export async function verifyAndPin(
  url: string,
  registry: FleetRegistry,
  timeouts: Timeouts,
): Promise<PinnedEnclave> {
  const attestation = await fetchUnverifiedAttestation(url, timeouts.attestationMs);
  await registry.verifyAttestation(attestation);
  const { publicKeyX, publicKeyY, encPubKeyX, encPubKeyY } = attestation.userData;
  const ethAddress = ethAddressFromSecpPublicKey({ x: publicKeyX, y: publicKeyY });

  const portalDomain = registry.portalDomain;
  const teeRegistry = { address: portalDomain.teeRegistry };
  const { keys, leafIndex } = await registry.getRegistration(ethAddress);
  if (
    !publicKeyX.equals(keys.pubKeyX) ||
    !publicKeyY.equals(keys.pubKeyY) ||
    !encPubKeyX.equals(keys.encPubKeyX) ||
    !encPubKeyY.equals(keys.encPubKeyY)
  ) {
    throw new Error(
      `TEE ${ethAddress} attestation does not match the keys registered on TeeRegistry ${teeRegistry.address}`,
    );
  }
  return new PinnedEnclave(url, attestation, timeouts, portalDomain, leafIndex);
}

/**
 * What a failure is worth doing about.
 *
 * `no-tee-routable` is the fleet reporting it has no routable enclave at all, so there is nothing to
 * move to and no point spending the budget discovering that twice more — it returns on the timescale
 * of a host boot, which only the caller's retry loop can sensibly wait for. `tee-unknown` is narrower:
 * our own pin is gone, but other enclaves are presumably serving, so move. Anything else — a timeout, a
 * refused connection, an unreachable host — may be a blip worth resending the identical bytes once.
 */
function nextStep(err: EnclaveUnavailable, holdsPin: boolean, resentThisPin: boolean): 'resend' | 'repin' | 'stop' {
  if (err.routerCode === 'no-tee-routable') {
    return 'stop';
  }
  if (err.routerCode === 'tee-unknown') {
    return 'repin';
  }
  return holdsPin && !resentThisPin ? 'resend' : 'repin';
}
