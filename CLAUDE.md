# CLAUDE.md

JSON-RPC bridge from EVM intent solvers to Aztec L2 shielded settlement: a
`node:http` server wrapping the Aztec SDK through an embedded PXE wallet.
Supports a plain Schnorr account and a custom spending-limit account contract
(Noir) with on-chain per-tx caps, a daily window, a Merkle recipient allowlist
and a timelocked admin.

```
EVM Solver --JSON-RPC--> pxe-bridge --Aztec SDK--> Aztec L2 Node
```

## Commands

```bash
npm install
npm run build            # tsc -b
npm run typecheck        # src/, tests/, scripts/
npm test                 # vitest run
npm run test:watch
npm run test:coverage
npm run test:e2e         # needs a running sandbox; excludes the crash smoke
npm run test:e2e:crash   # crash smoke alone, on a FRESH sandbox
npm run test:e2e:up      # compose up, e2e, compose down; then the crash smoke
npm run dev              # tsx src/index.ts
npm start                # node dist/index.js

npm run bridge-fee-juice -- --recipient 0x<addr>                 # L1 -> L2 fee juice; prints FEE_JUICE_CLAIM
npm run bridge-fee-juice -- --deployer --recipient 0x<addr>      # same, as PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM
npm run bridge-fee-juice -- --admin --recipient 0x<addr>         # same, as SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM
npm run bridge-fee-juice -- --wait 0x<messageHash>               # resume a timed-out wait; never rerun the bridge step
npm run bridge-fee-juice -- [--deployer] --recipient 0x<addr> --recover <deposit file>   # recover a run that died
npm run bridge-fee-juice -- --recipient 0x<addr> --claim-out <file>   # write the claim owner-only instead of printing it
npm run bridge-fee-juice -- [--deployer] --address-only          # dev: derive the address from PXE_BRIDGE_SECRET_KEY
npm run top-up-fee-juice          # bridge + claim on an account's behalf; env only, refuses arguments
npm run update-allowlist -- --add 0x<addr> --index <n>
npm run update-allowlist -- --revoke 0x<addr>
npm run -s oxide-allowlist -- --add 0x<addr> --index random     # Oxide private allowlist; bridge stopped
npm run -s oxide-allowlist -- --revoke 0x<addr>                 # drain the recipient's obligations first
npm run -s oxide-allowlist -- --stdin                           # production: KEY=VALUE lines on stdin, nothing in argv/env
docker build --target oxide-allowlist -t pxe-bridge-oxide-allowlist:<tag> .
npm run admin -- status [--expect-root <hex>] [--expect-paused] [--min-fee-juice <n>]   # exit bits 2 pause, 4 proposal, 8 root, 16 fee juice
npm run admin -- pause|unpause|apply-limits|cancel-limits
npm run admin -- propose-limits --max-per-tx <n> --daily <n>
npm run build:oxide-token         # compile the OxideToken artifact; refuses unless OXDAI's class
npm run check:oxide-token [-- <artifact.json>]
```

Admin commands read `SPENDING_LIMIT_ACCOUNT`, `SPENDING_LIMIT_ADMIN_KEY` (not
`status`) and `AZTEC_NODE_URL`; `update-allowlist` also
`PXE_BRIDGE_ALLOWLIST_SEED` and `PXE_BRIDGE_ALLOWLIST_RECIPIENTS`. All need the
artifact in `contracts/spending_limit_account/target/`.

CI runs `typecheck` -> `test` -> `build`, an `e2e` job via docker compose, and a
`contract` job that compiles both contracts and checks `CLASS_ID`,
`ARTIFACT_SHA256` and the OXDAI class.

## E2E tests

`tests/e2e/` runs against `docker-compose.yml` (Anvil + `azteclabs/aztec:6.0.0`,
no platform pin). `globalSetup` starts compose unless `AZTEC_NODE_URL` is set;
`AZTEC_NODE_URL` and `L1_RPC_URL` point the suite elsewhere.

- Anvil: `--block-base-fee-per-gas 0`, automine (no `--block-time`), started
  five minutes behind wall time, `--slots-in-an-epoch 1`. Larger offsets fail
  the local network's startup; a nonzero base fee makes sends priced off
  `getPredictedMinFees` fail simulation after each L1 fee refresh.
- The chain clock runs ahead under traffic, so the crash smoke
  (`tests/e2e/crash-recovery.test.ts`) runs alone (`E2E_SUITE=crash`) and its
  `beforeAll` waits up to 20 minutes for the finalized tip to return inside
  the 300-second future-skew limit. Do not weaken that policy.
- `advanceFinalizedTip()` in `tests/e2e/helpers.ts` drives real L2
  transactions until the proposed tip is `finalized`; never sleep or
  substitute `proven`/`latest`.
- Every e2e client gets its own wallet data directory
  (`walletDataDirectory()`); a wallet calling a contract it did not deploy
  registers it first (`registerPublished()`).
- The sandbox's own L1 drift check is disabled only in compose; production
  nodes keep it.

## Required Environment

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PXE_BRIDGE_SECRET_KEY` | Dev only | -- | 32-byte hex key below the BN254 Fr modulus; rejected when `NODE_ENV=production` |
| `PXE_BRIDGE_SECRET_ARN` | Prod | -- | AWS Secrets Manager ARN/name for the secret key |
| `PXE_BRIDGE_API_KEY` | No | -- | Bearer token for RPC and `/ready` (warns if unset) |
| `PXE_BRIDGE_RECOVERY_API_KEY` | No | -- | Distinct bearer for `POST /api/recovery`; must differ from every other credential; unset makes the route 404 |
| `PXE_BRIDGE_ADMIN_KEY` | No | -- | Bearer for `POST /admin/resume`; must differ from the RPC key; unset makes the route 404 |
| `AZTEC_NODE_URL` | No | `http://localhost:8080` | Aztec node |
| `PXE_BRIDGE_HOST` | No | `127.0.0.1` | Bind address |
| `PXE_BRIDGE_PORT` | No | `8547` | Listen port |
| `PXE_BRIDGE_ACCOUNT_ADDRESS` | Prod | -- | Recorded account address; `connect()` refuses a key that derives elsewhere. Required in production unless `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1` |
| `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY` | First deploy only | -- | `1` lets a production bridge start without an address or deployment record; record the logged values, then remove it |
| `FEE_JUICE_CLAIM` | No | -- | `{claimAmount, claimSecret, messageLeafIndex}` for the plain account's deployment fee. Refused with `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` |
| `PXE_BRIDGE_ALLOW_SPONSORED_FPC` | No | on outside production | `true`/`false`. Whether an undeployed account may pay its deployment via SponsoredFPC (sandbox/testnet only). Refused under `NODE_ENV=production` unless `true`; any other value is rejected |
| `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM` | No | -- | Claim bridged to the spending-limit deployer (salt + 1); it self-deploys and pays the account deploy. Requires `PXE_BRIDGE_SPENDING_LIMIT_ADMIN`. Must cover the deployer's fee, the account deploy's full fee limit and any top-up claims the deployer sends |
| `PXE_BRIDGE_MAX_AMOUNT` | No | -- | Per-tx amount ceiling |
| `PXE_BRIDGE_DAILY_LIMIT` | No | -- | 24h rolling volume cap; circuit breaker |
| `PXE_BRIDGE_COOLDOWN_THRESHOLD` | No | -- | Amount at or above which the cooldown applies |
| `PXE_BRIDGE_COOLDOWN_DELAY_MS` | No | -- | Cooldown delay |
| `PXE_BRIDGE_AUDIT_LOG` | No | stdout | JSON-lines audit log path. Output only, except adoption reads it as the legacy log (`legacy-audit.ts`) |
| `PXE_BRIDGE_JOURNAL` | Prod | -- | SQLite settlement journal. Directory 0700, files 0600. Unset refuses `aztec_createNote`/`aztec_getSettlement`. See docs/settlement-operations.md (also `PXE_BRIDGE_JOURNAL_ADOPT_ACCOUNT`, `PXE_BRIDGE_SETTLEMENT_CORRIDOR`, `PXE_BRIDGE_MAY_BROADCAST_URL`/`_TOKEN`) |
| `PXE_BRIDGE_ATTESTATION_API_KEY` | With attestations | -- | Bearer for `POST /api/attestation`; must differ from every other credential |
| `PXE_BRIDGE_ATTESTATION_SECRET_ARN` | Prod attestations | -- | Secrets Manager ARN of the secp256k1 readiness signer; must not equal any custody or bearer value |
| `PXE_BRIDGE_ATTESTATION_SECRET_KEY` | Dev attestations | -- | Dev-only secp256k1 scalar; refused in production |
| `PXE_BRIDGE_ATTESTATION_SOURCE_CHAIN_ID` | With attestations | -- | Positive decimal source-chain id |
| `PXE_BRIDGE_ATTESTATION_ENVIRONMENT` | With attestations | -- | Environment string in the readiness domain |
| `PXE_BRIDGE_ATTESTATION_RELAY_URL` / `_TOKEN` | With attestations | -- | HTTPS (or loopback HTTP) RootUpdate relay and its token |
| `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` | No | -- | Admin AztecAddress; enables the spending-limit account. Requires `PXE_BRIDGE_MAX_AMOUNT` and `PXE_BRIDGE_DAILY_LIMIT` |
| `PXE_BRIDGE_SPENDING_LIMIT_TOKEN` | With admin | -- | The single token the account may move; fixed at construction. Other tokens are refused with invalid params |
| `PXE_BRIDGE_ALLOWLIST_SEED` | With admin | -- | 32-byte hex secret every leaf salt derives from. SENSITIVE and unrecoverable (SECURITY.md, "Losing the allowlist"); warned about in production env |
| `PXE_BRIDGE_ALLOWLIST_RECIPIENTS` | With admin | -- | JSON `[{address, index}]`, index in `[0, 1024)`, matching what the admin built. Assign positions randomly |
| `PXE_BRIDGE_ACCOUNT_DEPLOYMENT` | Prod, with admin | -- | `{address, maxAmountPerTx, dailyLimit, admin, token, allowlistRoot}` logged after deployment. Fixes the address across allowlist and limit changes. With it set the bridge never deploys. Do not edit |
| `PXE_BRIDGE_SEND_MODE` | No | `spending_limit` | `spending_limit` or `oxide`. Each refuses the other's createNotes (`-32602` `send_mode_unsupported`) |
| `PXE_BRIDGE_OXIDE_JOURNAL` | With Oxide | -- | Oxide sender journal (schema 2); its own SQLite file, never `PXE_BRIDGE_JOURNAL`'s path |
| `PXE_BRIDGE_OXIDE_L1_RPC_URL` | With Oxide | -- | Ethereum mainnet RPC, view calls only |
| `PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT` | With Oxide | -- | Compiled OxideToken JSON from `npm run build:oxide-token`; refused unless the OXDAI class |
| `PXE_BRIDGE_OXIDE_MAX_PER_TX` | No | 1000 DAI (1e21) | Oxide per-tx cap, base units; never above the token's 5,166 DAI `maxNoteAmount` |
| `PXE_BRIDGE_OXIDE_DAILY_LIMIT` | No | 10000 DAI (1e22) | Oxide rolling-24h cap, base units |
| `PXE_BRIDGE_OXIDE_ALLOWLIST_SEED` | Oxide mode | -- | Oxide allowlist seed; must differ from `PXE_BRIDGE_ALLOWLIST_SEED`. SECRET |
| `PXE_BRIDGE_OXIDE_ALLOWLIST_RECIPIENTS` | Oxide mode | -- | The PRIVATE recipient set, JSON `[{address, index}]`. Secret store only; changed only with `npm run oxide-allowlist` |

## Architecture

Plain `node:http` with zod validation, no framework. Contract table and
operator procedures: docs/settlement-operations.md, docs/operations.md.

- **`index.ts`** -- Entrypoint. Validates local config, binds `/status`, then
  resolves secrets, opens the journal and constructs `AztecClient`. Every
  other route is 503 until the wallet connects and the journal binds.
- **`server.ts`** -- `createApp(client, opts?)`. Constant-time bearer auth
  with separate auth-failure limiters; rate, Content-Type, body size, body
  concurrency (one 16-body pool for RPC and attestation, a separate one for
  `/api/recovery`) and response deadlines. `/status` is liveness only.
  `/ready` serves the single-flight hard-readiness projection.
- **`rpc.ts`** -- JSON-RPC 2.0 dispatch. Refuses a token other than
  `pinnedToken()` before reserving budget. A `PostSubmissionError` commits the
  reservation and answers with `error.data.txHash`: reconcile, never retry.
- **`readiness.ts`** -- The one typed predicate behind `/ready` and
  `aztec_createNote` admission. One exact nonzero `finalized` block anchors
  every observation (no `proven`/`latest` fallback; at most 7,200 s old, 300 s
  ahead). Admissible headroom is `min(local 24h window, on-chain headroom)`;
  marked exposure counts every unexpired `may_broadcast` operation. Required
  inventory is `reservations + headroom + marked principal`; required fee
  juice is `(pre-mark reservations + marked + ceil(headroom / per-tx cap)) *
  fee limit`. Unknown observations fail closed. `rpc.ts` `runAttempt`
  re-evaluates capacity synchronously with each reservation; a `prepared`
  operation is held only on per-operation facts (`preparedHoldReasons`,
  `preparedCapacityReasons`).
- **`aztec-client.ts`** -- Wraps the SDK v6 embedded wallet: key derivation,
  isolated LMDB storage, deploy or reconnect, class-checked Token instances,
  deterministic prepared transactions, broadcast of exact journaled bytes.
  Installs `bridgeTaggingSecretStrategy` (address-derived tagging; refuses
  the revealing non-interactive handshake). Owns the finalized chain probe.
  Secret key zeroed after connection; sends time out at 120 s.
- **`account-identity.ts`** -- Fail-closed check that a derived account is the
  recorded one; used by `connect()`, the admin CLIs, `top-up-fee-juice.ts`
  and `bridge-fee-juice.ts`. See SECURITY.md "Account address pinning".
- **`secrets.ts`** -- Secrets Manager or dev env key; validates 32 bytes
  below the Fr modulus at startup.
- **`attestation.ts`, `attestation-secret.ts`** -- `POST /api/attestation`
  (issue #50): strict Zod contracts, one exact finalized observation, signed
  Membership / RecipientDeployment records or an unsigned typed refusal.
  `RootUpdatePublisher` re-signs an unchanged root every
  `ROOT_UPDATE_REFRESH_SECONDS` (3,600) and delivers via a write-before-send
  outbox; only a direct 204 counts.
- **`fee-juice.ts`** -- Bridge from L1 and claim on another account's behalf
  (the spending-limit account admits one call, so `PREEXISTING_FEE_JUICE` is
  its only fee branch). The claim secret is persisted owner-only before any
  L1 write; `recoverFeeJuiceClaim()` rebuilds it from portal events.
- **`types.ts`** -- Envelope schema, error codes (-32001 request_in_flight,
  -32002 submitted_unknown, -32003 operation_conflict, -32004
  journal_unavailable, -32005 not_submitted, -32006 bridge_not_ready),
  `IAztecClient`, `AccountDeploymentSchema`.
- **`limits.ts`** -- `TransactionLimits`: per-tx ceiling, 24h rolling window
  with circuit breaker, cooldown. The breaker trips on committed volume only
  (cap reached, or under 1% left and less than the request). `restore()`
  seeds the window from journal spend rows.
- **`audit.ts`** -- Output-only JSON lines: timestamp, method, observation
  state. No identifiers. Nothing reads it back.
- **`partial-note.ts`** -- (#78) Captures the `transfer_to_private` partial
  note randomness `r` by wrapping `getRandomField` in an AsyncLocalStorage
  scope around one send and selecting the `r` with
  `P2([recipient, r], 568912195) == C`. None or several:
  `PartialNoteUnresolved`, not retryable. `r` is never logged.
- **`tx-identity.ts`** -- Recomputes a transaction's hash from its bytes
  (`Tx.computeTxHash`) and requires it and the expiry to equal the journaled
  ones before any resend; a mismatch is `unknown`, `journaled_bytes_mismatch`.
- **`settlement.ts` / `journal.ts` / `may-broadcast.ts` / `legacy-audit.ts`**
  -- The `pxe-bridge.settlement.v2` contract, the SQLite journal (fenced
  single writer, 0600, startup invariant, writes disabled on corruption or
  rollback, one-shot adoption), and the synchronous Riddler may-broadcast
  query (only HTTP 200 `allow` marks). `scripts/settlement-vectors.ts`
  generates `docs/vectors/settlement-v2.json`; a test fails when it is stale.
- **`allowlist-tree.ts`** -- Dense height-10 Merkle tree of `h(recipient,
  salt)` with seed-derived salts; `rootFromSiblingPath()` mirrors the
  circuit. Hashes and path orientation are pinned identically in `main.nr`.
- **`spending-limit-account.ts`** -- `AccountContract` wrapper. Constructor
  args come from `SpendingLimitConfig.deployment` when set. The entrypoint
  derives amount, recipient and witness from the `transfer_to_private` call
  it signs (`spendingLimitSignedHash()`, pinned in `main.nr`). The tree is
  shared by reference across entrypoints. `spendingLimitEntrypointAbi()` is
  hand-written; the `contract` job checks it against the artifact.
- **`contracts/spending_limit_account/`** -- Noir account contract; build
  with `aztec compile` (never `aztec-nargo compile`) at
  `HARDWARE_CONCURRENCY=1`. `check_spending_public`: per-tx cap, 25-bucket
  daily window, allowlist root, single token, timelocked limits, `pause`.
  `update_recipient` is the whole allowlist API and is untimelocked. Asserts
  `fee_payment_method == PREEXISTING_FEE_JUICE`. Artifact is gitignored and
  built by CI. Any change to `main.nr` moves the class ID: update
  `contracts/spending_limit_account/CLASS_ID` (from the x86 CI artifact,
  `node scripts/contract-class-id.js`) and `TIMELOCK_CHECKED_AT_CLASS_ID` in
  `tests/spending-limit-admin.test.ts` in the same commit, and re-check
  `PARAM_TIMELOCK_SECONDS` / `PARAM_APPLY_WINDOW_SECONDS` in
  `scripts/spending-limit-admin.ts`. Do not move the 6.0.0 toolchain or
  aztec-nr pin with an SDK bump. Values: SECURITY.md "6.0.0 artifact of
  record".
- **`scripts/admin.ts`, `scripts/update-allowlist.ts`** -- CLIs over
  `scripts/spending-limit-admin.ts`: admin self-deploy (`npm run admin --
  deploy`, `SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM`), temp wallet stores
  deleted on exit and signals, secrets via `takeSecretEnv`, `status` reading
  public storage at the artifact's slots (class checked first; node trusted).
  Never put the admin key in `PXE_BRIDGE_SECRET_KEY`.
- **`src/oxide/`** -- (#84) The OXDAI sender for `sendMode: "oxide"` on the
  standard account. Pipeline: simulate -> `payoutNoteIndex` -> enclave
  `signTokenOperation` (HPKE) -> final simulate -> `proveTx` -> journal ->
  may-broadcast -> mark -> bound check -> send. Fresh attempts run one at a
  time; a simulation touching a live attempt's nullifier is `inputs_pending`.
  `enclave.ts` pins PCR0 against `TeeRegistry.PCR0_HASH()` and the Nitro
  root; `pins.ts` pins the v6 deployment; `assertL1Pinned` runs before every
  attempt and resend. Fee runway (`OxideSender.feeRunway()`) must cover this
  send plus every attempt that may still land. `vendor/` is the upstream
  subset (`VENDORED.md`).
- **`src/oxide/allowlist.ts`, `attestation.ts`, `readiness.ts`** -- Oxide
  readiness (xochi#751/#775 option a): PRIVATE off-chain allowlist
  (`OxideAllowlist`), `OxideAttestationProbe` over the stock SchnorrAccount
  6.0.0 class, `OxideReadiness` serving `/ready` (serving health) and
  `admission.freshSend` (capacity). Un-pinned deployments are refused
  PERMANENTLY at admission (OX-6; `enclaveRefusalPermanent` is the one
  classifier). Nothing exposes the set, its root or its size.

## Security

- Binds to `127.0.0.1`; set `PXE_BRIDGE_HOST=0.0.0.0` only behind a reverse
  proxy. Bearer auth required in production. `Content-Type: application/json`
  required on POST. 60 requests/min. `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store`.
- Secret key from Secrets Manager in production; zeroed after derivation.
- Admin key, signing key and allowlist seed are held apart: admin + signing
  key can drain to an attacker-built leaf within live limits (SECURITY.md,
  "An attacker holding the admin key").
- Production spending-limit deploy: docs/operations.md "Deploying the
  spending-limit account in production". `FEE_JUICE_PAYER_DEPLOYER=true` is
  refused under `NODE_ENV=production`.
- Docker: `USER node`, `npm ci`, source maps stripped.

## Key Details

- ESM-only, `.js` import extensions; strict tsconfig
  (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`).
- Aztec SDK/runtime 6.0.0 (`@aztec-labs/*`, `azteclabs/aztec:6.0.0`); the
  contract is compiled by the 6.0.0 toolchain against aztec-nr v6.0.0.
  `@aztec-labs/aztec.js/fields` and `/addresses` are dynamically imported
  inside methods.
- The admitted Token class and the SponsoredFPC address come from
  `@aztec-labs/noir-contracts.js` and move with an SDK bump (6.0.0 Token
  class `0x067df4dd...`, SponsoredFPC `0x2d8fff82...`).
- Docker image needs trixie's libstdc++ (`GLIBCXX_3.4.32` for bb.js).
- CI pushes to `ghcr.io/xochi-fi/pxe-bridge` on semver tags only.
