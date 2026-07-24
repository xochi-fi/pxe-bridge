# Security

## Reporting

Report vulnerabilities privately to the maintainers before public disclosure.

## Threat model

The spending-limit account contract assumes the bridge signing key may be
compromised and aims to limit the damage via per-transaction amount caps, a
24h rolling volume cap, and a recipient allowlist, all enforced on-chain and
independent of the application-level limits in `src/limits.ts`.

## Declared-vs-actual amount binding

`contracts/spending_limit_account/src/main.nr` enforces spending limits against
`declared_amount` / `declared_recipient`, which the entrypoint caller supplies.
Without further checks these declared values are just numbers the caller
invents, so a key holder could declare `amount = 1` while the payload transfers
more.

The entrypoint now binds declared to actual via
`assert_declared_matches_transfer`: it reconstructs the transfer call's
`args_hash` as `hash_args([declared_recipient.to_field(), declared_amount])`
(the same encoding the SDK uses for private call args) and asserts the payload
contains exactly one non-empty call whose `args_hash` equals it. Because
`createNote` issues exactly one `transfer_to_private(to, amount)` call, this
pins both the recipient and the amount of the real transfer to the declared
values -- no hidden second call can ride along, and a smaller declared amount no
longer under-reports a larger transfer.

Combined with the rest of this change set:

- Recipient allowlist: enforced. The zero-address sentinel skip was removed, and
  a zero recipient is rejected at both the circuit (`Recipient must not be zero`)
  and the RPC validation layer (`src/types.ts`).
- Third-party authwit: disabled (`verify_private_authwit` returns invalid), so
  the authwit side channel can no longer bypass the spending checks.
- Per-tx and daily volume caps: enforced against the bound (actual) amount.

### CI validation required

The Noir changes cannot be compiled or e2e-tested on Apple Silicon (barretenberg
SIGILLs under ARM) and there is no local `nargo`. `assert_declared_matches_transfer`
depends on the `AppPayload` serialized layout (`[FunctionCall; 5]` + `tx_nonce`
= 31 fields, each call serialized in declaration order) pinned to Aztec v4.2.0.
It is fail-closed -- any mismatch reverts the transaction -- so a layout error
surfaces as failing e2e rather than a silent bypass. The CI `nargo compile` +
e2e job on x86 is the source of truth; do not merge until it is green.

The binding assumes `createNote`'s single-transfer shape. If the bridge later
issues multi-call payloads, extend the helper to match and sum every
value-moving call rather than requiring exactly one.

## Application-level limits

`src/limits.ts` provides defense-in-depth independent of the contract. Limit
checks reserve the amount against the rolling window at admission time
(`reserve()`), commit on success, and release on failure, so concurrent
in-flight requests cannot each pass on a stale total and collectively exceed the
daily cap.
