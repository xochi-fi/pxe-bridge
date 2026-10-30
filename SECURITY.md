# Security

## Reporting

Report vulnerabilities privately to the maintainers before public disclosure.

## Threat model

The spending-limit account contract assumes the bridge signing key may be
compromised and aims to limit the damage via per-transaction amount caps, a
24h rolling volume cap, a recipient allowlist, and a single permitted token
fixed at construction, all enforced on-chain and independent of the
application-level limits in `src/limits.ts`.

The admin is a separate party from the signing key holder.

### Readiness attestation key

The optional readiness signer is a fourth, secp256k1 key. It cannot submit an
Aztec transaction, administer the account, or derive allowlist salts. If it is
compromised, however, an attacker can forge Membership, RecipientDeployment
and RootUpdate records for the configured corridor until consumers remove the
pinned signer. It therefore must not reuse the bridge signing key, admin key,
allowlist seed, or any RPC/admin/may-broadcast/attestation/relay bearer value;
the comparison occurs after ARN resolution. Production loads it only from
`PXE_BRIDGE_ATTESTATION_SECRET_ARN`.

The attestation endpoint has its own bearer credential and limiter. It accepts
no caller-selected domain, block, root or witness. Before root/deployment
reads, every signed observation validates the recorded solver address, pinned
compiled class, initialized state, synchronized retained history, exact
nonzero finalized number/hash and shared age/skew limits. Missing history and
root or deployment uncertainty are unsigned refusals. Its audit event is
deliberately limited to method, outcome and typed reason so recipient/root
associations and descriptor or witness material do not enter logs.

| Lever | Direction | Timing |
| --- | --- | --- |
| `pause` / `unpause` | Stop everything | Immediate |
| `update_recipient` | Add, revoke or substitute one payee | Immediate |
| `propose_limits` + `apply_limits` | Change caps | 24h |

`pause` is the response to a compromised signing key: it is checked in
`check_spending_public`, so it stops a transaction however far through proving
it already is. A timelock on it would hand an attacker exactly the notice
period they need.

`pause` is checked only in `check_spending_public`, never in the private
entrypoint, so a compromised signing key can still submit against a paused
account and burn its fee juice on each public revert.

`update_recipient` is untimelocked, and that is a change from the array design,
where additions waited 24h and removals were immediate. Under a Merkle
allowlist the contract cannot tell the two apart: leaves are commitments, so
adding, revoking and substituting are one operation on one leaf, and that
indistinguishability is the privacy property, though repeated updates at one
position erode it for observers (see "What is public"). One policy therefore
has to cover all three. The timelock is the half that had to go, because the
notice it gave was legible only when the allowlist was public, while
revocation latency is a cost that lands during an incident.

### An attacker holding the admin key

This is **not** recoverable on chain, and the 24h notice was never the defence
it looked like. The owner's only way to move funds is a transfer to an
allowlisted recipient, and the admin can stop that immediately with `pause`,
which no other key can undo. The admin is fixed at construction with no
rotation, so a compromised admin can close any escape window before a notice
period could elapse, and keep it closed for good.

What the admin key alone buys an attacker is a **freeze**, plus rewrites of any
allowlist position whose path has already been published:

| Attacker holds | Can do | Cannot do |
| --- | --- | --- |
| Admin key only | Pause indefinitely (freeze, ransom). Propose limits, which take effect after 24h. Rewrite any position touched by a published `update_recipient`, and that position's sibling (`index ^ 1`) | Change a position that is neither touched by a published update nor the sibling (`index ^ 1`) of one. Spend |
| Admin key + signing key | Once any update is published: write `h(attacker, salt)` with a self-chosen salt into such a position and drain to it, within whatever limits are live. Seed not needed | Exceed the per-tx cap or daily window before a `propose_limits` matures |
| Admin key + seed and recipient list | Add, revoke or substitute payees at any position | Spend without the signing key |

`update_recipient` in the account contract is public, so every call publishes
`index`, `old_leaf`, `new_leaf` and the full sibling path. `apply_leaf_update`
checks only that the path verifies against the current root. Position `index`
is rewritable with the published path and `new_leaf` as the old leaf, and
position `index ^ 1` with leaf `sibling_path[0]` and path
`[new_leaf, sibling_path[1..]]`. Later updates are public too, so the current
path of any position ever touched, and of its sibling, stays computable from
the update history: a later update does not close the window. The exposure is
permanent and grows with each update; only making `update_recipient` private
(#32) stops it. The entrypoint's `leaf_salt`, `leaf_index` and `sibling_path`
are unsigned, so a leaf the attacker built with their own salt is spendable by
the signing key.

Practically: admin key custody is the control against a freeze, and against
allowlist rewrites once any update has been published. The seed must still be
archived and protected separately from the admin key; see "Losing the
allowlist" below. The signing secret and the admin key must never share a host,
an IAM principal, or an operator session: together they can drain to an
attacker-built leaf within the live limits, with no seed required. Making
`update_recipient` private is tracked in #32. A design that keeps an emergency pause without giving a single key a permanent freeze is
tracked in #27.

## Incident runbook

Commands are in `README.md` under "Account administration". Every admin
command except `status` needs `SPENDING_LIMIT_ADMIN_KEY`.

Prerequisite: the admin account is deployed and funded, and stays funded. It
pays for `pause` from its own fee juice; an admin that cannot cover the
declared fee limit cannot pause. Monitor it with `--min-fee-juice`.

### Signing key compromised

1. `npm run admin -- pause`. Every transfer included after it reverts.
2. Stop the bridge.
3. `npm run admin -- status` and confirm `paused: true`.
4. Switch cron to `status --expect-paused`, so an unpause alerts.

The signing key is set once at construction, so the account keeps it. `unpause`
re-enables whoever holds it, within the on-chain limits and allowlist.

### Admin key compromised

`pause` does not help here: the attacker holds the same key and can `unpause`,
or pause the account themselves to hold it hostage. Nothing on chain outranks
the admin, and the admin key cannot be rotated.

1. Stop the bridge, so it signs nothing against an allowlist the attacker may
   be rewriting.
2. Consider moving the balance out while it can still move: one
   `aztec_createNote` to a recipient you control and know is allowlisted,
   with the bridge brought back up for that call only, before the attacker
   pauses the account or rewrites that position. Run
   `npm run admin -- status --expect-root <root>` first: if the root has
   changed, the bridge refuses to send and the transfer would revert anyway.
3. Escalate. There is no on-chain recovery path for this account (see
   "An attacker holding the admin key" above and the recovery work tracked in
   issues #27 and #32); treat the account as lost once funds are out or frozen.

### Monitoring

Run `npm run admin -- status --min-fee-juice <n>` from cron and alert on any
non-zero exit. It needs no key. Give it the expected root, as `--expect-root`
or by setting `PXE_BRIDGE_ALLOWLIST_SEED` and `PXE_BRIDGE_ALLOWLIST_RECIPIENTS`;
without one, the immediate `update_recipient` goes unseen. `--expect-root`
keeps the seed off the monitoring host. The exit code is a bitmask:

- `2`: pause state is not the expected one. Paused outside an incident, or
  unpaused under `--expect-paused`: an attacker holding the admin key undoing
  an incident pause.
- `4`: a limit proposal is pending. If the operator did not make it, the admin
  key is compromised; see "Admin key compromised". `cancel-limits` withdraws
  it, and an attacker holding the key can propose again.
- `8`: `allowlist_root` is not the expected root. `update_recipient` is
  immediate, so this is the only notice of an allowlist rewrite. Unless the
  operator just ran `update-allowlist`, the admin key is compromised; see
  "Admin key compromised". If an `update-allowlist` run stopped before its
  receipt, this bit is how to tell whether it landed.
- `16`: admin fee juice is below `--min-fee-juice`. Top it up before it is
  needed for `pause`.
- `1`: the account could not be read, or its class ID is not the artifact's.
  Treat as unmonitored.
- `>= 128`: interrupted by a signal (129 SIGHUP, 130 SIGINT, 143 SIGTERM), not
  bits. Treat as unmonitored.

A proposal sits 24h before `apply-limits` can take it, and that window is the
notice `status` exists to read. `pause`, `unpause` and `update_recipient` give
none: `status` sees them only after inclusion, at the next run.

`status` reads public storage from one node without a public-data witness. A
compromised or lying node can report a clean account. Run it against a node
you operate, over https, independent of the bridge's.

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

- Recipient allowlist: enforced, but `check_spending_public` receives neither
  the recipient nor the set. (The transaction is not recipient-blind: a
  transfer to a recipient the bridge has no landed handshake with publishes a
  recipient-keyed handshake tag; see "What is public".) Membership is proven in
  private against a Merkle root, and public asserts only that the proven root
  equals the stored one. That
  equality is evaluated at inclusion time, which is what lets a revocation
  invalidate an already-proven transfer. A zero recipient is rejected at both
  the circuit (`Recipient must not be zero`) and the RPC validation layer
  (`src/types.ts`).
- Third-party authwit: disabled (`verify_private_authwit` returns invalid), so
  the authwit side channel can no longer bypass the spending checks.
- Per-tx and daily volume caps: enforced against the bound (actual) amount.
  The daily cap is a sliding window of 25 hourly buckets, sized so that
  `(N-1)*W >= 86400` holds exactly and two full-limit spends can never fit
  inside 24 hours.

### Validation

The binding depends on the `AppPayload` serialized layout (`[FunctionCall; 5]`
+ `tx_nonce` = 31 fields, each call serialized in declaration order). The
contract side is pinned to aztec-nr v6.0.0 (`aztec-labs-eng/aztec-nr`); the
client side is encoded by `@aztec-labs/entrypoints` 6.0.0. Both sides still
agree on the layout: aztec-nr's `authwit/entrypoint/` is unchanged from v5.1.0,
which NM-1019 reviewed against, and the SDK's `encoding.ts` differs from 5.2.0
only in import paths. It is validated three ways:

- `aztec-nargo test` unit tests in `contracts/spending_limit_account/src/main.nr`:
  `function_call_serialize_layout` asserts `args_hash`/`target_address` sit at
  the offsets the guard reads; `mismatched_transfer_reverts`,
  `hidden_second_call_reverts`, and `empty_payload_reverts` prove the guard
  rejects a declared/actual mismatch, a hidden second call, and an empty
  payload; `stale_witness_is_rejected` and `update_with_a_forged_old_leaf_is_rejected`
  cover the allowlist binding and the single-leaf constraint on admin updates;
  `leaf_and_node_hashes_match_typescript` and
  `sibling_path_orientation_matches_typescript` pin the hashes and the path
  orientation against `tests/allowlist-tree.test.ts`, and
  `signed_hash_matches_typescript` pins the signed hash against
  `tests/spending-limit-account.test.ts`. The `contract` CI job runs these
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

Barretenberg SIGILLs under amd64 emulation on Apple Silicon, which is what the
old `linux/amd64` pin in `docker-compose.yml` ran. Compose now pins no platform,
so the sandbox runs the native arm64 image there (xochi-fi/xochi#513), and
`aztec compile` (`HARDWARE_CONCURRENCY=1`) runs natively on arm64 too. CI on
x86 remains the build of record for the artifact and `CLASS_ID`.

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

The entrypoint asserts `fee_payment_method == PREEXISTING_FEE_JUICE`
and then calls `set_as_fee_payer()` and `end_setup()` unconditionally. The byte
is not in the signed hash, so before the assert whoever built the request chose
whether `end_setup()` ran, and any other value left the transfer and the
`check_spending_public` enqueue in the non-revertible setup phase. Every path
the Aztec SDK v5.1.0 takes through this entrypoint already encodes
`PREEXISTING_FEE_JUICE` (sends and their simulations name no fee payer, so
`completeFeeOptions` picks it), and the other two values only arise alongside a
merged fee call that the single-call guard rejects, so the assert removes no
working path.

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

The deployment is paid differently. `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM` is a
claim bridged to the deployer, the plain Schnorr account at the account salt
plus one that sends the spending-limit account's deployment. The deployer
self-deploys with `FeeJuicePaymentMethodWithClaim`, the path a plain account
already uses, and then sends the account's deployment with no payment method,
so `completeFeeOptions` gives it `PREEXISTING_FEE_JUICE` and it pays from the
balance its claim created. The sender is the fee payer, so none of the three
failures above applies, and nothing runs through the spending-limit account's
entrypoint. The deployer is derived from the bridge's own key, so this adds no
key material and no trusted party; a deployer key compromise is a bridge key
compromise already. What it holds afterwards is unspent fee juice, which cannot
be transferred but can pay for top-up claims. Without a deployer claim or a
deployer balance, both deployments fall back to SponsoredFPC, a testing
contract present only on sandbox and testnet. That fallback (also taken by an
undeployed plain account with no `FEE_JUICE_CLAIM`) is refused under
`NODE_ENV=production` unless `PXE_BRIDGE_ALLOW_SPONSORED_FPC=true`, and with
`false` in any environment; the refusal names the account and stops startup
before anything is sent. Any other value of the variable (including an empty
one) is rejected at startup. Production runbook:

1. Start the bridge once with the spending-limit configuration and no claim.
   It logs `Deployer address` and `Account address`, then stops at the
   SponsoredFPC refusal before sending anything. Neither address is secret.
2. `npm run bridge-fee-juice -- --deployer --recipient <Deployer address>`
   bridges to it and prints the claim and its message hash. No bridge key is
   involved: the L1 deposit needs only the address, and the message commits to
   it, so the claim cannot pay for anything else. If the wait times out,
   `--wait <messageHash>` resumes it; rerunning the bridge step deposits twice.
   The claim secret is written to an owner-only file in the working directory
   before the L1 write, so a run that dies after broadcasting is recovered
   with `--recover <file>`, not rerun. Once the deposit lands the claim is
   added to the file, which is deleted only after the message has synced.
   Anyone who reads it before the claim is consumed can consume it, though
   only to credit the deployer.
3. Start the bridge with the claim. It deploys the deployer, then the account,
   and reaches `Ready` with SponsoredFPC refused. If the deployer is already
   deployed and its balance cannot cover the account deploy, bridge a fresh
   claim to the deployer (step 2) and restart with it.
4. Top up the spending-limit account before its first transfer with
   `npm run top-up-fee-juice`, paid by a separate payer (`FEE_JUICE_PAYER_KEY`)
   bootstrapped as a plain Schnorr bridge with its own `FEE_JUICE_CLAIM`. That
   key can pay fees and nothing else on the bridge's behalf. Paying from the
   deployer instead (`FEE_JUICE_PAYER_DEPLOYER=true`) is refused under
   `NODE_ENV=production`: the deployer's key is the bridge's signing key, and
   using it would copy the key that authorizes every transfer onto the
   operator's machine. Outside production it is allowed; the wallet stores
   holding it are created under `os.tmpdir()` and deleted on exit, SIGINT,
   SIGTERM and SIGHUP, and SIGKILL or a crash leaves them.

## What is public

The contract enforces its limits against public state, and a public function's
arguments are part of the transaction. Every transfer therefore publishes:

- **The amount.** `declared_amount` is an argument to `check_spending_public`,
  `amount` is an argument to the token's public finalize call, and the
  completed note's value is emitted in a public log.
- **The sender.** `from` is an argument to the token's public finalize call.
- **The token.** Pinned at construction and visible as the call target.
- **The allowlist root**, and the fact that a transfer proved membership against
  it. The contract's public calls carry neither the recipient nor the set.
- **A recipient-keyed handshake tag**, on the first transfer to each recipient
  and any proven before that one lands, in either account mode. See below.

This is inherent to checking a value against public storage and is not
remediated for the amount. Enforcing that privately would mean nullifier-based
counters and a different contract. Switching accounts does not help: no mode of
this bridge is amount-private. At Aztec 6.0.0 the token's `transfer_to_private`
enqueues the public `_finalize_transfer_to_private_unsafe(from, amount,
partial_note)`, which calls `_finalize_transfer_to_private`, regardless of
account
([`token_contract/src/main.nr:324-335, 402-425`](https://github.com/aztec-labs-eng/aztec-node/blob/v6.0.0/noir-projects/noir-contracts/contracts/app/token_contract/src/main.nr#L324-L425)).
Completing the partial note emits `[storage_slot, value]` in a public log
([`uint_note.nr:211-212`](https://github.com/aztec-labs-eng/aztec-node/blob/v6.0.0/noir-projects/aztec-nr/uint-note/src/uint_note.nr#L211-L212)).
So the amount and the sender are on the transcript under a plain Schnorr
account too. Only a private-to-private `transfer` from private inventory, which
this bridge does not implement, keeps the amount off it.

The recipient's address is placed in no public call in either mode, but that is
not recipient privacy. Whether the recipient stays off the transcript depends on
how the note is delivered. The partial note is sent to the recipient with
`MessageDelivery::onchain_unconstrained()`
([`uint_note.nr:123-129`](https://github.com/aztec-labs-eng/aztec-node/blob/v6.0.0/noir-projects/aztec-nr/uint-note/src/uint_note.nr#L123-L129)),
and when the sender's PXE finds no handshake note for the pair, aztec-nr asks
the wallet's `resolveTaggingSecretStrategy` hook for a tagging strategy
([`tag.nr:37-56`](https://github.com/aztec-labs-eng/aztec-node/blob/v6.0.0/noir-projects/aztec-nr/aztec/src/messages/delivery/tag.nr#L37-L56)).
Without a hook PXE uses `non-interactive-handshake`, which "reveals the
recipient onchain"
([`resolve_tagging_secret_strategy.ts:9-17, 42-43`](https://github.com/aztec-labs-eng/aztec-node/blob/v6.0.0/yarn-project/pxe/src/hooks/resolve_tagging_secret_strategy.ts#L9-L43)).
This bridge's `EmbeddedWallet` is created with no hooks
([`src/aztec-client.ts`](src/aztec-client.ts)), so every transfer proven while
the bridge account has no landed handshake with the recipient (the first to
each recipient, plus any proven before that one lands, since the lookup reads
committed state only:
[`handshake.nr:115-124`](https://github.com/aztec-labs-eng/aztec-node/blob/v6.0.0/noir-projects/aztec-nr/aztec/src/messages/delivery/handshake.nr#L115-L124))
calls the HandshakeRegistry's `non_interactive_handshake`, which publishes a
log tagged by a fixed hash of the recipient's address
([`handshake_registry_contract/src/main.nr:75-94`](https://github.com/aztec-labs-eng/aztec-node/blob/v6.0.0/noir-projects/noir-contracts/contracts/standard/handshake_registry_contract/src/main.nr#L75-L94)).
The address is not in clear, but anyone holding a candidate address can confirm
that the bridge account, named as `from` in the same transaction, paid it, and
the number of distinct tags counts the recipients paid. The tag is visible once
the transaction is broadcast, whether or not it lands. Later transfers reuse
the handshake and are not linkable to the recipient. Recipient privacy is
**not** delivered today. The
`interactive-handshake` strategy reveals nothing about the recipient onchain but
needs the recipient to answer the handshake registry's request. The allowlist
design below keeps the recipient out of the bridge's own public calls only.

The recipient is a different story since NM-1019 [Medium]. The array design
published a candidate set of up to eight addresses per transfer, and the set was
public anyway because the admin's add and remove calls carried each address in
the clear. Both are gone. The allowlist is now a Merkle tree whose leaves are
commitments `h(recipient, salt)` under a secret seed; the chain holds one root,
membership is proven in private, and `update_recipient` moves one opaque leaf to
another.

What an observer learns from an admin update is every argument of the public
`update_recipient` call: `index`, `old_leaf`, `new_leaf` and the full sibling
path. Positions are therefore assigned randomly rather than filled left to
right, or the first touch of position `k` would be visibly an addition. The
leaves are opaque commitments, so the observer does not learn which address
occupies a position. Empty positions hold `h(0, salt_i)` with that position's
own salt, so a never-touched position is not recognisable as empty and the
canonical empty-subtree roots never appear in a sibling path.

That opacity does not survive repeated updates at one position. Salts are fixed
per position, and both addition and revocation pass through the same empty leaf
`h(0, salt_i)`. After two updates at a position the observer has seen that
leaf, so every later update there classifies as an addition or a revocation,
and the position's occupancy is known. Re-adding a recipient at the same
position republishes its old leaf, linking the two periods. The published path
also lets the admin key rewrite that position and its sibling (`index ^ 1`)
without the seed; see "An attacker holding the admin key". Tracked in #32.

Anonymity is still bounded by how many recipients are actually allowlisted. A
tree removes the mechanism's ceiling; it does not supply recipients. Run with
three and the set is three. The tree keeps the number allowlisted off chain,
but not the number paid: each paid recipient has a distinct handshake tag on
chain (see above), so how many recipients the bridge has paid is public, and
each one is confirmable by anyone holding its address.

## Losing the allowlist

The account stores only a root. Unlike the public array it replaces, **the set
cannot be recovered from the chain.** Losing either the seed
(`PXE_BRIDGE_ALLOWLIST_SEED`) or the list of `(address, position)` pairs is
terminal for allowlist management: no witness can be built, so no transfer can
be sent, and no `update_recipient` can be constructed for a position whose path
has never been published. Positions whose path is on chain stay rewritable by
the admin key alone, which is the same exposure described in "An attacker
holding the admin key", not a recovery path.

Archive both with the same discipline as the contract artifact, together with
the deployment record (`PXE_BRIDGE_ACCOUNT_DEPLOYMENT`). This account already
has permanent-brick modes -- `permitted_token` has no setter, and a zero admin
is unrecoverable -- and this is one more.

The seed is a secret, but a weaker one than the signing key: holding it lets
someone test a candidate address against a leaf, which costs membership
privacy for allowlisted recipients the bridge has not yet paid, and which
position each occupies, not custody. Paid recipients are confirmable from their
handshake tags without it; see [What is public](#what-is-public). It is warned
about rather than refused when read from the environment in production.

The bridge checks its copy against the chain before every send, via
`get_allowlist_root`, and refuses to send on a mismatch. That check is what makes
a secret set monitorable: the root commits to exactly the set that produces it,
so an operator can verify a published set against the chain and a compromised
admin cannot publish one set while committing another.

## The account address is pinned by a deployment record

The account's address derives from its constructor arguments, and those include
the per-tx cap, the daily limit and the allowlist root. All three are meant to
change after deployment: `update_recipient` moves the root, `apply_limits`
moves the caps. The bridge used to rebuild the constructor arguments from live
configuration on every start, so following the runbook after an allowlist
update (set the new recipients, restart) derived a different address. Nothing
was deployed there, so the bridge deployed a fresh, empty account, logged
"Ready", and left the funded one orphaned.

The constructor arguments now come from `PXE_BRIDGE_ACCOUNT_DEPLOYMENT`, a
record of what the account was deployed with and the address that produced.
Live configuration keeps its other jobs: recipients and seed build the witness
tree, which is checked against the chain's current root before every send, and
the limit variables drive `src/limits.ts`. With a record set the bridge never
deploys, and it refuses to start when the record does not reproduce its own
address, when nothing is initialized at that address, or when the configured
admin or token differ from it. Each of those is a configuration for some other
account, and the safe response to that is to stop.

A first deployment has no record, and has to derive from live configuration.
Production refuses to do that unless `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1` is
set, so a lost or unset record fails startup instead of quietly deploying a new
account. Outside production the bridge deploys and prints the record on every
start that lacks one. The trade is one more value to archive, and one more
operator step on the first deployment.

## Transaction cancellation is not supported

The entrypoint used to push a nullifier derived from the payload's `tx_nonce`
when its `cancellable` flag was set, which is the mechanism a wallet would use to
replace a pending transaction. This account offered no way to use it, and
NM-1019 [Low] records that: the only path through the entrypoint is a real
transfer, so cancelling means sending another one, which costs an allowlisted
recipient, unspent per-tx cap and room in the daily window. There are reachable
states with none of those, and they are exactly the states where cancelling
matters.

The branch is now deleted. It was previously accepted rather than fixed on the
grounds that it could not be entered: `cancellable` arrives from
`BaseWallet.cancellableTransactions`, which is `protected`, initialised `false`,
and has no setter anywhere in the SDK, and the bridge does not subclass the
wallet. That reasoning held for today's SDK and not for tomorrow's. The finding
named its own trigger, a later SDK making cancellation the default, at which
point the account would have begun advertising a cancellation it cannot honour.
Deleting the branch fails safe against that: the account offers no cancellation
rather than one it cannot deliver.

The alternative was NM-1019's own recommendation, branching on zero non-empty
calls so a cancellation carries no transfer. That was not taken. It skips
`assert_declared_matches_transfer`, the zero-recipient assert, the membership
proof and the `check_spending_public` enqueue together, so it is a second shape
through the entrypoint on which the fee branch still runs, and a compromised
signing key could burn fee juice on empty cancellations. Operationally the bridge
does not want the feature either: it submits and reconciles through the
idempotency store rather than leaving a transaction pending for someone to
withdraw.

The `cancellable` ABI parameter remains, read and ignored. Entrypoint arguments
are encoded positionally, so removing it would shift every argument after it.

## Build supply chain

The `contract` CI job downloads `aztec-up` from the pinned release's directory
(`https://install.aztec-labs.com/6.0.0/aztec-up`; `install.aztec.network` now
301s to `install.aztec-labs.com`) and runs `aztec-up install 6.0.0`, which
fetches and runs that release's per-version installer. There is no published
checksum to pin against, so the build trusts that endpoint. The npm tree comes
from the release's own lock (`packages.tar.gz`, installed with `npm ci`), but
the installer scripts, that lock and the Noir and Foundry binaries are fetched
at run time, so `aztec-up install 6.0.0` pins the toolchain version but not
what the endpoint serves for it. The job no longer runs the root installer,
which first installs the latest release with an unlocked `npm install` and
failed on 2026-10-30 when it resolved a tslib version published 27 seconds
earlier.

That toolchain is the contract's compile toolchain only, and it is pinned
separately from the runtime (SDK, PXE, sandbox) because the class ID, and with
it the account address, derives from the compiled bytecode. Until
xochi-fi/pxe-bridge#55 the contract was compiled by aztec 5.1.0 against aztec-nr
v5.1.0, the bytecode NM-1019 audited, under a 5.2.0 runtime. For the testnet
tracer both are now 6.0.0 (aztec-nr v6.0.0 from `aztec-labs-eng/aztec-nr`).
`main.nr` and `public_key_note.nr` did not change, but the bytecode did, since
the aztec-nr library and the noir compiler it is built with changed; see
"6.0.0 artifact of record" below. The committed `CLASS_ID` is checked against
the 6.0.0-compiled artifact as loaded by the 6.0.0 SDK.

**This has already bitten, benignly.** On 2026-08-26 every `contract` job began
failing at install with `expected bundled binary 'forge' missing from
~/.aztec/versions/5.1.0/internal-bin`. The commit that passed on 19 Aug fails the
same way on re-run, from the same pinned version, because the installer changed
underneath it. `forge` is Foundry and this job compiles a Noir contract, so the
job now records the installer's exit code and checks for `aztec` and
`aztec-nargo` rather than trusting its verdict. A missing binary this job
actually uses still fails.

The underlying exposure is unchanged: a compromised or merely updated installer
can still change what gets built. The class ID pin is the control, and it is
downstream of this, which is the right order.

The artifact it produces is not committed, so the mitigation is downstream:
`scripts/contract-class-id.js` compares the resulting contract class ID against
`contracts/spending_limit_account/CLASS_ID` and fails the job on drift. A
compromised or merely updated toolchain changes that ID, and the account address
derives from it.

### `aztec compile` was not reproducible

Introducing that check immediately found it. Identical sources and toolchain
(aztec 5.1.0, noir `1.0.0-beta.22+c57152f9`) occasionally produced a different
class ID, a different one each time: `0x2ff3ed37...` (run 32048928421) against
`0x0df61951...`, then `0x14bf25bb...` (37231706545) and `0x0ddebed6...`
(37251698866) against `0x049106c3...`. Re-running passed.

The two drifted artifacts still downloadable differ from a good one in exactly
one field, the constructor's `verification_key`. Bytecode, artifact hash and
public bytecode commitment are identical. The VK hash is a leaf of the private
functions root, which is an input to the class ID. The drifted VKs keep the
circuit size and change 26 of 40 commitments, `lagrange_last` among them, so bb
built a different circuit from the same bytecode.

Cause: `bb aztec_process`, which `aztec compile` runs after nargo, derives every
private function's VK at once, one thread each, in one process. bb 5.1.0 is not
thread-safe there: `cycle_group` reads offset generators from the
process-global `generator_data::default_data`, whose `get()` mutates a
`std::map` unlocked. Reproduced locally (arm64) at `HARDWARE_CONCURRENCY=4`: of
750 runs, 12 produced a wrong constructor VK and 196 aborted, 113 of the 119
captured in `cycle_group` ("Point is not on curve"). The constructor alone at 4
threads: 300 of 300 correct, so parallelism within one derivation is not it.
All three at `HARDWARE_CONCURRENCY=1`: 300 of 300 correct.

The `contract` job sets `HARDWARE_CONCURRENCY=1` for `aztec compile`. Any other
build of the artifact needs the same. bb caches each VK under
`~/.bb/<version>/vk_cache` keyed on bytecode alone, so a build that hit the race
keeps serving the wrong VK on that machine until the entry is deleted.

The artifact a deployment was made against should still be archived rather than
regenerated: the installer exposure above can change the build regardless. The
CI job uploads it on every run, before the class ID check, so a drifted build is
preserved for comparison.

### 6.0.0 artifact of record

**Status: arm64, pending x86 CI confirmation.**

Recompiled for the testnet tracer (xochi-fi/pxe-bridge#55) after the
fee-payment pin (xochi-fi/pxe-bridge#44) changed `main.nr`; `public_key_note.nr`
is unchanged. aztec 6.0.0 / noir
`1.0.0-rc.3+5a7ee9bf5ed8973076df7bb0d2b723024db09ae7`, aztec-nr `v6.0.0`
(`aztec-labs-eng/aztec-nr`, tag object `46d118ff`, commit `04720122`):

| | |
|---|---|
| contract class id (`CLASS_ID`) | `0x0bbe87edad6b55ba6a0a8baa982c6b52a48b817a630fe28c7ca1ac6b2d8b0009` |
| artifact hash | `0x23175c2477ef7185293e060b672df9bb97be41037400af95a7e3114e3e36b197` |
| private functions root | `0x01d57d9fd9ad35dceaa51b65ce8345b4535c8488233a2c9fec23e04dde34a76f` |
| public bytecode commitment | `0x274f0b212e6dedb4ef9e46a8bea713a6900fc145ff72388c781b4894adb62340` |
| artifact digest (`ARTIFACT_SHA256`, `scripts/artifact-digest.js`) | `38ca99d673e5cf4c81fae00f942dd51a33ff3a78b9983ce0d7b7f42ef1d135f8` |
| raw file sha256 (arm64 build at `/tmp/pxe-bridge-6`, path-dependent) | `6cc1287c1338d7bf393cfa7b77cc4c64912bcc6a2b71ebaa2d9f2bd7f5784c1a` |

The public bytecode commitment is the pre-#44 value: #44 changed only the
private entrypoint, so only the private functions root, and with it the class
id, moved. The pre-#44 6.0.0 build pinned class id
`0x0d41b7399377b559a969acf04429432b81ac1efda31b0f6a713b5550e27a063a` and digest
`7ecfad1190cd2bbdd40e6e020d982ccbcaca119ba2c17e4444bc7e2faae922f7`. A
spending-limit account deployed against that class derives elsewhere under this
one, and a bridge with `PXE_BRIDGE_ACCOUNT_ADDRESS` recorded refuses to start.

`ARTIFACT_SHA256` pins the whole file, ABI, storage layout and metadata
included, which the class ID does not cover. It is a sha256 with each
`file_map` path cut to the part below the checkout or the nargo cache, because
`file_map` records absolute build paths: the raw file hash moves with the
runner's checkout directory and `$HOME` even when nothing else does. The CI
`contract` job checks it after the class ID, before anything is published.

These values come from a native arm64 build (macOS, 2026-10-25). It was
byte-identical at `HARDWARE_CONCURRENCY=1` and at 8 threads with an emptied
`vk_cache`, as the pre-#44 build was, so bb 6.0.0 did not show the 5.1.0 VK
race here. That is two samples, so CI keeps `HARDWARE_CONCURRENCY=1`.

An x86 build of the pre-#44 sources was attempted the same day in a
`linux/amd64` container (`node:24.15.0-bookworm`, the CI installer,
`aztec-up install 6.0.0`, `HARDWARE_CONCURRENCY=1 aztec compile`). The nargo
stage completed and its output had the same normalised digest as the arm64
nargo stage (`64f42aa295c5c57706b9090cd6179102d92956593d9584119a71a65c9347df0f`),
so the compiled bytecode, ABI and layout agreed across architectures. The bb
postprocess (transpile and verification keys) then failed in a child process
and left the artifact untranspiled. The emulated CPU reports no AVX2, which is
consistent with the barretenberg-under-emulation limitation recorded above;
the exact error was not captured. That comparison was not repeated for the
post-#44 sources, so no x86 value, pre- or post-bb, is observed for them. The
x86 `contract` job remains the build of record: `CLASS_ID` and
`ARTIFACT_SHA256` hold the arm64 values, and the first x86 run either confirms
both or fails naming the computed ones, which then replace them (and
`TIMELOCK_CHECKED_AT_CLASS_ID` in `tests/spending-limit-admin.test.ts`, which
follows `CLASS_ID`). The artifact a deployment is made against is the one that
run uploads.

## Account address pinning

An Aztec address commits to the account contract's class as well as to its key
and salt, so an SDK upgrade that ships a different stock `SchnorrAccount`
artifact moves every plain Schnorr address this repo derives even though no key
changed: the bridge's own account (when `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` is
unset), the spending-limit deployer (`ensureDeployer`), the fee juice payer
(`scripts/top-up-fee-juice.ts`), and the spending-limit admin as
`scripts/update-allowlist.ts` derives it. Aztec 5.2.0 did this: the class moved
from `0x0191cefaf68870dd09c29d402946976c9def479ee7f343061b6574fa401af98d`
(5.1.0) to `0x0833459dfb3c430326e50f2367ec093e07b4ed37d23e85cc759ef4f9aa800edd`
(5.2.0). 6.0.0 did it again, to
`0x2f7d07db78643da21eefb63ee07d28d1cc23dd86ec9b3a9fa29323bf17269d15`. 6.0.0
also changed the address derivation itself (`DOM_SEP__CONTRACT_ADDRESS_V2` to
`_V3`), so under 6.0.0 every address moves whatever its class. No bridge had
been deployed on a 5.1.0 runtime when 5.2.0 landed; the testnet tracer's bridge
is first deployed on 6.0.0, so it has no older deployment to strand.

A moved address is a new, empty account. Balances at the old one are out of
reach (fee juice cannot be transferred at all), and the spending-limit `admin`
is a `PublicImmutable` with no rotation path, so an admin that moved can no
longer `pause`, `unpause`, `update_recipient` or change limits. The
spending-limit account moves only when its pinned `CLASS_ID`, its constructor
inputs or the protocol's address derivation change; it is deployed with a zero
deployer. Under 6.0.0 the first and last both changed. Before an SDK upgrade
that moves either on a live deployment, empty the plain Schnorr accounts and,
for a spending-limit account, move its balance to an allowlisted address,
pause it and redeploy with an admin the new runtime derives.

### What refuses

A moved address cannot be avoided by derivation, so it is made loud. The
call sites below check the derived account against a recorded or on-chain
address before acting, and refuse with both addresses and the class in the
message (`src/account-identity.ts`). Two derivations are not checked: the
spending-limit deployer (`ensureDeployer` in `src/aztec-client.ts`, the same
key under salt + 1) and `scripts/test-deploy.ts`, which constructs
`AztecClient` without `expectedAccountAddress`.

- **The bridge** (`connect()`) refuses an account that derives away from
  `PXE_BRIDGE_ACCOUNT_ADDRESS` before it deploys, serves or sets a sending
  address. In production `PXE_BRIDGE_ACCOUNT_ADDRESS` is required (in
  spending-limit mode the deployment record's `address` satisfies it); the only way
  to start without it is `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1`, named for the
  first deployment, which cannot know its address in advance. An upgraded
  deployment that sets nothing therefore stops at startup instead of deploying
  a fresh account. Setting the flag on an upgraded deployment is consent to a
  new account; it is not a way past the check when an address is recorded.
- **`update-allowlist.ts`** and **`admin.ts`** read the admin stored in the
  account (the contract has no getter, so `readAccountState` reads the `admin`
  slot from public storage, after checking the instance runs the pinned class)
  and refuse, through `assertAccountIdentity`, a key that derives to anyone
  else, before sending.
- **`top-up-fee-juice.ts`** requires `FEE_JUICE_PAYER_ADDRESS` with
  `FEE_JUICE_PAYER_KEY` (and checks it for the deployer payer when set) and
  refuses a payer key that derives elsewhere, before the L1 write.
- **`bridge-fee-juice.ts`**, bridging to the bridge account (no `--deployer`),
  requires `PXE_BRIDGE_ACCOUNT_ADDRESS` and refuses a recipient that differs
  from it: a `--recipient` that is not the recorded address, or a key-mode
  address that derives elsewhere. The L1 message commits to the recipient, so
  this runs before anything is bridged. The only way to run it without the
  address is `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1`, for a first deployment; it
  then logs the address it bridges to. `--deployer` bridges to the
  spending-limit deployer, which has no recorded address and is not checked.
  `--admin` bridges to the spending-limit admin and refuses a `--recipient`
  other than `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` (required with it).

In spending-limit mode the bridge's address also moves when the constructor
inputs do (limits, admin, token, allowlist root). The deployment record
(`PXE_BRIDGE_ACCOUNT_DEPLOYMENT`, "The account address is pinned by a deployment record" above) fixes the inputs, so with it set a
restart after `update-allowlist` or new limits keeps the address. The two
compose, and each fails closed on its own: the record's `address` satisfies the
production requirement for `PXE_BRIDGE_ACCOUNT_ADDRESS`, a separately set
`PXE_BRIDGE_ACCOUNT_ADDRESS` must equal it (`index.ts` refuses a disagreement
before connecting, naming both), `connect()` checks the derived address against
both, and `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY` keeps one meaning in both. Without
the record, a recorded address still refuses a restart on moved inputs rather
than deploying an empty account.

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

The circuit breaker trips when committed volume drains the daily cap, not when a
single request would overshoot it. Drained means committed volume reaches the
cap, or leaves less than 1% of it and less than the request needs. The second
case exists because admission never lets committed volume exceed the cap, so a
drain in amounts that do not divide it stops short (4999 of 5000) and the
breaker never fired. The cost is that a residual under 1% of the cap is lost
for the window once it trips. Above that residual, a request larger than the
remaining budget is rejected on its own; tripping there meant one oversized
request, needing no prior volume when `PXE_BRIDGE_MAX_AMOUNT` was unset, stopped
the bridge for a full window, and a busy legitimate day at 80% of the cap would
pause over one transfer too large for what was left.
In-flight reservations count toward the remaining budget but not toward the
trip: a reservation that releases moved no tokens. Not nothing, since a send
that reverts on chain still burns its fee, but the daily limit counts token
volume and not fees.

`POST /admin/resume` clears the latch and not the window, so it answers with the
numbers that decide whether the next request re-trips:

- `committed`: committed volume in the window, the breaker's input.
- `reserved`: in-flight volume, counted against the budget and not the breaker.
- `dailyLimit` and `remaining` (`dailyLimit` minus both, floored at 0), present
  when `PXE_BRIDGE_DAILY_LIMIT` is set.
- `mayTripAgain`: the window is drained, or will be if every in-flight
  reservation commits. "May" because reservations can release and a drained
  window still serves a request that fits its residual.

These replace `windowTotal`, `windowReserved` and `willTripAgain`. The last was
computed from committed volume alone, so it answered false mid-drain while
in-flight sends were about to fill the window.

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
