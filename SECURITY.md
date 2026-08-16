# Security

## Reporting

Report vulnerabilities privately to the maintainers before public disclosure.

## Threat model

The spending-limit account contract assumes the bridge signing key may be
compromised and aims to limit the damage via per-transaction amount caps, a
24h rolling volume cap, a recipient allowlist, and a single permitted token
fixed at construction, all enforced on-chain and independent of the
application-level limits in `src/limits.ts`.

## Declared-vs-actual amount binding

`contracts/spending_limit_account/src/main.nr` enforces spending limits against
`declared_amount`, which the entrypoint caller supplies. Without further checks
that is just a number the caller invents, so a key holder could declare
`amount = 1` while the payload transfers more.

The entrypoint binds declared to actual via `assert_declared_matches_transfer`,
which runs in private: it reconstructs the transfer call's `args_hash` as
`hash_args([declared_recipient.to_field(), declared_amount as Field])` (the same
encoding the SDK uses for private call args, the cast reproducing how a u128
packs into one field) and asserts the payload contains exactly one non-empty
call whose `args_hash` equals it. Because `createNote` issues exactly one
`transfer_to_private(to, amount)` call, this pins both the recipient and the
amount of the real transfer to the declared values. No hidden second call can
ride along, and a smaller declared amount no longer under-reports a larger
transfer.

The guard also pins the call's selector to `transfer_to_private` as a
compile-time constant, along with `is_public`, `hide_msg_sender` and
`is_static`, so a different function with a colliding `args_hash` cannot
satisfy it. It returns the matched call's target, which
`check_spending_public` compares against the permitted token. That comparison
is in public deliberately: reading `permitted_token` from private would be a
historical read at the anchor block, and on the first transaction the
constructor's enqueued initializer has not been mined yet.

Combined with the rest of this change set:

- Recipient allowlist: enforced, but `check_spending_public` does not receive
  the recipient. Membership is proven in private against a caller-supplied
  hint, and the hint is bound to live storage in public by positional masking
  (`hint[i]` must equal `live[i]` or zero). `recipient IN hint` plus
  `hint masks live` gives `recipient IN live` evaluated at inclusion time,
  which is what lets an immediate removal invalidate an already-proven
  transfer. A transfer must carry at least `min_anonymity_set` slots, so the
  recipient is one of at least N; that is a count, not unlinkability, and the
  allowlist itself stays public because the admin writes entries in the clear.
  A zero recipient is rejected at both the circuit (`Recipient must not be
  zero`) and the RPC validation layer (`src/types.ts`).
- Third-party authwit: disabled (`verify_private_authwit` returns invalid), so
  the authwit side channel can no longer bypass the spending checks.
- Per-tx and daily volume caps: enforced against the bound (actual) amount.
  The daily cap is a sliding window of 25 hourly buckets, sized so that
  `(N-1)*W >= 86400` holds exactly and two full-limit spends can never fit
  inside 24 hours.

### Validation

The binding depends on the `AppPayload` serialized layout (`[FunctionCall; 5]`
+ `tx_nonce` = 31 fields, each call serialized in declaration order) pinned to
Aztec v5.1.0. It is validated three ways:

- `aztec-nargo test` unit tests in `contracts/spending_limit_account/src/main.nr`:
  `function_call_serialize_layout` asserts `args_hash`/`target_address` sit at
  the offsets the guard reads; `mismatched_transfer_reverts`,
  `hidden_second_call_reverts`, and `empty_payload_reverts` prove the guard
  rejects a declared/actual mismatch, a hidden second call, and an empty
  payload; `stale_hint_is_rejected` and `minimal_hint_is_rejected` cover the
  allowlist binding and the anonymity floor. The `contract` CI job runs these
  and `aztec compile`.
- e2e tests in `tests/e2e/spending-limit.test.ts` run the same guard as
  transpiled AVM bytecode against a real sandbox, which `aztec-nargo test`
  cannot: it runs in Brillig and says nothing about what actually executes.
- The check is fail-closed: any mismatch reverts the transaction, so an error
  surfaces as a failing tx, never a silent bypass.

Barretenberg SIGILLs on Apple Silicon (ARM), so the sandbox e2e runs only on
x86 CI. `aztec compile` does not finish there either, since it generates
verification keys through the same library; `aztec-nargo test` runs anywhere.

The binding assumes `createNote`'s single-transfer shape. If the bridge later
issues multi-call payloads, extend the helper to match and sum every
value-moving call rather than requiring exactly one.

## Application-level limits

`src/limits.ts` provides defense-in-depth independent of the contract. Limit
checks reserve the amount against the rolling window at admission time
(`reserve()`), commit on success, and release on failure, so concurrent
in-flight requests cannot each pass on a stale total and collectively exceed the
daily cap.
