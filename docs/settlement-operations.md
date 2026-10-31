# Settlement operation contract (`pxe-bridge.settlement.v1`)

xochi-fi/pxe-bridge#45 and #46; consumer axol-io/Riddler#1351 (tracker issue
1356). Decisions: xochi `docs/planning/shielded-execution.md` §7 "Decided
2026-10-24" (binding-revocation signal), the 2026-10-25 second set (SQLite
store, versioned payload, bridge-owned fingerprint, may-broadcast query), and
the 2026-10-27 integrator decisions D-A (single-use may-broadcast), D-B
(legacy migration) and D-C (term encodings), recorded where each applies
below. Issue #46 adds the finalized-only hard-readiness gate described under
Deployment.

## Methods

| Method | Params | Answer |
| --- | --- | --- |
| `aztec_createNote` | one object: `version: "pxe-bridge.settlement.v1"`, `operationId` (1-128 printable ASCII, MUST equal the `Idempotency-Key` header), `network` (§7 `NetworkIdentity`), `corridor {corridorId, corridorRevision, manifestDigest}`, `accountMode` (`spending_limit` \| `standard`), `recipient`, `recipientDescriptorDigest`, `token`, `amount`, `validUntil` (unix seconds). Encodings: "Frozen encodings" below. Unknown keys refused. | `result {version, operationId, fingerprint, observation}` for `pending`/`included`/`finalized`/`reverted`; otherwise a JSON-RPC error below. |
| `aztec_getSettlement` | `{version, operationId}` | `result {version, operationId, found, fingerprint?, terms?, state?, attempts?: [{attempt, txHash, expirationTimestamp, mayBroadcast}], observation, journal {writable, reason?, detail?}}`. Read-only; served while journal writes are disabled. `found: false` answers `observation {state: "unknown", reason: "operation_not_journaled"}`: absence never means "no payout". |

Send `aztec_getSettlement` to `POST /api/recovery` with Bearer
`PXE_BRIDGE_RECOVERY_API_KEY` to use the reconciliation body-intake reserve.
The dedicated route is disabled when that distinct credential is unset.
`/` and `/api/rpc` remain accepted with `PXE_BRIDGE_API_KEY`, but use ordinary
body-intake, rate-limit, and backend capacity alongside fund-moving traffic.

Legacy `{recipient, token, amount, chainId, ...}` params are refused
(`-32602`, `data.reason: "legacy_params_refused"`).

Although the frozen wire enum retains `standard` for decoding and conflict
recovery, hard readiness admits new work only when `accountMode` is
`spending_limit` and the durable deployment record is present.

## Frozen encodings (D-C)

The term encodings are `@xochi/spec`'s, not the bridge's. Every member is
named and typed exactly as the spec's `conformance/shielded.json` (0.9.0) and
Riddler's `Shielded.*` modules (`Shielded.NetworkIdentity`, `AztecField`,
`Encoding`) parse them; a value either side refuses, the other refuses too.

| Member | Encoding | Source |
| --- | --- | --- |
| `network.aztecChainId`, `network.protocolVersion` | canonical decimal string; Aztec scalar: nonzero, below the BN254 modulus r. `protocolVersion` is the numeric Aztec rollup version | §7 `NetworkIdentity` (approved 2026-10-19) |
| `network.rollupAddress` | `0x` + 40 hex, nonzero EVM address | §7 `NetworkIdentity` |
| `network.l1ChainId` | canonical decimal string, positive uint256 | §7 `NetworkIdentity` |
| `network.genesisOrNetworkDigest` | `0x` + 64 hex, nonzero. A corridor MANIFEST value, carried verbatim: neither the bridge nor Riddler derives it. The bridge refuses any value but its configured one (`network_mismatch`) | §7 `NetworkIdentity`; `PXE_BRIDGE_SETTLEMENT_CORRIDOR` |
| `network` (whole) | the §7 struct `NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address rollupAddress,uint256 l1ChainId,bytes32 genesisOrNetworkDigest)`, member for member. Its `hashStruct` is the `network_identity_digest` both shielded domain salts fold in; the canonical vector reproduces the spec's fixture-a digest from it | `shielded.json` `networkIdentity` |
| `corridor.corridorId`, `corridor.manifestDigest` | `0x` + 64 hex (bytes32) | §7 `ShieldedCorridor` |
| `corridor.corridorRevision` | JSON integer, 1..2^32-1 (uint32) | §7 `ShieldedCorridor` |
| `recipient`, `token` | `0x` + 64 hex Aztec value: nonzero, below r. A 20-byte EVM address is refused, never padded | §7 typed encodings (`AztecField`) |
| `recipientDescriptorDigest` | `0x` + 64 hex, any bytes32 (zero admitted). It IS `ShieldedDestination.descriptorDigest` / `RecipientBinding.descriptorDigest` (`recipient_descriptor_digest` on Riddler's wire), copied verbatim from the enrollment. Its preimage is Xochi's and still open in §7; the bridge never derives or interprets it | `shielded.json` `recipientBinding` |
| `amount` | canonical decimal STRING, `0 < amount <= 2^128 - 1` (a JSON number is refused) | §7 `BaseUnits` |
| `validUntil` | JSON integer, unix seconds | bridge |

Hex is accepted in either case and canonicalized to lowercase before the
fingerprint, so case never changes it.

**Corridor revision 1 values stay configuration.** Every value in
`PXE_BRIDGE_SETTLEMENT_CORRIDOR` (`corridorId`, `corridorRevision`,
`manifestDigest`, `genesisOrNetworkDigest`) is an operator decision still
open for manifest revision 1 (§7 "Still open"). Unset refuses every
createNote (`corridor_unconfigured`, and `/ready` is 503); a request naming
any other corridor is `corridor_mismatch`, another network digest
`network_mismatch`, both before anything is prepared.

### Canonical request vector

`docs/vectors/settlement-v1.json`, generated in TypeScript by
`scripts/settlement-vectors.ts` (`npm run generate:settlement-vectors`) from
the bridge's own schema and fingerprint, and checked by
`tests/settlement-vectors.test.ts` (the committed file must equal the
generator's output). The bridge is the producer: Riddler vendors the file and
checks `Settlement.AztecRpc`'s request builder against it; never compute the
expectation on the consumer side, and never hand-edit the JSON. It holds:

- the HTTP shape of one `aztec_createNote` (headers incl. `Idempotency-Key`),
  its params, the canonical terms and the fingerprint;
- `networkIdentity`: the §7 type string, typehash and the digest of the
  request's `network`, which equals `@xochi/spec` fixture-a's
  `networkIdentityDigest` (`0xf5046ae3...e968`);
- inputs that keep the fingerprint (uppercase hex, another envelope id) and
  single-change refusals (zero chain id, scalar at r, EVM-width recipient,
  JSON-number amount, unknown member, ...);
- the may-broadcast query the bridge sends for it, the one answer that marks
  and answers that hold.

Its values are the spec's `recipientBinding` "baseline" fixtures, not a real
corridor.

## Error codes

| Code | Name | Meaning | `data` |
| --- | --- | --- | --- |
| -32602 | invalid params | schema, legacy params, `Idempotency-Key != operationId` | `reason?` |
| -32001 | request_in_flight | this operation is being driven now; wait and read | `operationId, fingerprint, observation {state: "request_in_flight"}` |
| -32002 | submitted_unknown | may-broadcast was marked; outcome unknown. Never resend; read `aztec_getSettlement` | `operationId, fingerprint, txHash?, observation` |
| -32003 | operation_conflict | same `operationId`, different fingerprint; no work done | `operationId, fingerprint, storedFingerprint` |
| -32004 | journal_unavailable | journal writes disabled or unreadable; this request sent nothing | `operationId?, journal {writable: false, reason, detail}` |
| -32005 | not_submitted | provably not broadcast (refused, or held before may-broadcast) | `operationId, fingerprint, observation` (`not_submitted` or `prepared`) |
| -32006 | bridge_not_ready | authoritative hard-readiness predicate refused new admission before proving/broadcast | `reason: "bridge_not_ready", reasons, observation {state: "not_submitted", reason: <primary readiness reason>, retryableAfterRevalidation: true}, finalized?, observedAt?` |

## Observations

| `state` | Broadcast? | Fields | Consumer response |
| --- | --- | --- | --- |
| `prepared` | no (journaled, unmarked) | `txHash, expirationTimestamp, hold: may_broadcast_unknown \| may_broadcast_denied \| interrupted` | hold; retry the same operation later; never refund |
| `not_submitted` | no | `reason, retryableAfterRevalidation` | `true`: retry the same operation; `false` (e.g. `validity_bound_passed`): revalidate/requote |
| `request_in_flight` | maybe | -- | wait, then read |
| `submitted_unknown` | maybe | `txHash, expirationTimestamp, reason` (`post_mark_failure`, `response_deadline`, `node_reports_dropped_or_unknown`, `node_read_failed`, `validity_bound_passed`, `expiration_passed`) | hold and reconcile; never replay it. Absence from one node is not proof that the transaction never reached another node or an earlier fork |
| `pending` | yes | `txHash, expirationTimestamp` | wait |
| `included` | yes | `txHash, expirationTimestamp, executionResult: success, blockHash, blockNumber, receiptStatus (proposed\|checkpointed\|proven), observedAt, effects {state, noteHashes, nullifiers}` | non-terminal; wait for `finalized` |
| `finalized` | yes | as `included`, `receiptStatus: finalized` (durably recorded) | delivery evidence (never "completed" alone) |
| `reverted` | yes, reverted | as `included`, `executionResult: reverted`; terminal only at `receiptStatus: finalized` | no payout only at finalized |
| `unknown` | maybe | `reason` | hold |

Effects are uninterpreted evidence: no element is "the" recipient note.

`not_submitted` reasons include the admission refusals (`corridor_mismatch`,
`network_mismatch`, `account_mode_mismatch`, `token_mismatch`,
`network_unreadable`, `may_broadcast_unconfigured`, `corridor_unconfigured`,
`limits: ...`), `validity_bound_passed` (not retryable), `expiration_passed`
(the prepared transaction's protocol expiration passed BEFORE Riddler was
asked; retryable, a retry proves a fresh attempt), `expired_after_allow` (it
passed after Riddler answered `allow` and before the mark; NOT retryable, see
below), `prepare_failed`, and `response_deadline` (the request deadline passed
before anything was prepared; retry the same operation).

**`expired_after_allow` is terminal for the operation id.** Riddler's `allow`
durably bound that txHash (D-A). The attempt was never marked, so it provably
never broadcast, but it can never be replaced under the same operation: a
fresh proof carries a new hash, which Riddler denies for good, so retrying
would only park the operation at `may_broadcast_denied`. The remedy is a
requote under a NEW operation id; a retry of the old id answers the same
`not_submitted` and proves nothing.

**The gate is the authoritative bound check, in two steps.**

1. After Riddler's answer and before the mark, with nothing asynchronous in
   between, the gate checks the clock against BOTH `validUntil` and the
   attempt's protocol `expirationTimestamp`. An unmarked attempt past either
   is recorded `not_submitted` and never marked.
2. After the mark -- an fsync that can itself cross a second -- a separate
   SYNCHRONOUS final step (`BroadcastGate.beforeSend`) rechecks both bounds,
   and the client calls the node's `sendTx` in the same synchronous run, with
   no `await` between the check and the call. A marked attempt refused here is
   never sent and answers `submitted_unknown` (reason
   `validity_bound_passed` / `expiration_passed`), never `not_submitted`: it
   was marked.

Earlier checks (admission, resume) only save work.

## Fingerprint

Bridge-owned (not an `@xochi/spec` encoding): `0x` + SHA-256 over
`pxe-bridge/settlement-fingerprint/v1` and one `name=value` line per term in a
fixed order, hex lowercased (`src/settlement.ts`). Consumers compare it for
equality and compare the returned `terms` field by field; nobody recomputes it.
The canonical vector pins one value.

## May-broadcast query (bridge -> Riddler)

After the exact prepared transaction (bytes, hash, protocol
`expirationTimestamp`) is flushed and before the may-broadcast mark, the bridge
`POST`s `PXE_BRIDGE_MAY_BROADCAST_URL` (Riddler: `/shielded/may-broadcast`)
with `Authorization: Bearer <PXE_BRIDGE_MAY_BROADCAST_TOKEN>` (the
environment-scoped service credential Riddler holds as
`SHIELDED_MAY_BROADCAST_TOKEN`) and body
`{version: "pxe-bridge.may-broadcast.v1", operationId, fingerprint, txHash}`.

- Only **HTTP 200** with `{version, operationId (echoed), decision: "allow"}`
  marks. Any other status -- a 201/202/204 included -- is `unknown`, and so
  are `deny`, `unknown`, a timeout (5 s), a transport error, a redirect, a
  malformed body and an answer naming another `operationId`. All of them hold
  the operation `prepared`.
- **The link is HTTPS.** The URL is validated at startup: `https:` anywhere;
  plain `http:` only to a loopback host (`localhost`, 127.0.0.0/8, `[::1]`),
  in every `NODE_ENV`, production included; no credentials in the URL. The
  bearer token and the allow/deny answer cross this link, so a plaintext hop
  would let an on-path party ask on the bridge's behalf or forge an `allow`.
- The mark and the rolling-spend row commit in one transaction. Once marked,
  the attempt becomes observation-only and is never sent again.

### Riddler's decision table

Riddler answers from the operation's **captured admission** (operation id +
the bridge fingerprint of the admitted terms, written when Riddler admitted the
order), never from the recipient binding's current state, and binds the first
`allow` (D-A). In order (`Shielded.Operations.may_broadcast/3`):

| Riddler holds for `operationId` | Asked with | Answer |
| --- | --- | --- |
| no admission (or it is unreadable / malformed) | -- | `unknown` |
| an admission for another fingerprint | -- | `deny` (logged at error: an incident) |
| the admission, no binding | -- | bind `{operationId, fingerprint, txHash}` durably, THEN `allow`; `unknown` if the bind cannot be made durable |
| a binding | the same fingerprint and txHash | `allow` (the bridge resending its exact journaled bytes) |
| a binding | another fingerprint or txHash | `deny` (logged at error: a bridge journal rollback or loss) |
| anything, but the lookup errs or exceeds Riddler's 2 s budget | -- | `unknown` |

`key_compromise` (withdrawing an admitted operation's permission because the
recipient key was reported compromised) is **deferred and not implemented**:
nothing turns a held admission into `deny` today.

On the bridge side: `deny` and `unknown` hold alike (`prepared`, retried
later, never refunded); an answer whose `operationId` is not the one asked
holds; only an exact 200 `allow` marks. What the bridge does after an `allow`:

| After `allow` | Bridge | Observation |
| --- | --- | --- |
| both bounds still open | mark, then the synchronous final check, then send | `pending` / `included` / ... |
| `validUntil` passed before the mark | not marked, not sent | `not_submitted`, `validity_bound_passed`, not retryable |
| protocol expiration passed before the mark | not marked, not sent; the hash stays bound at Riddler | `not_submitted`, `expired_after_allow`, not retryable: requote under a new operation id |
| either bound passed after the mark, at the final check | marked, not sent | `submitted_unknown`, reason naming the bound |
| the gate closed (request deadline) before the mark | not marked, not sent; the hash stays bound | `prepared`, `interrupted`. A retry re-asks with the same hash and is allowed again while the attempt is unexpired; once it has expired a fresh proof is denied (`may_broadcast_denied`), and the remedy is again a new operation id |

### Single-use may-broadcast and the rollback domain (D-A)

The bridge's rollback detection is the generation in the journal mirrored into
`<journal>.hwm`. Both files live on the same volume, so they share its
**rollback domain**: a snapshot restore of the volume restores both, the mark
then agrees with the older journal, and the check passes. `.hwm` catches a
lost, swapped or partially restored FILE; it cannot catch a restored VOLUME.
It is kept as defence in depth and is not the guarantee.

The guarantee is Riddler's single-use binding, which lives outside the
bridge's snapshot domain (on Riddler's durable store; Riddler requires
`RECOVERY_STATE_BACKEND=redis` wherever this is configured in production). A
journal that has forgotten an `allow` -- rolled back, lost, or adopted fresh
-- and re-proves the same operation produces a NEW txHash; Riddler answers
`deny`, and the operation is held `prepared` instead of paying twice. The
exact journaled bytes, if the journal still has them, carry the bound txHash
and are allowed again (they land at most once).

What this does not cover: a journal that lost an operation entirely and is
then asked for a different `operationId` for the same payout. Riddler never
issues one: its operation id is persisted with the sent terms before the call
(`Shielded.Operations.record_sent/2`).

## Request deadline

One deadline bounds a whole `aztec_createNote`, started when the request is
handled (`SETTLEMENT_DEADLINE_MS`, 145 s = the 150 s HTTP response deadline
less 5 s): admission, cooldown, proving, the may-broadcast query and send all
spend it. Every Aztec JSON-RPC call has its own aborting 10 s transport
deadline, and the HTTP server admits at most 16 concurrent JSON-RPC backend
leases. A separate bounded pool keeps journal-only `aztec_getSettlement`
reconciliation available while fund-moving or attestation work is saturated.
A backend lease stays held until tracked proving or send work actually settles,
so work that outlives its caller cannot accumulate without bound. When the
settlement deadline passes, the attempt's gate closes synchronously -- the
gate is the only thing that marks -- so nothing the request started can be
marked afterwards; a cooldown that outlasts it starts no proof. The HTTP
response deadline (`res.setTimeout`, 150 s) is the backstop: it aborts the
request's signal, which closes the gate, BEFORE the 504 is written. A caller
that got a 504 reads `aztec_getSettlement` and retries the same operation.

## Journal (`PXE_BRIDGE_JOURNAL`)

SQLite via better-sqlite3, `synchronous=FULL`, rollback journal,
`locking_mode=EXCLUSIVE` taken by a write at open: a second process on the same
file refuses to start. Operations and attempts are never pruned; spend rows are
a separate table.

**Permissions.** The journal holds signed transaction bytes from before the
may-broadcast query, so anyone who can read it can submit them. At open the
bridge creates the journal 0600 (before SQLite touches it), tightens an
existing journal, its side files (`-journal`, `-wal`, `-shm`) and `.hwm` to
0600, and refuses a directory writable by group or others (a writer there
could plant a hot rollback journal). If any of that cannot be done it refuses
to start (`JournalPermissionError`). SQLite creates side files with the
database file's mode, so they stay 0600.

**Startup invariant.** Every operation's state must be one its attempts and
spend rows can produce: `prepared` = current attempt unmarked, no marked
attempt, no spend; `may_broadcast`/`finalized`/`reverted` = current attempt
is the one marked attempt, spend row present; `claimed`/`not_submitted` = no
marked attempt, no spend (`claimed` with no current attempt); every spend row
belongs to a marked operation, holds exactly the terms `amount` as a canonical
decimal string and carries the mark's own `may_broadcast_at` as its `at` (both
are written in one transaction); the stored fingerprint is the fingerprint of
the stored terms. The spend rows rebuild the 24h window, so a smaller amount or
an older timestamp would hand budget back. A missing or malformed transaction
identity (hash, bytes, expiration) on a prepared or marked operation is
`missing_transaction_identity`; any other violation is `journal_inconsistent`.
If the window cannot be rebuilt at startup (unreadable rows, a restore that
fails) writes are disabled with `spend_window_unreadable`: the bridge never
serves with an empty window.

Writes are disabled (authenticated recovery reads continue, `/ready` is 503,
and public `/status` remains minimal liveness) on: `corrupt`,
`rollback_detected` (generation below `<journal>.hwm`, a different journal id,
or the mark missing beside a used journal), `empty_journal_for_existing_account`
(fresh journal next to an account that already existed; see "Legacy drain and
adoption"), `legacy_audit_unresolved`, `account_mismatch`,
`missing_transaction_identity`, `journal_inconsistent`,
`spend_window_unreadable`, `unknown_schema_version`, `write_failed`. With
writes disabled, new and unmarked `createNote` attempts are refused `-32004`.
An existing marked operation remains observation-only; terminal operations and
`aztec_getSettlement` remain readable.
None clears itself: restore the exact journal, or reconcile and start a new one
through the adoption procedure.

## Legacy drain and adoption (D-B)

Production shielded is off and the production sidecar is pinned to 4.2.0, so
there is no live funded legacy journal to import: a journal-era bridge always
starts a FRESH journal. Beside an account that already existed on chain that
is the lost-journal case, and it stays write-disabled until an operator adopts
it. Adoption is mechanical, one-shot and refused while the legacy audit log
still matters:

- **The acknowledgement names this journal.**
  `PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT=<account>@<journal id>`. The refusal
  (`empty_journal_for_existing_account`, in the log and in `aztec_getSettlement`'s
  `journal.detail`) prints the exact value for the journal it just created.
  It is spent once: adoption binds the account into the journal (with
  `adopted_at` and the acknowledgement in its meta), and from then on the
  stored account decides. A replacement journal after a later loss has a new
  id, so the old value cannot authorise it. A bare `<account>` (the pre-D-B
  form) is refused.
- **The legacy audit log must be drained.** When `PXE_BRIDGE_AUDIT_LOG` is
  configured (the same path the pre-journal bridge wrote), adoption is refused
  (`legacy_audit_unresolved`) while that file holds any legacy line
  (`status` present) that is:
  - an **unresolved key**: an `idempotencyKey` whose LAST legacy line is
    `submitting` or `unknown`, at any age;
  - a **spend inside the last 24h**: `success`, `unknown` or `submitting`,
    keyed or not;
  - a line that cannot be placed (does not parse, or has no parseable
    `timestamp`).

  Journal-era lines (`observation`, no `status`) are ignored. A file that
  cannot be read refuses; a missing one does not.

Procedure:

1. Stop sending createNote to the legacy bridge and let in-flight requests
   finish (its response deadline is 150 s).
2. For every unresolved key, establish on chain whether the transfer landed
   (its `txHash` when logged; otherwise the account's notes/nullifiers), then
   APPEND one legacy line for the key with the outcome:
   `{"timestamp":"<now ISO>","method":"reconcile","idempotencyKey":"<key>","status":"success"|"error","amount":"<amount>","txHash":"<hash if any>"}`.
   Last line wins per key, as the legacy replay read it. A keyless `unknown`
   line has no key to resolve: reconcile it by hand; it stops blocking once it
   is older than 24h.
3. Wait until 24h after the last spend line, reconciliation `success` lines
   included: that is the rolling window the old bridge enforced.
4. Start the journal-era bridge with `PXE_BRIDGE_JOURNAL` on its volume. It
   refuses writes and logs the `PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT=<account>@<id>`
   value. Set exactly that, restart, confirm `/ready` is 200, then remove the
   variable (leaving it is harmless: it is ignored once bound, with a warning).

Do not point `PXE_BRIDGE_AUDIT_LOG` somewhere else to get past the check; it
is the only record of what the legacy bridge may have sent.

## Liveness and readiness

| Endpoint | Auth | Answers |
| --- | --- | --- |
| `GET /status` | none, separately rate-limited | Public minimal **process liveness** only: 200 `{"status":"ok"}` with no Aztec RPC. The listener serves it while the wallet is still connecting. |
| `GET /ready` | Bearer `PXE_BRIDGE_API_KEY`, then its dedicated readiness limiter | Operational projection from the authoritative admission predicate: 200 iff `ready: true`, otherwise 503 with stable reasons. During startup it returns 503 `initializing`. A backend observation exceeding 20 seconds returns 503 `readiness_observation_failed`; later probes share that still-running observation rather than starting more Aztec RPCs. Failed authentication is charged to the separate auth-failure limiter and exposes no state. |

Backend or ordinary body-intake saturation adds
`backend_capacity_exhausted` and returns 503 for new admission. Body receipt and
JSON parsing have separate 16-request ordinary/attestation and reconciliation
ceilings. `POST /api/recovery` requires the distinct
`PXE_BRIDGE_RECOVERY_API_KEY` before reserving body intake and accepts only
`aztec_getSettlement`; its rate-limit and backend-work capacity are separate
too. Legacy-route reconciliation uses ordinary capacity, so an ordinary RPC
credential cannot consume the dedicated reconciliation budget.

The readiness projection contains the flat checker fields `ready`,
`nodeVersion`, `l1ChainId`, `rollupVersion`, `account {address,classId}`,
`token`, `maxAmount` and `dailyLimit`, plus finalized reference, policy,
inventory, rolling-window, fee-runway, node and journal observations. No
nested object other than `account` has an `address` member.

Point container restarts at `/status` and traffic/deploy gates at `/ready`.
Never restart merely because readiness is false: recovery for already marked
operations must stay online.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PXE_BRIDGE_JOURNAL` | journal path; required in production; unset refuses createNote/getSettlement (-32004) |
| `PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT` | one-shot adoption acknowledgement, `<account>@<journal id>` (D-B) |
| `PXE_BRIDGE_SETTLEMENT_CORRIDOR` | `{corridorId, corridorRevision, manifestDigest, genesisOrNetworkDigest}`; values open for manifest rev 1; unset refuses createNote (`corridor_unconfigured`) |
| `PXE_BRIDGE_MAY_BROADCAST_URL` / `_TOKEN` | Riddler endpoint (HTTPS, or loopback http) + service credential; set together; unset refuses createNote (`may_broadcast_unconfigured`) |
| `PXE_BRIDGE_AUDIT_LOG` | output-only JSON lines containing only timestamp, method and observation state; no recipient, operation, note, transaction, request-origin, token, amount or free-form reason identifiers. Read only at adoption, as the legacy log |

## Deployment

**Journal volume.** One persistent directory per bridge, owned by the bridge
user (uid 1000 in the image, `USER node`), mode 0700, bind-mounted read-write
and never shared with another bridge or container. `PXE_BRIDGE_JOURNAL` names
a file inside it (`settlement.sqlite`); `<journal>.hwm`, the SQLite side files
and the audit log live beside it. It must survive container replacement (the
journal is the recovery authority) and it holds signed transactions: keep it
off any backup or snapshot that is restored automatically -- a restored volume
is exactly the rollback the `.hwm` cannot see (see D-A) -- and treat a restore
as an incident. One writer: never scale the service; a second process on the
same file refuses to start.

**Permissions.** Directory 0700 (group/other-writable refuses to start);
files 0600, enforced by the bridge at every open.

**Environment.**

| Variable | Value |
| --- | --- |
| `PXE_BRIDGE_JOURNAL` | `/var/lib/pxe-bridge/journal/settlement.sqlite` |
| `PXE_BRIDGE_AUDIT_LOG` | `/var/lib/pxe-bridge/journal/audit.jsonl` (same path the pre-journal bridge used) |
| `PXE_BRIDGE_SETTLEMENT_CORRIDOR` | the approved rev 1 corridor JSON (placeholder until decided) |
| `PXE_BRIDGE_MAY_BROADCAST_URL` | `https://<riddler>/shielded/may-broadcast` |
| `PXE_BRIDGE_MAY_BROADCAST_TOKEN` | secret; the same value as Riddler's `SHIELDED_MAY_BROADCAST_TOKEN` for this environment; delivered like the other bridge secrets (tmpfs file read by the entrypoint), never in the compose file |
| `PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT` | unset; set once, per the adoption procedure |

Riddler's side: `SHIELDED_MAY_BROADCAST_TOKEN`, `SHIELDED_NAMESPACE` (distinct
per environment, shared by blue/green colours) and
`RECOVERY_STATE_BACKEND=redis`.

**Readiness.** Gate deploys and new settlement traffic on authenticated
`GET /ready` (200 = ready; Bearer `PXE_BRIDGE_API_KEY`). Its projection is the
same typed predicate `aztec_createNote` invokes before proving or broadcasting
new work. `GET /status` remains public process-local liveness only and performs
no Aztec RPC. Keep the container healthcheck on `/status`: a journal with
writes disabled or another readiness fault must not restart the service,
because `aztec_getSettlement` and marked-operation observation remain
available.

The predicate admits only design-A spending-limit deployments with a durable
deployment record. It checks the configured/derived address and compiled class,
initialization and pause state, permitted token, local/on-chain allowlist root
and limits, the contract's own spend window, finalized token inventory,
rolling-window headroom, fee runway, journal write health and exclusive fence,
complete network identity, node transaction readiness, and synchronized
retained world-state history. One exact nonzero `finalized` block number/hash
is captured and supplied to every contract and storage observation; `proven`
and `latest` are never fallbacks. The finalized block timestamp must be at
most 7,200 seconds old and no more than 300 seconds ahead of local time.
Unknowns and read failures are explicit not-ready reasons.

**Marked exposure.** A `may_broadcast` operation may still take its principal
and one fee from the finalized state until the finalized block's timestamp
passes its attempt's protocol expiration (the node admits a transaction only
into a block whose timestamp is at most that expiration). Past it the
transaction either landed at or before the finalized block, which then already
shows its spend and fee, or it never will. So every marked operation counts
against inventory, the contract window and fee juice until then, with or
without a caller asking about it, and stops counting at most one protocol
transaction lifetime (86,400 seconds from its anchor block) after it was
prepared.

Before that, a marked transfer that landed at or below the finalized block
would be counted twice: once in the finalized state, once as exposure. Each
readiness observation therefore checks up to eight unexpired marked
operations, through the same node observation `aztec_getSettlement` uses
(`createLandedReconciler`): every one except those last observed included
above the finalized block, so including those whose inclusion was never
observed, such as a send that timed out after its mark. Each observation
resumes after the last operation the previous one checked, so operations the
node never resolves cannot take every place. Only a finalized receipt records
the outcome; anything else leaves the operation as it was, still counted, and
nothing is replayed. Reconciliation gets at most 5 seconds of each
observation (`RECONCILE_BUDGET_MS`), and the abort reaches the node read
itself; running out leaves the operations counted and is not a readiness
failure.

A terminal operation stays counted while its attempt's expiration is not
before the finalized timestamp and its recorded block is above the finalized
block number. That is exact for any finalized reference, including one read
from a node behind the one that reported the receipt: block timestamps never
decrease, so a finalized timestamp past the expiration is past the block too.
Both lookups select attempts through the `attempts_expiration` expression
index, so expired and long-resolved operations cost nothing and the lookup
does not grow with the journal.

**Admissible headroom** is the smaller of the bridge's own 24h window
(`rollingWindow.localHeadroom`) and the contract's
(`rollingWindow.onChainHeadroom`). The contract keeps 25 hourly buckets and
clears aged ones lazily on the next transfer, so its lookback is 24 to 25
hours, against the bridge's exact 24. The probe reads `spend_buckets` and
`spend_bucket` at the finalized reference and replays `advance_window` to the
finalized timestamp (`onChainSpent`); on-chain headroom is the daily limit
less that, marked exposure and in-flight reservations. Zero is
`spend_window_exhausted`; an unreadable window `spend_window_unknown`; a
stored bucket after the finalized one, where every transfer would revert,
`spend_window_inconsistent`.

Required inventory is `reservations + admissible headroom + marked principal`.
Required fee juice is `(pre-mark in-flight reservations + marked operations +
ceil(admissible headroom / live max-per-tx)) * per-transfer fee limit`. The
per-transfer limit is the SDK transaction gas limits multiplied by predicted
maximum fees per gas. The projection exposes observed and required fee juice
and inventory, marked exposure, both headrooms, and the exact finalized
reference.

Concurrent admissions share one chain observation (the server single-flights
it). Capacity is therefore evaluated twice: in the projection, then again in
`runAttempt` against the live window and journal, synchronously with the
reservation. The second evaluation also refuses an amount above on-chain
headroom (`spend_window_insufficient`), so no two requests can each be judged
against headroom, inventory or fee juice that the other has already reserved.

Readiness loss blocks only new admission. An already may-broadcast-marked
operation keeps its normal lookup and observation path but is never replayed.
An already admitted `prepared` operation keeps recovering too: the
may-broadcast query and the send of its exact journaled bytes are not gated on
the `/ready` verdict, the full fee runway, finalized-tip freshness or corridor
admission. It is held, still `prepared` with the same bytes and hash and
resumed by the next call, only while one of these per-operation facts holds:

| Hold (`data.reasons`) | Source |
| --- | --- |
| `journal_unwritable`, `writer_fence_lost` | local journal |
| `may_broadcast_unconfigured` | local configuration |
| `readiness_observation_failed` | no readiness projection at all, so inventory and the contract window are unread |
| `inventory_unknown` | the probe could not read the finalized public token balance |
| `network_identity_mismatch` | node identity vs the operation's `network` |
| `account_paused` | finalized `paused` read by the readiness probe |
| `allowlist_root_mismatch` | finalized on-chain root vs the configured tree the attempt was proven against |
| `spend_window_unknown`, `spend_window_inconsistent` | the probe could not read the contract's window, or read one ahead of the finalized block |
| `operation_inventory_insufficient` | finalized public token balance below the operation's amount plus marked principal and other reservations |
| `operation_fee_runway_insufficient` | finalized fee juice below one per-transfer fee limit for this operation, each marked operation and each other reservation |
| `operation_spend_window_insufficient` | the contract's window at the finalized timestamp cannot take the operation's amount on top of marked principal and other reservations |
| in-memory rolling window full | `TransactionLimits.reserve`; answered `prepared`, never re-proved |

The `operation_*` reasons are the prepared path's own; admission's
`inventory_insufficient` and `fee_runway_insufficient` mean the bridge cannot
honour its whole admissible headroom. An underfunded fee payer is refused by
the node, not charged: Aztec 6.0.0 `GasTxValidator` rejects a transaction
whose fee payer's Fee Juice is below its fee limit both at `sendTx` and again
at block building, where it is dropped rather than included. Sending anyway
would still mark the operation and leave it counted as marked exposure until
its expiry, so the fee hold keeps it `prepared` instead.

A fact the probe could not read is not a hold -- the node and the account
decide -- except the token inventory and the contract's window. A shortfall
in either reverts in public after the fee is paid (the Token's
`_finalize_transfer_to_private`, the account's `check_spending_public`), and
only the contract's window sees spend the bridge's own 24h window has already
dropped, so either unread holds the operation (a missing projection included).
An unread fee juice balance does not: the node refuses an underfunded fee
payer without charging it. Past `validUntil` the operation is `not_submitted`;
past the attempt's protocol expiry a new attempt is prepared, as before.

## Recipient readiness attestations

The optional Worker/Riddler interface is `POST /api/attestation`,
authenticated only by `Bearer PXE_BRIDGE_ATTESTATION_API_KEY`. RPC/admin
credentials do not work there, and the attestation credential does not work on
RPC/admin routes. The feature is hidden with 404 when every attestation setting
is absent; any partial configuration fails startup. Enabling it also requires
the separately authenticated main RPC, durable journal, settlement corridor,
spending-limit account and its durable `PXE_BRIDGE_ACCOUNT_DEPLOYMENT` record.

Only `aztec_attestRecipientMembership` and
`aztec_attestRecipientDeployment` are accepted. Both take exactly:

```json
{
  "descriptor": "<@xochi/signer RecipientDescriptor object>",
  "descriptorDigest": "0x<32 bytes>",
  "recipient": "0x<32 bytes>",
  "network": "<@xochi/signer NetworkIdentity object>",
  "corridor": {
    "corridorId": "0x<32 bytes>",
    "corridorRevision": 1,
    "manifestDigest": "0x<32 bytes>"
  },
  "recipientAuthorization": {
    "digest": "0x<32 bytes>",
    "signature": "0x<64-byte Aztec Schnorr signature>"
  }
}
```

These params are the `params` member of a strict JSON-RPC 2.0 request with an
`id` and one of the two method names. On success, `result` is the exact signed
Membership or RecipientDeployment record. A typed refusal is HTTP 503 with
JSON-RPC error code `-32010`, message `Readiness attestation refused`, and
`data: {signed:false, refusal}`. Consumers import the strict schemas and
inferred types from `@xochi-fi/pxe-bridge/attestation`.

Every object is strict. In particular, source wallet/chain/binding identifiers,
block selectors, witnesses, salts, indexes and unknown members are forbidden.
Network and corridor are accepted only for comparison with the descriptor,
locally configured corridor and node observation; callers cannot select the
domain or observation. Before any observation or signature, `@xochi/signer`
validates the descriptor, its digest, the derived recipient, the pinned
`aztec-6.0.0` class/profile/network and the recipient message wrapper/Schnorr
authorization.

Membership is positive only when the durable local snapshot's complete
`(address,index)` mapping equals the mapping that built the in-memory tree, that
tree reproduces the exact finalized root, and the recipient witness verifies.
It is negative only when the same authoritative snapshot/root proves absence.
RecipientDeployment is positive only for the exact descriptor recipient and
class in initialized finalized state; authoritative absence or
non-initialization is negative, while a different subject/class is a refusal.
Before either finalized root or deployment read, the bridge validates the
recorded solver address, pinned compiled current class, initialized state,
synchronized retained history, exact nonzero finalized number/hash, and the
shared 7,200-second maximum age / 300-second future-skew limits. Missing
history, root drift, failed reads and every other uncertainty return the
unsigned refusal with no record or signature.

Success records are the exact SDK Membership and RecipientDeployment wire
shapes, signed over `readinessDigest` by a dedicated secp256k1 key. Consumers
verify them with `verifyReadinessRecord`, `maxAgeSeconds: 7200` and
`maxFutureSkewSeconds: 300`. The signer is
`PXE_BRIDGE_ATTESTATION_SECRET_ARN` in production or dev-only
`PXE_BRIDGE_ATTESTATION_SECRET_KEY`; resolved key material may not equal any
spend/admin/allowlist custody value or RPC, admin, may-broadcast, attestation or
RootUpdate relay bearer token.

The SQLite journal schema stores the local allowlist snapshot identity and
exact RootUpdate relay envelope. The payload is durable before HTTP send,
retains one idempotency key across uncertain delivery, and retries after
restart. Every tick delivers the pending envelopes, in order, even when the
chain observation (bounded to 20 seconds) or the enqueue fails, and an attempt
that cannot be recorded is resent under the same key. Only the configured
URL's own `204` is durable acceptance; redirects are refused. A new signed
record, from a fresh finalized observation and with a new idempotency key, is
enqueued when the finalized root differs from the latest envelope's, when the
corridor changed, when the latest record's `attestedAt` is 3,600 seconds old
(half the consumers' 7,200-second maximum age, so an unchanged root never
lapses), and once per process after restart. If the latest envelope already
names the current root and is undelivered, that exact envelope and key is the
restart push. The relay HTTP body is
`{corridor_id,corridor_revision,record:<signed RootUpdate>}` and is configured
separately by `PXE_BRIDGE_ATTESTATION_RELAY_URL` / `_TOKEN`; only HTTPS or
loopback HTTP is accepted. Attestation audit output contains only method,
outcome and typed reason—never recipient, descriptor/digest/signature, root
association, witness/salt/index or L2 transaction data.


**xochimilco.** The `aztec_testnet` role (`roles/aztec_testnet`, branch
`feat/pxe-bridge-journal`) carries this: journal path and audit log on the
existing `/opt/aztec-testnet/bridge/journal` (uid 1000, 0700) bind mount, the
corridor JSON and may-broadcast URL as asserted inventory placeholders, the
may-broadcast token as one more 1Password-delivered tmpfs secret read by the
entrypoint, `aztec_testnet_bridge_readiness_path: /ready`, one-shot adoption
as `-e aztec_testnet_bridge_journal_adopt_account=<account>@<journal id>`, and
a replacement check that the journal id is unchanged and its generation did
not go back. Its `NODE_ENV` is `testnet`, so the role asserts the `https://`
URL itself in addition to the bridge's own check.
