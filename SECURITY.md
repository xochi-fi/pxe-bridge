# Security

## Reporting

Report vulnerabilities privately to the maintainers before public disclosure.

## Threat model

The spending-limit account contract assumes the bridge signing key may be
compromised and aims to limit the damage via per-transaction amount caps, a
24h rolling volume cap, and a recipient allowlist, all enforced on-chain and
independent of the application-level limits in `src/limits.ts`.

## Known residual: declared-vs-actual amount binding (tracked)

`contracts/spending_limit_account/src/main.nr` enforces spending limits against
`declared_amount` / `declared_recipient`, which the entrypoint caller supplies.
These declared values are signed into the payload hash but are **not** proven to
match the amount/recipient of the transfer actually executed inside
`app_payload`. The token call's real args are committed behind `args_hash`, so
the current circuit cannot read them.

Impact after the hardening in this change set:

- Recipient allowlist: enforced. The zero-address sentinel skip was removed, and
  a zero recipient is rejected at both the circuit (`Recipient must not be zero`)
  and the RPC validation layer (`src/types.ts`).
- Third-party authwit: disabled (`verify_private_authwit` returns invalid), so
  the authwit side channel can no longer bypass the spending checks.
- Per-tx amount cap and daily volume cap: **still bypassable** on the entrypoint
  path -- a key holder can declare `amount = 1` while the payload transfers more.

### Required complete fix (follow-up)

Bind the declared values to the executed transfer inside the circuit:

1. Pass the raw transfer args into `entrypoint`.
2. Recompute the token call's args hash with `hash_args`.
3. Assert it equals the `args_hash` of the matching `app_payload.function_calls[i]`
   whose `target_address` is the token and whose `function_selector` is the
   transfer selector.
4. Derive `declared_amount` / `declared_recipient` from those bound args instead
   of trusting the caller.

This requires the Aztec toolchain (`nargo` + the x86 sandbox) to compile and
e2e-test and is not implementable on Apple Silicon (barretenberg SIGILLs under
ARM). Implement and validate it where CI runs.

## Application-level limits

`src/limits.ts` provides defense-in-depth independent of the contract. Limit
checks reserve the amount against the rolling window at admission time
(`reserve()`), commit on success, and release on failure, so concurrent
in-flight requests cannot each pass on a stale total and collectively exceed the
daily cap.
