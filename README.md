# @xochi-fi/pxe-bridge

JSON-RPC bridge from EVM intent solvers to Aztec shielded settlement via an
embedded PXE. The solver asks for a shielded note; the bridge proves, sends and
journals the transfer.

```
EVM Solver --JSON-RPC--> pxe-bridge --Aztec SDK--> Aztec L2 Node
                         +- Embedded PXE (private execution)
                         +- Spending-limit account (Noir, on-chain caps)
                         +- Settlement journal (SQLite)
```

Targets the Aztec 6.0.0 public testnet (L1 chain id 11155111, rollup version
679261766) through the `@aztec-labs/*` 6.0.0 SDK. Run it only against a 6.0.0
node. The note owner, randomness and recipient are private (address-derived
tagging; the recipient must `registerSender(<bridge account>)` to find its
notes); the amount and sender are public. See
[SECURITY.md](SECURITY.md#what-is-public).

## Quick start

```bash
npm install
npm run build
PXE_BRIDGE_SECRET_KEY=0x... PXE_BRIDGE_API_KEY=your-key npm start
```

Local sandbox (Anvil + Aztec 6.0.0 + bridge): `docker compose up`.

Docker (the image sets `NODE_ENV=production`, so a raw key needs
`NODE_ENV=development`; production uses `PXE_BRIDGE_SECRET_ARN`). Images are
published on semver tags only:

```bash
docker run -e NODE_ENV=development \
           -e PXE_BRIDGE_SECRET_KEY=0x... \
           -e PXE_BRIDGE_API_KEY=your-key \
           -e AZTEC_NODE_URL=http://aztec-node:8080 \
           -e PXE_BRIDGE_HOST=0.0.0.0 \
           -p 8547:8547 \
           ghcr.io/xochi-fi/pxe-bridge:<version>
```

`PXE_BRIDGE_HOST=0.0.0.0` is required in a container. The spending-limit
account needs the compiled artifact in `contracts/spending_limit_account/target/`
(CI `contract` job, or `HARDWARE_CONCURRENCY=1 aztec compile`).

The secret key must be below the BN254 Fr modulus. Generate one in range:

```bash
node -e 'const {randomBytes} = require("crypto");
const MODULUS = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
let k; do { k = randomBytes(32).toString("hex"); } while (BigInt("0x" + k) >= MODULUS);
console.log("0x" + k);'
```

## Configuration

Complete table: [CLAUDE.md](CLAUDE.md#required-environment).

| Variable | Required | Description |
| --- | --- | --- |
| `PXE_BRIDGE_SECRET_ARN` / `PXE_BRIDGE_SECRET_KEY` | One (ARN in prod) | Signing key from AWS Secrets Manager, or a raw hex key outside production |
| `PXE_BRIDGE_API_KEY` | Prod | Bearer token for RPC and `/ready` |
| `AZTEC_NODE_URL` | No | Aztec node, default `http://localhost:8080` |
| `PXE_BRIDGE_HOST` / `PXE_BRIDGE_PORT` | No | Bind address and port, default `127.0.0.1:8547` |
| `PXE_BRIDGE_JOURNAL` | Prod | SQLite settlement journal; unset refuses settlement |
| `PXE_BRIDGE_ACCOUNT_ADDRESS` | Prod | Recorded account address; startup refuses any other ([operations](docs/operations.md#account-address)) |
| `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` and related | Settlement | Spending-limit account; required for hard readiness |
| `PXE_BRIDGE_SETTLEMENT_CORRIDOR`, `PXE_BRIDGE_MAY_BROADCAST_URL` / `_TOKEN` | Settlement | Corridor and Riddler may-broadcast endpoint ([settlement](docs/settlement-operations.md#configuration)) |

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /`, `/api/rpc` | `PXE_BRIDGE_API_KEY` | JSON-RPC 2.0: `aztec_createNote`, `aztec_getSettlement`, `aztec_getVersion` |
| `POST /api/recovery` | `PXE_BRIDGE_RECOVERY_API_KEY` | `aztec_getSettlement` with reserved capacity |
| `POST /api/attestation` | `PXE_BRIDGE_ATTESTATION_API_KEY` | Signed recipient readiness records (optional; 404 when unconfigured) |
| `GET /ready` | `PXE_BRIDGE_API_KEY` | 200 admits new settlements, 503 with reasons does not |
| `GET /status` | none | Process liveness only; point container restarts here, never at `/ready` |
| `POST /admin/resume` | `PXE_BRIDGE_ADMIN_KEY` | Clear the rolling-limit circuit breaker |

`aztec_createNote` takes the `pxe-bridge.settlement.v2` payload and requires an
`Idempotency-Key` equal to its `operationId`. Contract:
[docs/settlement-operations.md](docs/settlement-operations.md).

## Documentation

- [docs/operations.md](docs/operations.md): account address, deployment
  record, fee juice, account administration, Oxide mode
- [docs/settlement-operations.md](docs/settlement-operations.md): settlement
  contract, journal, readiness, deployment, attestations
- [SECURITY.md](SECURITY.md): threat model, incident runbook, what is public
- [CLAUDE.md](CLAUDE.md): architecture and complete configuration

## License

MIT
