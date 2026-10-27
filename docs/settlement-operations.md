# Settlement operation contract (`pxe-bridge.settlement.v1`)

xochi-fi/pxe-bridge#45; consumer axol-io/Riddler#1351. Decisions: xochi
`docs/planning/shielded-execution.md` §7 "Decided 2026-10-24" (binding-revocation
signal) and the 2026-10-25 second set (SQLite store, versioned payload,
bridge-owned fingerprint, may-broadcast query).

## Methods

| Method | Params | Answer |
| --- | --- | --- |
| `aztec_createNote` | one object: `version: "pxe-bridge.settlement.v1"`, `operationId` (1-128 printable ASCII, MUST equal the `Idempotency-Key` header), `network {aztecChainId, protocolVersion, rollupAddress, l1ChainId, genesisOrNetworkDigest}` (uint256 as decimal strings), `corridor {corridorId, corridorRevision, manifestDigest}`, `accountMode` (`spending_limit` \| `standard`), `recipient` (bytes32 Aztec field: nonzero, < BN254 r), `recipientDescriptorDigest` (bytes32), `token` (Aztec field), `amount` (decimal, 0 < amount <= 2^128-1), `validUntil` (unix seconds). Unknown keys refused. | `result {version, operationId, fingerprint, observation}` for `pending`/`included`/`finalized`/`reverted`; otherwise a JSON-RPC error below. |
| `aztec_getSettlement` | `{version, operationId}` | `result {version, operationId, found, fingerprint?, terms?, state?, attempts?: [{attempt, txHash, expirationTimestamp, mayBroadcast}], observation, journal {writable, reason?, detail?}}`. Read-only; served while journal writes are disabled. `found: false` answers `observation {state: "unknown", reason: "operation_not_journaled"}`: absence never means "no payout". |

Legacy `{recipient, token, amount, chainId, ...}` params are refused
(`-32602`, `data.reason: "legacy_params_refused"`).

## Error codes

| Code | Name | Meaning | `data` |
| --- | --- | --- | --- |
| -32602 | invalid params | schema, legacy params, `Idempotency-Key != operationId` | `reason?` |
| -32001 | request_in_flight | this operation is being driven now; wait and read | `operationId, fingerprint, observation {state: "request_in_flight"}` |
| -32002 | submitted_unknown | may-broadcast was marked; outcome unknown. Never resend; read `aztec_getSettlement` | `operationId, fingerprint, txHash?, observation` |
| -32003 | operation_conflict | same `operationId`, different fingerprint; no work done | `operationId, fingerprint, storedFingerprint` |
| -32004 | journal_unavailable | journal writes disabled or unreadable; this request sent nothing | `operationId?, journal {writable: false, reason, detail}` |
| -32005 | not_submitted | provably not broadcast (refused, or held before may-broadcast) | `operationId, fingerprint, observation` (`not_submitted` or `prepared`) |

## Observations

| `state` | Broadcast? | Fields | Consumer response |
| --- | --- | --- | --- |
| `prepared` | no (journaled, unmarked) | `txHash, expirationTimestamp, hold: may_broadcast_unknown \| may_broadcast_denied \| interrupted` | hold; retry the same operation later; never refund |
| `not_submitted` | no | `reason, retryableAfterRevalidation` | `true`: retry the same operation; `false` (e.g. `validity_bound_passed`): revalidate/requote |
| `request_in_flight` | maybe | -- | wait, then read |
| `submitted_unknown` | maybe | `txHash, expirationTimestamp, reason` (`post_mark_failure`, `response_deadline`, `node_reports_dropped_or_unknown`, `node_read_failed`) | hold; reconcile; a retry of the same operation may re-broadcast the journaled bytes (same hash, lands at most once) |
| `pending` | yes | `txHash, expirationTimestamp` | wait |
| `included` | yes | `txHash, expirationTimestamp, executionResult: success, blockHash, blockNumber, receiptStatus (proposed\|checkpointed\|proven), observedAt, effects {state, noteHashes, nullifiers}` | non-terminal; wait for `finalized` |
| `finalized` | yes | as `included`, `receiptStatus: finalized` (durably recorded) | delivery evidence (never "completed" alone) |
| `reverted` | yes, reverted | as `included`, `executionResult: reverted`; terminal only at `receiptStatus: finalized` | no payout only at finalized |
| `unknown` | maybe | `reason` | hold |

Effects are uninterpreted evidence: no element is "the" recipient note.

## Fingerprint

Bridge-owned (not an `@xochi/spec` encoding): `0x` + SHA-256 over
`pxe-bridge/settlement-fingerprint/v1` and one `name=value` line per term in a
fixed order, hex lowercased (`src/settlement.ts`). Consumers compare it for
equality and compare the returned `terms` field by field; nobody recomputes it.

## May-broadcast query (bridge -> Riddler)

After the exact prepared transaction (bytes, hash, protocol
`expirationTimestamp`) is flushed and before the may-broadcast mark, the bridge
`POST`s `PXE_BRIDGE_MAY_BROADCAST_URL` with `Authorization: Bearer
<PXE_BRIDGE_MAY_BROADCAST_TOKEN>` (environment-scoped service credential) and
body `{version: "pxe-bridge.may-broadcast.v1", operationId, fingerprint,
txHash}`. Only a 200 `{version, operationId (echoed), decision: "allow"}` marks.
`deny`, `unknown`, timeout (5 s), transport error, non-2xx, a malformed body or
another operation's answer hold the operation `prepared`. The mark and the
rolling-spend row commit in one transaction. A re-broadcast of a marked attempt
does not ask again.

## Journal (`PXE_BRIDGE_JOURNAL`)

SQLite via better-sqlite3, `synchronous=FULL`, rollback journal,
`locking_mode=EXCLUSIVE` taken by a write at open: a second process on the same
file refuses to start. Operations and attempts are never pruned; spend rows are
a separate table. Writes are disabled (reads continue, `/status` reports
`degraded` with the reason) on: `corrupt`, `rollback_detected` (generation below
`<journal>.hwm`, a different journal id, or the mark missing beside a used
journal), `empty_journal_for_existing_account` (fresh journal next to an account
that already existed; set `PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT=<address>` only after
reconciling every earlier transfer), `account_mismatch`,
`missing_transaction_identity`, `unknown_schema_version`, `write_failed`. None
clears itself: restore the exact journal, or reconcile and start a new one.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PXE_BRIDGE_JOURNAL` | journal path; required in production; unset refuses createNote/getSettlement (-32004) |
| `PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT` | operator acknowledgement for a fresh journal beside an existing account |
| `PXE_BRIDGE_SETTLEMENT_CORRIDOR` | `{corridorId, corridorRevision, manifestDigest, genesisOrNetworkDigest}`; values open for manifest rev 1; unset refuses createNote (`corridor_unconfigured`) |
| `PXE_BRIDGE_MAY_BROADCAST_URL` / `_TOKEN` | Riddler endpoint + service credential; set together; unset refuses createNote (`may_broadcast_unconfigured`) |
| `PXE_BRIDGE_AUDIT_LOG` | output-only JSON lines; nothing reads it back |
