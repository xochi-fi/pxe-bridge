import type { AttestationData } from '../oxide-lib/attestation/attestation_data.js';
import { decodeResponse, encodeRequest } from '../oxide-lib/codec.js';
import { FrameReader, frame } from '../oxide-lib/framing.js';

import { EnclaveUnavailable, type RouterErrorCode } from './errors.js';

/**
 * The wire layer for talking to an enclave: length-prefixed frames over one HTTP POST, plus the
 * classification of everything that can go wrong before an enclave replies. Knows nothing about
 * sealing, verification or fleets.
 */

/**
 * Names the enclave a request is addressed to. The fleet router resolves it to the host holding that
 * enclave; a bare per-host proxy ignores it. A request *without* it is routed round-robin over the
 * healthy enclaves — which is how the fleet makes its load-balancing decision, so a client's initial
 * attestation fetch omits it and sealed calls deliberately carry it.
 */
export const TEE_ID_HEADER = 'x-oxide-tee';

const ROUTER_ERROR_HEADER = 'x-oxide-router-error';
const ROUTER_CODES: readonly string[] = ['tee-unknown', 'no-tee-routable', 'tee-unreachable'];

export interface Timeouts {
  /** A plaintext attestation fetch: one enclave round trip plus the router's discovery lookup. */
  attestationMs: number;
  /** A sealed operation: a worst-case signTokenOperation is tens of seconds of enclave CPU. */
  operationMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = { attestationMs: 30_000, operationMs: 180_000 };

/**
 * Send one framed request, return the framed reply as JSON text.
 *
 * Throws {@link EnclaveUnavailable} for everything that is not an enclave's reply: HTTP failures
 * (carrying the router's verdict when it set one), timeouts, connection errors, truncated bodies. A
 * reply the enclave itself refused *is* a successful round trip here — the caller decodes the
 * envelope and decides.
 */
export async function postFrame(
  url: string,
  requestJson: string,
  timeoutMs: number,
  teeAddress?: string,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const framed = frame(requestJson);
    // fetch's BodyInit (DOM types) doesn't cleanly accept Buffer<ArrayBufferLike>; copy into a fresh
    // ArrayBuffer, which always is one.
    const body = new ArrayBuffer(framed.byteLength);
    new Uint8Array(body).set(framed);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        ...(teeAddress ? { [TEE_ID_HEADER]: teeAddress } : {}),
      },
      body,
      signal: ac.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new EnclaveUnavailable(`enclave endpoint returned HTTP ${resp.status}: ${detail.trim()}`, {
        status: resp.status,
        routerCode: routerCodeOf(resp),
      });
    }

    const respBytes = Buffer.from(await resp.arrayBuffer());
    const frames = new FrameReader().push(respBytes);
    if (frames.length !== 1) {
      throw new EnclaveUnavailable(
        frames.length === 0
          ? 'enclave endpoint returned a body with no complete frame'
          : `enclave endpoint returned ${frames.length} frames; expected exactly one`,
      );
    }
    const reply = frames[0];
    if (4 + reply.length !== respBytes.length) {
      throw new EnclaveUnavailable('enclave endpoint returned trailing bytes after the response frame');
    }
    return reply.toString('utf8');
  } catch (err) {
    if (err instanceof EnclaveUnavailable) {
      throw err;
    }
    if ((err as { name?: string }).name === 'AbortError') {
      throw new EnclaveUnavailable(`enclave RPC timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw new EnclaveUnavailable(`enclave RPC failed: ${(err as Error).message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an enclave's attestation **without verifying it against the `TeeRegistry`**, so the keys it carries
 * are untrusted. Two callers legitimately want that: bootstrap registration, where no registration exists
 * yet, and liveness probing, which only cares that the enclave answers. Anything that will seal a
 * request to these keys must go through `FleetSigner.connect`, which verifies the registration first.
 * `teeAddress` pins the fetch to a named fleet member; without it the router assigns one.
 */
export async function fetchUnverifiedAttestation(
  url: string,
  timeoutMs = DEFAULT_TIMEOUTS.attestationMs,
  teeAddress?: string,
): Promise<AttestationData> {
  const replyJson = await postFrame(url, encodeRequest('getAttestation', undefined), timeoutMs, teeAddress);
  return await decodeResponse('getAttestation', replyJson);
}

function routerCodeOf(resp: Response): RouterErrorCode | undefined {
  const code = resp.headers.get(ROUTER_ERROR_HEADER);
  return code && ROUTER_CODES.includes(code) ? (code as RouterErrorCode) : undefined;
}
