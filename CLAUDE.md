# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JSON-RPC bridge that connects EVM intent solvers to Aztec L2 shielded settlement. Runs an HTTP server wrapping Aztec SDK operations via an embedded PXE wallet with a Schnorr account.

```
EVM Solver --JSON-RPC--> pxe-bridge --Aztec SDK--> Aztec L2 Node
```

## Commands

```bash
npm install              # install dependencies
npm run build            # tsc compile to dist/
npm run typecheck        # tsc --noEmit
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

| Variable                | Required | Default                 | Description                                    |
| ----------------------- | -------- | ----------------------- | ---------------------------------------------- |
| `PXE_BRIDGE_SECRET_KEY` | Dev only | --                      | 32-byte hex key (rejected when NODE_ENV=production) |
| `PXE_BRIDGE_SECRET_ARN` | Prod     | --                      | AWS Secrets Manager ARN/name for secret key    |
| `PXE_BRIDGE_API_KEY`    | No       | --                      | Bearer token for RPC auth (warns if unset)     |
| `AZTEC_NODE_URL`        | No       | `http://localhost:8080` | Aztec L2 node endpoint                         |
| `PXE_BRIDGE_HOST`       | No       | `127.0.0.1`             | Bind address (localhost-only by default)       |
| `PXE_BRIDGE_PORT`       | No       | `8547`                  | HTTP listen port (validated 0-65535)           |
| `FEE_JUICE_CLAIM`       | No       | --                      | JSON: `{claimAmount, claimSecret, messageLeafIndex}` for L1->L2 bridged deployment fee |
| `PXE_BRIDGE_MAX_AMOUNT` | No      | --                      | Per-tx amount ceiling (rejects above this)            |
| `PXE_BRIDGE_DAILY_LIMIT`| No      | --                      | 24h rolling volume cap; circuit-breaker pauses bridge |
| `PXE_BRIDGE_COOLDOWN_THRESHOLD` | No | --                  | Amount threshold triggering cooldown delay            |
| `PXE_BRIDGE_COOLDOWN_DELAY_MS`  | No | --                  | Delay in ms for amounts >= cooldown threshold         |
| `PXE_BRIDGE_AUDIT_LOG`  | No      | stdout                  | File path for JSON-lines audit log                    |
| `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` | No | --               | AztecAddress (32-byte hex) enabling on-chain spending limit account; uses MAX_AMOUNT/DAILY_LIMIT values |

## Architecture

Nine source files, no framework -- plain `node:http` server with zod validation:

- **`index.ts`** -- Entrypoint: reads env, resolves secret key (via `secrets.ts`), validates port range, warns if API key unset, creates `AztecClient`, starts server bound to `PXE_BRIDGE_HOST`.
- **`secrets.ts`** -- Secret key resolution: AWS Secrets Manager fetch (via `PXE_BRIDGE_SECRET_ARN`) or env var fallback (`PXE_BRIDGE_SECRET_KEY`, dev only). Rejects env var when `NODE_ENV=production`. Supports plain hex and JSON `{"key":"..."}` secret formats.
- **`server.ts`** -- HTTP server factory (`createApp(client, opts?)`). Auth (Bearer token, constant-time compare), Content-Type enforcement (CSRF defense), rate limiting (60 req/min sliding window), body size limit (64KB), request timeout (30s). Accepts `IAztecClient` interface for testability.
- **`rpc.ts`** -- JSON-RPC 2.0 dispatch. Method switch: `aztec_createNote` -> `handleCreateNote`, `aztec_getVersion` -> `handleGetVersion`. Sanitizes internal errors before returning to caller. Uses `null` id for invalid envelopes per spec.
- **`aztec-client.ts`** -- `AztecClient` class implementing `IAztecClient`, wrapping Aztec SDK v4. Creates `EmbeddedWallet`, derives Schnorr account from secret key (SHA-256 domain-separated salt), deploys account contract on first connect, caches `TokenContract` instances (capped at 100). Secret key zeroed from memory after connect. Transaction timeout of 120s.
- **`types.ts`** -- Zod schemas, TypeScript types, and `IAztecClient` interface. Addresses validated as 32-byte hex (64 chars). Amounts validated as non-negative integers without leading zeros, capped at 78 digits (uint256 max). Includes optional XIP-1 trade context fields (`tradeId`, `subTradeIndex`, `totalSubTrades`) -- all three must be provided together or all omitted.
- **`limits.ts`** -- `TransactionLimits` class: per-tx ceiling (`PXE_BRIDGE_MAX_AMOUNT`), 24h rolling volume cap with circuit-breaker (`PXE_BRIDGE_DAILY_LIMIT`), configurable cooldown delay for large transfers. Checked before every `createNote`.
- **`audit.ts`** -- `AuditLogger` class: JSON-lines structured logging of every `createNote` call (success, rejected, error). Writes to file (`PXE_BRIDGE_AUDIT_LOG`) or stdout with `[audit]` prefix.
- **`spending-limit-account.ts`** -- Custom Aztec account contract TypeScript wrapper. `SpendingLimitAccountContract` implements `AccountContract` with a custom entrypoint that includes declared amount/recipient in the signed hash. Used with the Noir contract in `contracts/spending_limit_account/` for on-chain spending limits, recipient allowlist, and timelocked parameter changes. Requires `nargo compile` to produce the artifact before use.

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
- Aztec SDK v4.1.3 -- dynamic imports for `@aztec/aztec.js/fields` and `@aztec/aztec.js/addresses` inside methods (tree-shaking friendly)
- Docker image requires trixie's libstdc++ for `@aztec/bb.js` GLIBCXX_3.4.32
- CI pushes to `ghcr.io/xochi-fi/pxe-bridge` on semver tags only
