# PXE Bridge Security Scaling

Open hardening work, ordered by effort and blast-radius reduction. Phases 0-2
(application limits, Secrets Manager key, spending-limit Noir account) have
shipped; see SECURITY.md and CLAUDE.md for what exists.

Any edit to `main.nr` that reaches the bytecode moves the class ID and so the
account address. Update `contracts/spending_limit_account/CLASS_ID` in the same
commit, re-baselined from the x86 CI artifact, and land anything below that
touches `main.nr` before an address is fixed. See SECURITY.md, "Build supply
chain".

## Known limitations

- `Fr` objects hold key material on heap until GC (SDK limitation).
- Rate limiter uses `socket.remoteAddress`; deploy behind a reverse proxy for
  accurate client IP.
- Transfer amounts are public (SECURITY.md, "What is public").
- The allowlist cannot be recovered from the chain (SECURITY.md, "Losing the
  allowlist").
- The spending-limit account cannot acquire fee juice itself; `/ready` refuses
  admission with `fee_runway_insufficient` when the balance is short, and a
  resumed `prepared` transfer is held (`operation_fee_runway_insufficient`),
  but nothing alerts on it. Tracked in Phase 3.

## Phase 3: Hot/Cold Wallet Split

- [ ] **Hot wallet** -- the existing solver account, funded with 1-2 days of
      expected settlement volume. pxe-bridge operates on this wallet only.
- [ ] **Cold reserve** -- Gnosis Safe (L1) or multi-sig Aztec account holding
      the bulk of funds. Manual or semi-automated top-up to hot wallet when
      balance drops below threshold.
- [ ] **Balance monitoring** -- alert when hot wallet balance drops below a
      configurable floor or spikes unexpectedly. `/ready` exposes finalized
      inventory and fee runway; nothing pages on them yet.
- [ ] **Fee juice balance alerting** -- a monitor that polls `/ready` and pages
      before the runway runs out, since refilling needs an operator on L1.

## Phase 4: External Signer via AuthWitnessProvider

`AuthWitnessProvider` (`createAuthWit(messageHash) -> AuthWitness`) decouples
signing from the wallet, so the signing key can live in a KMS/HSM.

- [ ] **KMS AuthWitnessProvider** -- sign via AWS KMS (or GCP Cloud KMS). Use an
      ECDSA (secp256k1) account contract; Schnorr over Grumpkin would need a
      custom KMS plugin.
- [ ] **Switch account contract** -- deploy `EcdsaKAccountContract` instead of
      `SchnorrAccountContract`. Requires a new account and a funds transfer.
- [ ] **Privacy key handling** -- nullifier/tagging/viewing keys must still
      reside in PXE memory. They do not authorize spending but reveal note
      contents. Accept, or investigate a TEE for the PXE process.

Requires the SDK to keep `AuthWitnessProvider` stable; pin the SDK and test the
signer on upgrades.

## Phase 5: Multi-Party Authorization

- [ ] **Threshold signing** -- split the signing key across N parties
      (threshold ECDSA, tss-lib). Needs a DKG ceremony and a co-signing
      coordination layer. Only justified at scale.
- [ ] **Multi-sig Noir account contract** -- N-of-M verification in `is_valid`.
      Simpler than threshold signing; M auth witnesses per tx.
- [ ] **Admin multi-sig** -- Gnosis Safe for pause, limit changes, key
      rotation. 2-of-3 minimum, 48h timelock for parameter changes.

## Not Feasible Yet

- **Trustless settlement contract** -- Aztec's cross-chain system is
  inbox/outbox message passing only; no arbitrary L1 state proof verification.
  Revisit when Aztec ships L1 storage proof primitives.
- **Full key isolation** -- privacy keys must remain in PXE memory. Only the
  signing key can be delegated; a TEE is the only mitigation.

## Research Sources

- Wormhole Governor (per-chain daily outflow caps, guardian quorum 13/19)
- Across spoke pools (bounded per-chain hot exposure, UMA optimistic oracle)
- Connext/Everclear watchers (invariant monitoring, contract-level pause)
- LayerZero RateLimiter library (per-second token flow caps at OApp layer)
- Aztec `AuthWitnessProvider`, `AccountContract`, `BaseAccount` interfaces
- Aztec `EcdsaKAccountContract` / `EcdsaRAccountContract` for KMS signing
- Aztec inbox/outbox L1<->L2 message passing (TokenPortal, FeeJuicePortal)
