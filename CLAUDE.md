# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JSON-RPC bridge that connects EVM intent solvers to Aztec L2 shielded settlement. Runs an HTTP server wrapping Aztec SDK operations via an embedded PXE wallet. Supports both standard Schnorr accounts and a custom spending-limit account contract (Noir) with on-chain per-tx caps, daily volume limits, recipient allowlist, and timelocked admin.

```
EVM Solver --JSON-RPC--> pxe-bridge --Aztec SDK--> Aztec L2 Node
```

## Commands

```bash
npm install              # install dependencies
npm run build            # tsc compile to dist/
npm run typecheck        # tsc --noEmit for src/ and (via tsconfig.test.json) tests/
npm test                 # vitest run (unit + integration)
npm run test:watch       # vitest in watch mode
npm run test:coverage    # vitest with v8 coverage
npm run test:e2e         # e2e tests (requires running Aztec sandbox)
npm run test:e2e:up      # docker compose up, run e2e, compose down
npm run dev              # run with tsx (no build step)
npm start                # run compiled dist/index.js
```

CI runs `typecheck` -> `test` -> `build`, then a separate `e2e` job via docker compose.

## E2E Tests

E2e tests (`tests/e2e/`) run against a real Aztec sandbox node via `docker-compose.yml` (Anvil L1 + Aztec node). The `globalSetup` auto-starts compose if `AZTEC_NODE_URL` is not set.

The Aztec sandbox requires native x86_64 -- barretenberg's ZK prover crashes under ARM emulation (SIGILL). E2e tests work on CI (ubuntu x86_64) but not on Apple Silicon Macs.

## Required Environment

| Variable                          | Required | Default                 | Description                                                                                             |
| --------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `PXE_BRIDGE_SECRET_KEY`           | Dev only | --                      | 32-byte hex key, must be below the BN254 Fr modulus (rejected when NODE_ENV=production)                 |
| `PXE_BRIDGE_SECRET_ARN`           | Prod     | --                      | AWS Secrets Manager ARN/name for secret key                                                             |
| `PXE_BRIDGE_API_KEY`              | No       | --                      | Bearer token for RPC auth (warns if unset)                                                              |
| `PXE_BRIDGE_ADMIN_KEY`            | No       | --                      | Bearer token for `POST /admin/resume`. Separate from the RPC key so a caller who can move funds cannot clear the breaker that stopped them. Unset makes the endpoint 404 |
| `AZTEC_NODE_URL`                  | No       | `http://localhost:8080` | Aztec L2 node endpoint                                                                                  |
| `PXE_BRIDGE_HOST`                 | No       | `127.0.0.1`             | Bind address (localhost-only by default)                                                                |
| `PXE_BRIDGE_PORT`                 | No       | `8547`                  | HTTP listen port (validated 0-65535)                                                                    |
| `FEE_JUICE_CLAIM`                 | No       | --                      | JSON: `{claimAmount, claimSecret, messageLeafIndex}` for L1->L2 bridged deployment fee                  |
| `PXE_BRIDGE_MAX_AMOUNT`           | No       | --                      | Per-tx amount ceiling (rejects above this)                                                              |
| `PXE_BRIDGE_DAILY_LIMIT`          | No       | --                      | 24h rolling volume cap; circuit-breaker pauses bridge                                                   |
| `PXE_BRIDGE_COOLDOWN_THRESHOLD`   | No       | --                      | Amount threshold triggering cooldown delay                                                              |
| `PXE_BRIDGE_COOLDOWN_DELAY_MS`    | No       | --                      | Delay in ms for amounts >= cooldown threshold                                                           |
| `PXE_BRIDGE_AUDIT_LOG`            | No       | stdout                  | File path for JSON-lines audit log. Also the durable store for the 24h volume window: set to a path, or the window resets on every restart |
| `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` | No       | --                      | AztecAddress (32-byte hex) enabling on-chain spending limit account. Requires `PXE_BRIDGE_MAX_AMOUNT` and `PXE_BRIDGE_DAILY_LIMIT`, since the contract rejects a zero limit |
| `PXE_BRIDGE_SPENDING_LIMIT_TOKEN` | With admin | --                    | AztecAddress (32-byte hex) of the single token the account may move. Fixed at construction, no setter; required when the admin is set |
| `PXE_BRIDGE_SPENDING_LIMIT_SEED_RECIPIENT` | With admin | --           | AztecAddress (32-byte hex) written to allowlist slot 0 at construction. Without it the allowlist is empty and additions wait out the 24h timelock |
| `PXE_BRIDGE_SPENDING_LIMIT_MIN_ANONYMITY` | No | `1` | Allowlist slots a transfer must carry, so the recipient is one of at least N. 1 means no floor. Stored on-chain, changed only via the limits timelock; raise it as the allowlist grows |

## Architecture

Nine TypeScript source files plus a Noir contract, no framework -- plain `node:http` server with zod validation:

- **`index.ts`** -- Entrypoint: reads env, resolves secret key (via `secrets.ts`), validates port range, warns if API key unset, constructs spending limit config if admin address is set, creates `AztecClient`, starts server bound to `PXE_BRIDGE_HOST`.
- **`secrets.ts`** -- Secret key resolution: AWS Secrets Manager fetch (via `PXE_BRIDGE_SECRET_ARN`) or env var fallback (`PXE_BRIDGE_SECRET_KEY`, dev only). Rejects env var when `NODE_ENV=production`. Supports plain hex and JSON `{"key":"..."}` secret formats. Validates the key is 32 bytes and below the BN254 Fr modulus; roughly 81% of random 32-byte values are not, so this rejects at startup with a named cause rather than deep in the SDK at connect time.
- **`server.ts`** -- HTTP server factory (`createApp(client, opts?)`). Auth (Bearer token, constant-time compare), Content-Type enforcement (CSRF defense), rate limiting (60 req/min sliding window), body size limit (64KB), request timeout (30s). Also serves `POST /admin/resume`, gated on `PXE_BRIDGE_ADMIN_KEY` and 404 when that is unset. Accepts `IAztecClient` interface for testability.
- **`rpc.ts`** -- JSON-RPC 2.0 dispatch. Method switch: `aztec_createNote` -> `handleCreateNote`, `aztec_getVersion` -> `handleGetVersion`. Sanitizes internal errors before returning to caller. Uses `null` id for invalid envelopes per spec. A `PostSubmissionError` commits the reservation rather than releasing it, and answers with a distinct message plus `error.data.txHash`: the transfer may be on chain, so the caller must reconcile rather than retry.
- **`aztec-client.ts`** -- `AztecClient` class implementing `IAztecClient`, wrapping Aztec SDK v5. Creates `EmbeddedWallet`, derives account from secret key (SHA-256 domain-separated salt, reduced into the BN254 field -- a raw digest exceeds the modulus ~81% of the time). When `spendingLimitConfig` is provided, creates a `SpendingLimitAccountContract` via `AccountManager.create()`, registers artifact with PXE, stores in WalletDB, and patches `getAccountFromAddress` for tx routing; otherwise uses standard Schnorr account. Deploys account contract on first connect, caches `TokenContract` instances (capped at 100). Refreshes the allowlist hint on the contract before each `createNote` when spending limits are active; the declared amount and recipient are not set here, since the entrypoint reads them off the payload it signs. Account deploys carry `DEPLOY_FEE_HEADROOM` over the worst predicted base fee. Secret key zeroed from memory after connect. Transaction timeout of 120s.
- **`types.ts`** -- Zod schemas, TypeScript types, `IAztecClient`, and `PostSubmissionError` (here, not in `aztec-client.ts`, so `rpc.ts` can narrow on it without importing the Aztec SDK). `CreateNoteResult` returns `noteHashes`/`nullifiers` in full; the scalar `noteCommitment`/`nullifierHash` are deprecated aliases for index 0, since a `transfer_to_private` emits two note hashes and three nullifiers and `nullifiers[0]` is the protocol nullifier. Addresses validated as 32-byte hex (64 chars). Amounts validated as non-negative integers without leading zeros, capped at 78 digits (uint256 max). Includes optional XIP-1 trade context fields (`tradeId`, `subTradeIndex`, `totalSubTrades`) -- all three must be provided together or all omitted.
- **`limits.ts`** -- `TransactionLimits` class: per-tx ceiling (`PXE_BRIDGE_MAX_AMOUNT`), 24h rolling volume cap with circuit-breaker (`PXE_BRIDGE_DAILY_LIMIT`), configurable cooldown delay for large transfers. Checked before every `createNote`. Application-level defense-in-depth; on-chain limits (Phase 2) enforce independently. The breaker trips only when committed volume reaches the cap; a single request larger than the remaining budget is rejected on its own, since tripping there let one oversized request stop the bridge for a full window. `restore()` seeds the window from the audit log at startup.
- **`audit.ts`** -- `AuditLogger` class: JSON-lines structured logging of every `createNote` call (success, rejected, error). Writes to file (`PXE_BRIDGE_AUDIT_LOG`) or stdout with `[audit]` prefix. `readRecentSpends()` replays the successful entries back into `TransactionLimits` on boot, so the rolling window survives a restart; it tolerates a truncated final line rather than refusing to start.
- **`spending-limit-account.ts`** -- Custom Aztec account contract TypeScript wrapper. `SpendingLimitAccountContract` implements `AccountContract` with a custom entrypoint that includes declared amount/recipient in the signed hash via `poseidon2HashWithSeparator`. The entrypoint derives those two values from the `transfer_to_private` call in the payload it is signing, so declared == actual holds by construction and there is no per-call state for a concurrent send to overwrite. Only the allowlist hint is pushed in, via `setAllowlistHint()`, because it is a snapshot of on-chain state the payload cannot supply; it lives on the contract rather than an entrypoint instance, since `getAccount()` is called afresh on every wallet resolution and is not memoized, so per-instance state is written to an orphan while a sibling entrypoint signs. Sharing one hint across concurrent sends is safe: it is unsigned and revalidated positionally against live storage at inclusion time. Used with the Noir contract in `contracts/spending_limit_account/`.
- **`contracts/spending_limit_account/`** -- Noir account contract (compiled with `aztec compile`, not `aztec-nargo compile` -- the latter is a symlink to plain `nargo`, ships no transpiler, and emits `transpiled: false`, which `loadContractArtifact` rejects). Extends Schnorr with `check_spending_public`: per-tx cap, 25-bucket sliding daily window, recipient allowlist bound by hint masking, single permitted token, timelocked `propose_limits`/`apply_limits`. Admin levers follow one asymmetry throughout: tightening waits out the 24h timelock, loosening and stopping are immediate. `pause`/`unpause` is the emergency stop against a compromised signing key, checked in `check_spending_public` so it bites at inclusion time; `lower_min_anonymity` is the untimelocked way out of a floor that exceeds the live allowlist, which `remove_recipient` can cause and is deliberately not blocked from causing. Artifact is built into `target/` by the `contract` CI job and gitignored, not committed. Must match Aztec SDK version (currently v5.1.0, set in `Nargo.toml`).

## Security

- Binds to `127.0.0.1` by default -- set `PXE_BRIDGE_HOST=0.0.0.0` only behind a reverse proxy
- API key auth via `Authorization: Bearer <key>` -- required for production
- `Content-Type: application/json` required on POST (blocks browser CSRF without CORS headers)
- Secret key fetched from AWS Secrets Manager in production (env var rejected)
- Secret key zeroed from memory after wallet derivation
- On-chain spending limits via custom Noir account contract (per-tx cap, daily volume, recipient allowlist, timelocked admin)
- Rate limiting: 60 RPC requests/min sliding window
- Response headers: `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`
- Docker: runs as non-root (`USER node`), `npm ci` for reproducible builds, source maps stripped

## Key Details

- ESM-only (`"type": "module"`), all imports use `.js` extension
- Strict tsconfig: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- Aztec SDK v5.1.0 -- dynamic imports for `@aztec/aztec.js/fields` and `@aztec/aztec.js/addresses` inside methods (tree-shaking friendly)
- Docker image requires trixie's libstdc++ for `@aztec/bb.js` GLIBCXX_3.4.32
- CI pushes to `ghcr.io/xochi-fi/pxe-bridge` on semver tags only
