# Security

## Reporting

Report vulnerabilities privately to the maintainers before public disclosure.

## Threat model

The spending-limit account contract assumes the bridge signing key may be
compromised and aims to limit the damage via per-transaction amount caps, a
24h rolling volume cap, a recipient allowlist, and a single permitted token
fixed at construction, all enforced on-chain and independent of the
application-level limits in `src/limits.ts`.

The admin is a separate party from the signing key holder, and every admin
lever follows one asymmetry: **tightening waits out the 24h timelock,
loosening and stopping are immediate.**

| Lever | Direction | Timing |
| --- | --- | --- |
| `pause` / `unpause` | Stop everything | Immediate |
| `remove_recipient` | Revoke a payee | Immediate |
| `lower_min_anonymity` | Loosen the hint floor | Immediate |
| `propose_recipient` + `apply_recipient` | Add a payee | 24h |
| `propose_limits` + `apply_limits` | Change caps or raise the floor | 24h |

`pause` is the response to a compromised signing key: it is checked in
`check_spending_public`, so it stops a transaction however far through proving
it already is. A timelock on it would hand an attacker exactly the notice
period they need.

`remove_recipient` is deliberately not blocked when it would leave fewer live
entries than `min_anonymity_set`, which makes every hint unsatisfiable and
stops all transfers. Refusing an emergency revocation to protect an
availability property is the wrong trade; `lower_min_anonymity` is the
untimelocked way back.

An attacker holding the **admin** key is outside this model. They have
`propose_limits`, and a 24h public notice is the whole defence.

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
- e2e tests in `tests/e2e/spending-limit.test.ts` reach what `aztec-nargo test`
  cannot. The guard itself is private, so it runs in ACIR either way; what only
  the sandbox exercises is `check_spending_public` as transpiled AVM bytecode,
  plus everything that depends on `msg_sender` or a public read: the token pin,
  admin authorization, phase ordering, and revocation of an already-proven
  transfer.
- The check is fail-closed: any mismatch reverts the transaction, so an error
  surfaces as a failing tx, never a silent bypass.

On the TypeScript side, the entrypoint no longer accepts a declaration at all.
It reads `declared_amount` and `declared_recipient` out of the
`transfer_to_private` call in the payload it is signing, so declared == actual
holds by construction there and the circuit re-proves it rather than catching
the client out. A payload without exactly one such call is refused before it
costs a fee.

Barretenberg SIGILLs on Apple Silicon (ARM), so the sandbox e2e runs only on
x86 CI. `aztec compile` does not finish there either, since it generates
verification keys through the same library; `aztec-nargo test` runs anywhere.

The binding assumes `createNote`'s single-transfer shape. If the bridge later
issues multi-call payloads, extend the helper to match and sum every
value-moving call rather than requiring exactly one.

## Fee juice

The spending-limit account's guard also stops it paying its own way. Its
entrypoint admits exactly one call and requires it to be `transfer_to_private`
on the pinned token; `FeeJuice.claim` is not that call, and every fee payment
method the SDK offers contributes a second call which `mergeExecutionPayloads`
folds into the same `AppPayload` the entrypoint receives. `PREEXISTING_FEE_JUICE`
is the only branch left, and it is also the only one that calls `end_setup()`,
which is the phase boundary the limit checks depend on.

Somebody else therefore has to put a balance there. `scripts/top-up-fee-juice.ts`
bridges from L1 naming the bridge as recipient and then sends
`FeeJuice.claim(to = bridge, ...)` from a separate payer account, which works
because `claim` takes its beneficiary as an argument rather than as `msg_sender`.

This introduces an operational key (`FEE_JUICE_PAYER_KEY`) but no new trusted
party for funds:

- The L1 to L2 message hash commits to the recipient
  (`get_bridge_gas_msg_hash(owner, amount)`), so the claim can only credit the
  account it was bridged to. A payer that goes rogue, or a leaked claim secret,
  can consume the message early but cannot redirect it. The failure mode is
  liveness, not theft.
- Fee juice cannot be moved once credited. `FeeJuice` has `claim`,
  `claim_and_end_setup` and `public_dispatch`, and no transfer or withdrawal.
  That also means a top-up sent to a mistyped address is lost to everyone, which
  is why the script validates the address before the L1 write.
- The payer's own balance pays for the claim transaction, so a compromised payer
  key spends the payer's fee juice and nothing of the bridge's.

`FEE_JUICE_CLAIM` is refused at startup when `PXE_BRIDGE_SPENDING_LIMIT_ADMIN`
is set. Attaching a claim to that account names it as fee payer on a deploy sent
from the separate deployer account, and `BaseWallet.completeFeeOptions` only
emits `FEE_JUICE_WITH_CLAIM` when the sender is the fee payer; otherwise the
sender's entrypoint gets `EXTERNAL` and sets no fee payer at all. Since
`claim_and_end_setup` does not call `set_as_fee_payer` either, the transaction
would have none. Failing at startup with the reason beats failing during
deployment with a message about fee payers.

## What is public

The contract enforces its limits against public state, and a public function's
arguments are part of the transaction. Every transfer therefore publishes:

- **The amount.** `declared_amount` is an argument to `check_spending_public`.
- **A candidate recipient set.** `allowlist_hint` is an argument to the same
  call. It names between `min_anonymity_set` and `ALLOWLIST_SIZE` (8) addresses,
  one of which is the recipient. Which one is not published.
- **The token.** Pinned at construction and visible as the call target.

The allowlist is public regardless, because `propose_recipient` and
`remove_recipient` take the address as an ordinary public argument, so the
admin's own transactions publish every entry. The hint therefore leaks nothing
the chain does not already show; what it does is narrow each transfer's
recipient to a member of a small, published set.

This is inherent to checking a value against public storage and is not
remediated. Enforcing the same limits privately would mean nullifier-based
counters and a different contract. The recipient's identity and the note
contents remain private; the amount does not. Callers who need the amount
private cannot use the spending-limit account.

## Transaction cancellation is not supported

The entrypoint takes a `cancellable` flag and, when set, pushes a nullifier
derived from the payload's `tx_nonce`, which is the mechanism a wallet would use
to replace a pending transaction. This account offers no way to use it, and
NM-1019 [Low] records that: the only path through the entrypoint is a real
transfer, so cancelling means sending another one, which costs an allowlisted
recipient, unspent per-tx cap and room in the daily window. There are reachable
states with none of those, and they are exactly the states where cancelling
matters.

Accepted rather than fixed, because the branch cannot be entered. `cancellable`
arrives from `BaseWallet.cancellableTransactions`, which is `protected`,
initialised `false`, and has no setter anywhere in the SDK. The bridge does not
subclass the wallet, so every transaction it sends passes `false` and no
cancellation nullifier is ever emitted. Operationally the bridge does not want
the feature either: it submits and reconciles through the idempotency store
rather than leaving a transaction pending for someone to withdraw.

What this costs: if a later SDK makes cancellation the default, the account would
begin advertising a cancellation it cannot honour. That is the finding as
written, and it is the trigger for revisiting this. Both fixes move the contract
class ID and therefore the account address, so either lands before a deployment
is fixed, not after.

## Build supply chain

The `contract` CI job installs the Aztec toolchain by piping
`https://install.aztec.network` into bash. There is no published checksum to pin
against, so the build trusts that endpoint. `aztec-up install 5.1.0` pins the
toolchain version but not the installer that fetches it.

The artifact it produces is not committed, so the mitigation is downstream:
`scripts/contract-class-id.js` compares the resulting contract class ID against
`contracts/spending_limit_account/CLASS_ID` and fails the job on drift. A
compromised or merely updated toolchain changes that ID, and the account address
derives from it.

### `aztec compile` is not reproducible

Introducing that check immediately found the following. Across four CI runs of
identical sources, with identical reported toolchain versions (aztec 5.1.0, noir
`1.0.0-beta.22+c57152f9`), three produced class ID `0x0df61951...` and one
produced `0x2ff3ed37...`. Re-running the odd job passed.

The consequences are worth stating plainly:

- **The account address is not reproducible from source.** Rebuilding the
  artifact can yield a different contract class and therefore a different
  address, holding no funds.
- **The artifact that a deployment was made against must be archived**, not
  regenerated. The CI job uploads it on every run, before the class ID check, so
  a drifted build is preserved for comparison rather than discarded.
- **A red class ID check may be this flake rather than a real change.** Diff the
  uploaded artifact against a known-good one before concluding either way.

Root cause is not established. Nothing here depends on the ID being stable
except deployment itself, which is exactly the thing that cannot tolerate it.

## Application-level limits

`src/limits.ts` provides defense-in-depth independent of the contract. Limit
checks reserve the amount against the rolling window at admission time
(`reserve()`), commit on success, and release on failure, so concurrent
in-flight requests cannot each pass on a stale total and collectively exceed the
daily cap.

A failure that may have left the transfer on chain -- the send deadline, or a
receipt that could not be read back -- commits rather than releases, and answers
with a distinct RPC message carrying the txHash. Releasing those let a caller
repeat whatever caused the failure and move past the cap without the window
seeing it.

## Idempotency

That distinct message tells a caller not to retry blindly, but nothing enforced
it. The `Idempotency-Key` request header does: a duplicate replays the first
attempt's response rather than transferring again, so the ambiguous case stays
ambiguous instead of being resolved by moving funds a second time.

Three properties carry the weight:

- **The claim is synchronous.** `begin()` marks the key before any await, so two
  concurrent requests with one key cannot both proceed. The duplicate this
  exists to stop is exactly the one that would otherwise race past the check.
- **Intent is recorded before the send.** A `submitting` entry is flushed to the
  audit log first, so a crash between submitting and recording the outcome is
  recoverable: on restart, a key left at `submitting` replays as `unknown`.
  Without it, the crash-mid-send window -- the one that most needs covering --
  would hand the key back as fresh.
- **Only transfers are protected.** A request stopped by validation or by the
  limits frees its key, because there is no transfer to repeat and recording the
  failure would leave the caller unable to settle the trade at all. This departs
  from Stripe's replay-errors-forever semantics deliberately.

The residual window is a crash before the `submitting` record reaches disk. At
that point the send has not been made, so a retry is correct.

Keys are held 24h, and durability depends on `PXE_BRIDGE_AUDIT_LOG` being a file
path. Without it the store is in-memory and a restart forgets every key.

The circuit breaker trips when committed volume reaches the daily cap, not when
a single request would overshoot it. A request larger than the remaining budget
is rejected on its own; tripping there meant one oversized request, needing no
prior volume when `PXE_BRIDGE_MAX_AMOUNT` was unset, stopped the bridge for a
full window.

The rolling window is rebuilt from `PXE_BRIDGE_AUDIT_LOG` at startup. Without
that path set it is in-memory only and a restart hands back the full daily
budget, which matters because a restart used to be the only way to clear a
tripped breaker. `POST /admin/resume` is now that way, gated on
`PXE_BRIDGE_ADMIN_KEY` -- separate from the RPC key, so a caller who can move
funds cannot clear the breaker that stopped them.

## Transport

- 30s deadline on receiving a request (`server.requestTimeout`) and 150s on
  producing a response (`res.setTimeout`), the latter above the client's 120s
  transaction timeout. These are separate limits: `requestTimeout` alone, which
  is all this had, bounds nothing about how long a reply may take, so a stalled
  node held sockets open indefinitely.
- 64KB body limit, 60 requests/min per IP, `Content-Type: application/json`
  required on POST.
