/**
 * A failure that is deterministic for the same inputs: retrying with identical inputs yields the
 * same refusal. Callers should not retry these; they should surface them.
 */
export class PermanentError extends Error {}

/** Verdicts the fleet router reports in its `x-oxide-router-error` header when it answers instead of
 *  an enclave. `tee-unknown`: nothing in the fleet holds the named identity. `no-tee-routable`: the
 *  fleet has no healthy enclave to hand out. `tee-unreachable`: the named host did not answer. */
export type RouterErrorCode = 'tee-unknown' | 'no-tee-routable' | 'tee-unreachable';

/** An enclave answered and refused. It is deterministic over its input, so the same request refused
 *  once will be refused again — hence a {@link PermanentError}, which retrying layers give up on. */
export class EnclaveRejected extends PermanentError {}

/**
 * The request never reached a working enclave: an HTTP failure, a timeout, a connection error, a
 * router verdict, or an unauthenticated outer reply the host could have forged. Deliberately *not* a
 * {@link PermanentError} — the fleet changes shape as instances register and drain, so the same
 * request may succeed against another enclave moments later.
 */
export class EnclaveUnavailable extends Error {
  readonly status?: number;
  readonly routerCode?: RouterErrorCode;

  constructor(message: string, detail: { status?: number; routerCode?: RouterErrorCode; cause?: unknown } = {}) {
    super(message, { cause: detail.cause });
    this.status = detail.status;
    this.routerCode = detail.routerCode;
  }
}
