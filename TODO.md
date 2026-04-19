# PXE Bridge Security Scaling

Incremental hardening plan for pxe-bridge's trust model, ordered by
effort and blast-radius reduction. Each phase is independently shippable.

## Phase 0: Application-Level Hardening (code only)

No infra changes. Caps the blast radius of a compromised key or rogue caller.

- [ ] **Per-tx amount ceiling** -- reject `aztec_createNote` above a configurable
      max (env `PXE_BRIDGE_MAX_AMOUNT`). Log and return RPC error.
- [ ] **Rolling volume limit** -- 24h sliding window aggregate spend cap
      (env `PXE_BRIDGE_DAILY_LIMIT`). Circuit-breaker: pause all note creation
      when exceeded, require manual re-enable or process restart.
- [ ] **Structured audit log** -- JSON-lines log of every `createNote` call:
      timestamp, recipient, token, amount, txHash, clientIP. Separate from
      application logs. Write to stdout with a parseable prefix or a dedicated
      log file (`PXE_BRIDGE_AUDIT_LOG`).
- [ ] **Cooldown for large transfers** -- configurable delay (e.g. 30s) for
      amounts above a threshold, giving monitoring a window to alert/intervene.

## Phase 1: Key Management (infra)

Move the secret key out of process memory at rest.

- [ ] **AWS Secrets Manager / Parameter Store** -- fetch `PXE_BRIDGE_SECRET_KEY`
      at startup via `@aws-sdk/client-secrets-manager`, zero after wallet
      derivation (current pattern, but key never touches env vars or disk).
- [ ] **Env var elimination** -- stop accepting the key via env var in production.
      Env vars are visible in `/proc/pid/environ`, `docker inspect`, and crash
      dumps. Accept only a secret ARN/path.
- [ ] **IAM scoping** -- bridge process role can only read the one secret. No
      write, no KMS decrypt beyond what Secrets Manager needs.

## Phase 2: Custom Noir Account Contract

Aztec's account abstraction is native -- every account is a contract. Move
authorization logic on-chain so it's enforced even if the bridge is compromised.

- [ ] **Spending-limit account contract** -- Noir contract that extends the
      Schnorr account with per-tx and rolling daily amount caps stored in
      contract state. `is_valid` checks amounts against limits. Exceeding the
      limit makes the tx unprovable.
- [ ] **Recipient allowlist** -- on-chain whitelist of approved recipient
      addresses. Transfers to unknown addresses require a separate admin tx
      to add them first.
- [ ] **Timelock for parameter changes** -- limit/allowlist updates take effect
      after N blocks, giving operators time to detect unauthorized changes.

## Phase 3: Hot/Cold Wallet Split

Bound exposure per chain by separating operational funds from reserves.

- [ ] **Hot wallet** -- the existing solver account, funded with 1-2 days of
      expected settlement volume. pxe-bridge operates on this wallet only.
- [ ] **Cold reserve** -- Gnosis Safe (L1) or multi-sig Aztec account holding
      the bulk of funds. Manual or semi-automated top-up to hot wallet when
      balance drops below threshold.
- [ ] **Balance monitoring** -- alert when hot wallet balance drops below
      configurable floor or spikes unexpectedly (possible drain).
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
