import { EthAddress } from '@aztec-labs/stdlib/block';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import type { AttestationData } from '../oxide-lib/attestation/attestation_data.js';
import { ethAddressFromSecpPublicKey } from '../oxide-lib/attestation/user_data.js';
import {
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  decodeResponseEnvelope,
  parseInnerResult,
  sealEncryptedRequest,
} from '../oxide-lib/codec.js';
import { P256PublicKey } from '../oxide-lib/encryption.js';
import type {
  EnclaveIdentity,
  FrozenDepositsRefundFinalizationInput,
  FrozenDepositsRefundFinalizationOutput,
  FrozenNotesRefundFinalizationInput,
  FrozenNotesRefundFinalizationOutput,
  PortalDomain,
  SecpPublicKey,
  TokenOperation,
  UnprocessedDepositRefundFinalizationInput,
  UnprocessedDepositRefundFinalizationOutput,
  WithdrawalFinalizationInput,
  WithdrawalFinalizationOutput,
} from '../oxide-lib/types.js';

import { type Timeouts, postFrame } from './enclave_transport.js';
import { EnclaveRejected, EnclaveUnavailable, PermanentError } from './errors.js';
import type { RegisteredSignTokenOperationOutput, RegisteredTeeSigner } from './types.js';

/**
 * A request sealed to one enclave. `send` may be called repeatedly: the enclave is deterministic and
 * keeps nothing per request, so a retry after a transport failure can resend the identical bytes
 * rather than re-sealing — which for a max-size operation is the difference between a resend and
 * re-encrypting a hundred-plus megabytes.
 */
export interface SealedCall<M extends RpcMethod> {
  readonly enclave: PinnedEnclave;
  send(): Promise<RpcResult<M>>;
}

/**
 * An immutable handle to one enclave, addressed by the identity in its attestation.
 *
 * Every key and address derives from the attestation this was built with, so the identity can never
 * change under a caller — hold this when you need one that stays put. A pinned enclave that dies stays
 * dead and its calls fail; recovering by moving to another enclave is `FleetSigner`'s job.
 *
 * Nothing here verifies the enclave. Build these through `FleetSigner.connect`, which checks the
 * attestation against the portal's `TeeRegistry` first; the constructor is public only for
 * flows that have already done that check themselves. The one local check is a fail-fast on request
 * headers that name another chain than the portal's.
 */
export class PinnedEnclave implements RegisteredTeeSigner, EnclaveIdentity {
  // TODO(benesjan): make yarn-project/oxide-client/src/fleet_signer.ts::verifyAndPin a static function
  // on this class and make this constructor private and de-claudify the class docs.
  constructor(
    readonly url: string,
    readonly attestation: AttestationData,
    private readonly timeouts: Timeouts,
    readonly portalDomain: PortalDomain,
    readonly registrationLeafIndex: bigint,
  ) {}

  get teeRegistry(): EthAddress {
    return this.portalDomain.teeRegistry;
  }

  get publicKey(): SecpPublicKey {
    return { x: this.attestation.userData.publicKeyX, y: this.attestation.userData.publicKeyY };
  }

  get ethAddress(): EthAddress {
    return ethAddressFromSecpPublicKey(this.publicKey);
  }

  get encryptionPublicKey(): P256PublicKey {
    return P256PublicKey.fromCoordinates({
      x: this.attestation.userData.encPubKeyX,
      y: this.attestation.userData.encPubKeyY,
    });
  }

  async signTokenOperation(operation: TokenOperation): Promise<RegisteredSignTokenOperationOutput> {
    const output = await this.call('signTokenOperation', operation);
    return { ...output, publicKey: this.publicKey, registrationLeafIndex: this.registrationLeafIndex };
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

  /**
   * Seal a request to this enclave without sending it, so a caller that owns a retry policy can send
   * the same bytes more than once. Sealing binds the request to this enclave's encryption key: moving
   * to a different enclave requires preparing again.
   */
  async prepare<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<SealedCall<M>> {
    this.assertHeaderChain(params);
    const { body, openResponse } = await sealEncryptedRequest(
      this.encryptionPublicKey,
      method,
      params,
      this.portalDomain,
      { discloseDomain: false },
    );
    const address = this.ethAddress.toString();
    return {
      enclave: this,
      send: async () => {
        const replyJson = await postFrame(this.url, body, this.timeouts.operationMs, address);
        return await this.unseal(method, openResponse, replyJson);
      },
    };
  }

  private async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    return await (await this.prepare(method, params)).send();
  }

  /** Fail fast on a header that names another chain. */
  private assertHeaderChain(params: unknown): void {
    const { anchorBlockHeader, frozenTip } = (params ?? {}) as {
      anchorBlockHeader?: BlockHeader;
      frozenTip?: BlockHeader;
    };
    const header = anchorBlockHeader ?? frozenTip;
    if (!header) {
      return;
    }
    const globals = header.globalVariables;
    if (globals.chainId.toBigInt() !== this.portalDomain.l1ChainId) {
      throw new PermanentError(
        `request header names chain id ${globals.chainId.toBigInt()}, but portal ${this.portalDomain.l1Portal} is on ${this.portalDomain.l1ChainId}`,
      );
    }
    if (globals.version.toBigInt() !== this.portalDomain.rollupVersion) {
      throw new PermanentError(
        `request header names rollup version ${globals.version.toBigInt()}, but portal ${this.portalDomain.l1Portal} is on ${this.portalDomain.rollupVersion}`,
      );
    }
  }

  /** Unwrap the host-visible outer envelope, then the HPKE-sealed inner one. Only an authenticated
   *  inner refusal is the enclave's verdict; anything outer is host-controlled transport. */
  private async unseal<M extends RpcMethod>(
    method: M,
    openResponse: (responseCiphertext: Buffer) => Promise<Buffer>,
    replyJson: string,
  ): Promise<RpcResult<M>> {
    const outer = await decodeResponseEnvelope(replyJson);
    // Outer response bytes are host-controlled. Only an HPKE-authenticated inner verdict is permanent.
    if (outer.kind !== 'encrypted') {
      throw new EnclaveUnavailable(
        outer.kind === 'error'
          ? `enclave proxy returned unauthenticated error for ${method}: ${outer.error}`
          : `enclave proxy returned unauthenticated plaintext response for ${method}`,
      );
    }
    const inner = await decodeResponseEnvelope((await openResponse(outer.ciphertext)).toString('utf8'));
    if (inner.kind === 'error') {
      throw new EnclaveRejected(`enclave refused ${method}: ${inner.error}`);
    }
    if (inner.kind !== 'plaintext') {
      throw new EnclaveRejected(`enclave nested a sealed response inside ${method}'s sealed response`);
    }
    return await parseInnerResult(method, inner.result);
  }
}
