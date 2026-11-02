// The client side of the enclave RPC codec. The enclave side is in `@oxide/oxide-lib-tee/codec.js`, which this module
// re-exports. The enclave does not use this code, so a change here does not change the enclave PCR0.
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';

import { ENCRYPTED_OUTER_METHOD, RPC_METHODS, type RpcMethod, type RpcParams } from '../oxide-lib-tee/codec.js';
import { type P256PublicKey, sealRequest } from '../oxide-lib-tee/encryption.js';
import { type PortalDomain, PortalLink } from '../oxide-lib-tee/types.js';

import { z } from 'zod4';

export * from '../oxide-lib-tee/codec.js';

export type RpcResult<M extends RpcMethod> = z.output<(typeof RPC_METHODS)[M]['result']>;
const RpcResponseEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), ciphertext: z.string() }),
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export function encodeRequest<M extends RpcMethod>(method: M, params: RpcParams<M>, link?: PortalLink): string {
  return jsonStringify({ method, params, ...(link ? { link } : {}) });
}

export function encodeEncryptedRequest(payload: Buffer, domain?: PortalDomain): string {
  return jsonStringify({
    method: ENCRYPTED_OUTER_METHOD,
    payload: payload.toString('base64'),
    ...(domain ? { domain } : {}),
  });
}

export async function sealEncryptedRequest<M extends RpcMethod>(
  recipientPublicKey: P256PublicKey,
  method: M,
  params: RpcParams<M>,
  domain: PortalDomain,
  { discloseDomain = false }: { discloseDomain?: boolean } = {},
): Promise<{ body: string; openResponse: (responseCiphertext: Buffer) => Promise<Buffer> }> {
  const link = PortalLink.from(domain);
  const disclosed = discloseDomain ? domain : undefined;
  const sealed = await sealRequest(
    recipientPublicKey,
    Buffer.from(encodeRequest(method, params, link), 'utf8'),
    disclosed,
  );
  return { body: encodeEncryptedRequest(sealed.wirePayload, disclosed), openResponse: sealed.openResponse };
}

export type DecodedResponse =
  | { kind: 'plaintext'; result: unknown }
  | { kind: 'encrypted'; ciphertext: Buffer }
  | { kind: 'error'; error: string };

export async function decodeResponseEnvelope(json: string): Promise<DecodedResponse> {
  const env = await RpcResponseEnvelopeSchema.parseAsync(JSON.parse(json));
  if (!env.ok) {
    return { kind: 'error', error: env.error };
  }
  if ('ciphertext' in env) {
    return { kind: 'encrypted', ciphertext: Buffer.from(env.ciphertext, 'base64') };
  }
  return { kind: 'plaintext', result: env.result };
}

export async function decodeResponse<M extends RpcMethod>(method: M, json: string): Promise<RpcResult<M>> {
  const env = await decodeResponseEnvelope(json);
  if (env.kind === 'error') {
    throw new Error(`Enclave RPC error (${method}): ${env.error}`);
  }
  if (env.kind !== 'plaintext') {
    throw new Error(`Enclave RPC error (${method}): expected plaintext result`);
  }
  return (await RPC_METHODS[method].result.parseAsync(env.result)) as RpcResult<M>;
}

export async function parseInnerResult<M extends RpcMethod>(method: M, result: unknown): Promise<RpcResult<M>> {
  return (await RPC_METHODS[method].result.parseAsync(result)) as RpcResult<M>;
}
