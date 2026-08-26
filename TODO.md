# PXE Bridge Security Scaling

Incremental hardening plan for pxe-bridge's trust model, ordered by
effort and blast-radius reduction. Each phase is independently shippable.

## Phase 0: Application-Level Hardening (code only)

No infra changes. Caps the blast radius of a compromised key or rogue caller.

- [x] **Per-tx amount ceiling** -- reject `aztec_createNote` above a configurable
      max (env `PXE_BRIDGE_MAX_AMOUNT`). Log and return RPC error.
- [x] **Rolling volume limit** -- 24h sliding window aggregate spend cap
      (env `PXE_BRIDGE_DAILY_LIMIT`). Circuit-breaker: pause all note creation
      when exceeded, require manual re-enable or process restart.
- [x] **Structured audit log** -- JSON-lines log of every `createNote` call:
      timestamp, recipient, token, amount, txHash, clientIP. Separate from
      application logs. Write to stdout with a parseable prefix or a dedicated
      log file (`PXE_BRIDGE_AUDIT_LOG`).
- [x] **Cooldown for large transfers** -- configurable delay (e.g. 30s) for
      amounts above a threshold, giving monitoring a window to alert/intervene.

## Phase 1: Key Management (infra)

Move the secret key out of process memory at rest.

- [x] **AWS Secrets Manager / Parameter Store** -- fetch `PXE_BRIDGE_SECRET_KEY`
      at startup via `@aws-sdk/client-secrets-manager`, zero after wallet
      derivation (current pattern, but key never touches env vars or disk).
- [x] **Env var elimination** -- stop accepting the key via env var in production.
      Env vars are visible in `/proc/pid/environ`, `docker inspect`, and crash
      dumps. Accept only a secret ARN/path.
- [x] **IAM scoping** -- bridge process role can only read the one secret. No
      write, no KMS decrypt beyond what Secrets Manager needs.

## Phase 2: Custom Noir Account Contract

Aztec's account abstraction is native -- every account is a contract. Move
authorization logic on-chain so it's enforced even if the bridge is compromised.

- [x] **Spending-limit account contract** -- Noir contract that extends the
      Schnorr account with a per-tx cap and a 25-bucket sliding daily window,
      both `u128` and both stored in public state. Enforced by
      `check_spending_public`, which the entrypoint enqueues. Exceeding a limit
      does not make the tx unprovable: it is proven, included, and reverted in
      the public phase. That is deliberate, and it is what makes revocation
      immediate.
- [x] **Recipient allowlist** -- 8 slots of public storage. Membership is
      proven in private against a caller-supplied hint, then rebound to live
      storage in public by positional masking, so a transfer proven against a
      superseded allowlist cannot be included. A `min_anonymity_set` floor
      requires each transfer to carry at least N slots.
- [x] **Timelock for parameter changes** -- 24h
      (`PARAM_TIMELOCK_SECONDS`), timestamp-based rather than block-based, with
      a 24h window to apply before a proposal expires. Covers limit changes and
      allowlist additions. Removals, `pause` and `lower_min_anonymity` are
      immediate by design: tightening waits, loosening and stopping do not.

Compiled with `aztec compile`, not `nargo compile` or `aztec-nargo compile`.
The latter is a symlink to plain `nargo`, ships no transpiler, and emits
`transpiled: false`, which `loadContractArtifact` rejects. The artifact is
gitignored and rebuilt by the `contract` CI job. TypeScript wrapper at
`src/spending-limit-account.ts`, wired into `aztec-client.ts` via
`AccountManager.create()`. Enabled by setting `PXE_BRIDGE_SPENDING_LIMIT_ADMIN`
(32-byte hex AztecAddress), which also requires `PXE_BRIDGE_MAX_AMOUNT` and
`PXE_BRIDGE_DAILY_LIMIT`, since the contract rejects a zero limit. Limits are
validated at init and apply time (`daily_limit >= max_per_tx`, both non-zero,
`u128`). Deployed and exercised end to end against the sandbox by
`tests/e2e/spending-limit.test.ts` in the `e2e` CI job.

> **Constraint on every further contract change: the class ID.** Any edit to
> `main.nr` that reaches the bytecode moves the contract class ID, which feeds
> address derivation, so the account lands at a different address. Before a
> deployment exists that is free. After one, it strands the balance at the old
> address while the bridge deploys a fresh empty account and logs "Ready".
>
> Practically this means three things. Every deliberate contract change updates
> `contracts/spending_limit_account/CLASS_ID` in the same commit, re-baselined
> from an x86 CI artifact, because `aztec compile` does not finish on ARM.
> `scripts/contract-class-id.js` fails the job on unexplained drift. And
> anything on the deferred list below that touches `main.nr` (transaction
> cancellation, for one) has to land before an address is fixed, not after.
>
> `aztec compile` is also not reproducible: identical sources and toolchain
> versions have produced two different class IDs across CI runs. So a red check
> may be that flake rather than a real change. Diff the uploaded artifact before
> concluding either way, and archive the artifact a deployment was made against
> rather than rebuilding it. See SECURITY.md, "Build supply chain".

## Security Hardening Pass (2026-04-20)

Cross-cutting fixes from security audit against 2026 threat landscape
($482M stolen YTD, 76% from infrastructure attacks not code exploits).

- [x] **API key timing leak** -- padded both buffers to equal length before
      `timingSafeEqual`; no more key-length leakage via early return.
- [x] **Circuit breaker auto-reset** -- `TransactionLimits` now tracks
      `pausedAt` and auto-resumes after the full 24h window elapses.
- [x] **Reject zero amounts** -- amount regex requires positive integers
      (`^[1-9]\d*$`).
- [x] **Audit log file permissions** -- created with `0o600` on first write.
- [x] **Rate limiter test coverage** -- 8 tests (burst, per-key, sliding
      window, edge cases). `RateLimiter` class exported for direct testing.
- [x] **Health check rate limited** -- `/status` endpoint now rate-limited.
- [x] **Type-safe receipt handling** -- replaced unsafe `as unknown as
    Record` casts with explicit `typeof`/`Array.isArray` guards.
- [x] **Non-localhost TLS warning** -- logs warning when binding to
      non-localhost, recommends reverse proxy.
- [x] **Docker HEALTHCHECK** -- 30s interval, curl to `/status`.
- [x] **Noir contract limit validation** -- `initialize_public_state` and
      `apply_limits` assert `daily_limit >= max_per_tx` and reject zero in
      either slot. Range is the `u128` type itself since NM-1019 [High]; the
      original u64 check capped every limit at 18.45 tokens at 18 decimals.
- [ ] ~~**Admin daily reset**~~ -- `reset_daily_spent()` was REMOVED. An
      untimelocked admin write of `daily_spent = 0` is the same impact as
      NM-1019 [High] "Daily counter can be reset to zero", just reached
      through the admin instead of through field arithmetic.
- [x] **Transaction cancellation** -- FIXED. NM-1019 [Low] "cancellable
      transactions cannot be cancelled" was correct: the entrypoint pushed a
      cancellation nullifier and offered no path to use it. The branch is
      deleted, which was the preferred of the two resolutions because it fails
      safe if a future SDK flips `BaseWallet.cancellableTransactions` off its
      hardcoded `false`. The alternative, branching on zero non-empty calls,
      was rejected: it is a second shape through the entrypoint on which the
      fee branch still runs. The `cancellable` ABI parameter stays, read and
      ignored, because entrypoint arguments are positional. Landed with the
      Merkle allowlist so the two share one class ID move. Rationale in
      SECURITY.md, "Transaction cancellation is not supported".

Known limitations (acceptable for alpha):

- `Fr` objects hold key material on heap until GC (SDK limitation).
- Rate limiter uses `socket.remoteAddress`; deploy behind reverse proxy
  for accurate client IP.
- Transfer amounts are public. `declared_amount` is an argument to
  `check_spending_public`, along with a candidate recipient set of up to 8
  addresses and the token. Inherent to checking against public storage. See
  SECURITY.md, "What is public".
- `aztec compile` is not reproducible, so the account address cannot be rebuilt
  from source. Mitigated by the `CLASS_ID` pin and by archiving the artifact a
  deployment was made against. See the class ID note under Phase 2.
- The spending-limit account cannot pay its own fees and nothing watches its
  fee juice balance. It drains silently and refills only when an operator runs
  `npm run top-up-fee-juice` from an L1-funded key. Tracked in Phase 3.

Resolved since this list was written: the fixed-epoch daily reset, which
depended on block production rate and could wedge a stalled chain's counter, is
now a timestamp-anchored 25-bucket sliding window (NM-1019 [Medium]).

## Phase 3: Hot/Cold Wallet Split

Bound exposure per chain by separating operational funds from reserves.

- [ ] **Hot wallet** -- the existing solver account, funded with 1-2 days of
      expected settlement volume. pxe-bridge operates on this wallet only.
- [ ] **Cold reserve** -- Gnosis Safe (L1) or multi-sig Aztec account holding
      the bulk of funds. Manual or semi-automated top-up to hot wallet when
      balance drops below threshold.
- [ ] **Balance monitoring** -- alert when hot wallet balance drops below
      configurable floor or spikes unexpectedly (possible drain).
- [ ] **Fee juice balance monitoring** -- separate from the above and needed
      sooner. The spending-limit account cannot claim fee juice for itself, so
      running dry fails every transfer until an operator runs
      `npm run top-up-fee-juice` from an L1-funded key. Nothing warns today.
- [ ] **Auto-pause on low balance** -- stop accepting `createNote` when hot
      wallet can't cover the requested amount.

## Phase 4: External Signer via AuthWitnessProvider

Aztec SDK v4 has `AuthWitnessProvider` -- a single-method interface
(`createAuthWit(messageHash) -> AuthWitness`) that decouples signing from
the wallet. The signing key can live in a KMS/HSM instead of JS heap memory.

- [ ] **KMS AuthWitnessProvider** -- implement `AuthWitnessProvider` that calls
      AWS KMS (or GCP Cloud KMS) to sign. Use an ECDSA (secp256k1) account
      contract since KMS supports secp256k1 natively; Schnorr over Grumpkin
      would require a custom KMS plugin.
- [ ] **Switch account contract** -- deploy `EcdsaKAccountContract` instead of
      `SchnorrAccountContract`. Migration requires deploying a new account and
      transferring funds.
- [ ] **Privacy key handling** -- nullifier/tagging/viewing keys must still
      reside in PXE memory (Aztec limitation). These don't authorize spending
      but do reveal note contents. Accept this tradeoff or investigate TEE
      for the PXE process.

Limitation: this path requires Aztec SDK to keep `AuthWitnessProvider` stable
across versions. Pin SDK version and test signer integration on upgrades.

## Phase 5: Multi-Party Authorization

For high-value or high-trust deployments. Significant complexity increase.

- [ ] **Threshold signing (long-term)** -- split signing key across N parties
      using threshold ECDSA (tss-lib). Requires a DKG ceremony and a
      coordination layer for co-signing. Only justified at scale.
- [ ] **Multi-sig Noir account contract** -- N-of-M signature verification in
      the on-chain `is_valid` function. Simpler than threshold signing but
      requires M parties to submit auth witnesses per tx. Latency tradeoff.
- [ ] **Admin multi-sig** -- Gnosis Safe for operational actions: pause bridge,
      change spending limits, rotate keys. 2-of-3 minimum, 48h timelock for
      parameter changes.

## Not Feasible Yet

- **Trustless settlement contract** -- an Aztec contract that verifies L1
  settlement proofs directly, eliminating the solver. Aztec's cross-chain
  system is inbox/outbox message-passing only; no arbitrary L1 state proof
  verification. Revisit when Aztec ships L1 storage proof primitives.
- **Full key isolation** -- privacy keys (nullifier, tagging, viewing) must
  remain in PXE memory. Only the signing key can be delegated externally.
  TEE enclave is the only mitigation for privacy key exposure.

## Research Sources

- Wormhole Governor (per-chain daily outflow caps, guardian quorum 13/19)
- Across spoke pools (bounded per-chain hot exposure, UMA optimistic oracle)
- Connext/Everclear watchers (invariant monitoring, contract-level pause)
- LayerZero RateLimiter library (per-second token flow caps at OApp layer)
- Aztec SDK v4 `AuthWitnessProvider`, `AccountContract`, `BaseAccount` interfaces
- Aztec `EcdsaKAccountContract` / `EcdsaRAccountContract` for KMS-compatible signing
- Aztec inbox/outbox L1<->L2 message passing (TokenPortal, FeeJuicePortal)
