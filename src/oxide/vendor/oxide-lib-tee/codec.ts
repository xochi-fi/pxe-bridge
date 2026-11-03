import { jsonStringify } from '@aztec-labs/foundation/json-rpc';

import { z } from 'zod4';

import { AttestationDataSchema } from './attestation/attestation_data.js';
import {
  FrozenDepositsRefundFinalizationInputSchema,
  FrozenDepositsRefundFinalizationOutputSchema,
  FrozenNotesRefundFinalizationInputSchema,
  FrozenNotesRefundFinalizationOutputSchema,
  type PortalDomain,
  PortalDomainSchema,
  PortalLink,
  SignTokenOperationOutputSchema,
  TokenOperationSchema,
  UnprocessedDepositRefundFinalizationInputSchema,
  UnprocessedDepositRefundFinalizationOutputSchema,
  WithdrawalFinalizationInputSchema,
  WithdrawalFinalizationOutputSchema,
} from './types.js';

/**
 * Per-method param + result schemas. The dispatcher on the enclave side re-parses params with
 * the method-specific schema (envelope keeps params as `unknown` so we can route first).
 */
export const RPC_METHODS = {
  getAttestation: { params: z.undefined(), result: AttestationDataSchema },
  signTokenOperation: {
    params: TokenOperationSchema,
    result: SignTokenOperationOutputSchema,
  },
  signWithdrawalFinalization: { params: WithdrawalFinalizationInputSchema, result: WithdrawalFinalizationOutputSchema },
  signFrozenNotesRefundFinalization: {
    params: FrozenNotesRefundFinalizationInputSchema,
    result: FrozenNotesRefundFinalizationOutputSchema,
  },
  signFrozenDepositsRefundFinalization: {
    params: FrozenDepositsRefundFinalizationInputSchema,
    result: FrozenDepositsRefundFinalizationOutputSchema,
  },
  signUnprocessedDepositRefundFinalization: {
    params: UnprocessedDepositRefundFinalizationInputSchema,
    result: UnprocessedDepositRefundFinalizationOutputSchema,
  },
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;

// Use output (post-parse) types so callers pass real runtime instances (Fr, EthAddress, ...),
// not the permissive wire-form unions Zod's coercion schemas accept on input.
export type RpcParams<M extends RpcMethod> = z.output<(typeof RPC_METHODS)[M]['params']>;

/**
 * Outer envelope. `getAttestation` is the bootstrap RPC and goes plaintext (the response is the
 * public attestation that the client verifies before encrypting anything else). Every other
 * method ships under `{ method: "encrypted", payload: <base64> }` — the inner request + response
 * are HPKE-sealed to the enclave's P-256 pubkey, so the operator only ever sees ciphertext.
 */
export const ENCRYPTED_OUTER_METHOD = 'encrypted';

const RpcRequestEnvelopeSchema = z.union([
  z.object({
    method: z.literal(ENCRYPTED_OUTER_METHOD),
    payload: z.string(),
    domain: PortalDomainSchema.optional(),
  }),
  z.object({ method: z.string(), params: z.unknown().optional(), link: PortalLink.schema.optional() }),
]);

export type DecodedRequest =
  | { kind: 'plaintext'; method: RpcMethod; params: unknown; link?: PortalLink }
  | { kind: 'encrypted'; payload: Buffer; domain?: PortalDomain };

// Async-parse path: some sub-schemas (e.g. CompleteAddress) hydrate via async transforms,
// so the whole pipeline must use `parseAsync`. The transport layer is already async.
export async function decodeRequest(json: string): Promise<DecodedRequest> {
  const env = await RpcRequestEnvelopeSchema.parseAsync(JSON.parse(json));
  if (env.method === ENCRYPTED_OUTER_METHOD && 'payload' in env) {
    return { kind: 'encrypted', payload: Buffer.from(env.payload, 'base64'), domain: env.domain };
  }
  if (!Object.hasOwn(RPC_METHODS, env.method)) {
    throw new Error(`Unknown RPC method: ${env.method}`);
  }
  // The plaintext path is reserved for getAttestation; the dispatcher rejects everything else.
  return {
    kind: 'plaintext',
    method: env.method as RpcMethod,
    params: 'params' in env ? env.params : undefined,
    link: 'link' in env ? env.link : undefined,
  };
}

export function encodeOkResponse(result: unknown): string {
  return jsonStringify({ ok: true, result });
}

export function encodeEncryptedResponse(ciphertext: Buffer): string {
  return jsonStringify({ ok: true, ciphertext: ciphertext.toString('base64') });
}

// Wire error messages are capped so a caller cannot amplify a malformed request into a giant reply
// (a long ZodError lists one issue per bad element).
const MAX_ERROR_MESSAGE_CHARS = 4096;

export function encodeErrorResponse(error: unknown): string {
  let message: string;
  try {
    const raw = error instanceof Error ? error.message : String(error);
    message = raw.length > MAX_ERROR_MESSAGE_CHARS ? `${raw.slice(0, MAX_ERROR_MESSAGE_CHARS)}… [truncated]` : raw;
  } catch {
    // Materializing the message can itself throw: a multi-hundred-MB ZodError message overflows
    // V8's max string length, so reading `.message` raises ERR_STRING_TOO_LONG. Fall back instead.
    message = 'error message too large';
  }
  return jsonStringify({ ok: false, error: message });
}

// Re-parse the params blob with the method-specific schema (the request envelope leaves params
// as `unknown` so dispatch can pick the right schema).
export async function parseParams<M extends RpcMethod>(method: M, params: unknown): Promise<RpcParams<M>> {
  return (await RPC_METHODS[method].params.parseAsync(params)) as RpcParams<M>;
}
