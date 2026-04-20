# @xochi-fi/pxe-bridge

JSON-RPC bridge from EVM intent solvers to Aztec shielded settlement via embedded PXE.

## What is PXE?

PXE (Private eXecution Environment) is an Aztec-specific runtime that executes the private half of transactions locally on your machine, not on the network.

On Ethereum, all execution happens on-chain: every node re-runs your transaction, and everyone sees the inputs. On Aztec, transactions split into a private phase (runs locally in the PXE) and a public phase (runs on the network). The PXE:

- **Holds private keys and encrypted notes.** Aztec uses a UTXO-like note model. Balances are encrypted notes that only the owner's PXE can decrypt and spend.
- **Executes private functions locally.** Contract logic that touches private state runs inside the PXE, producing a zero-knowledge proof that the execution was correct without revealing the inputs.
- **Submits proofs to the network.** The Aztec node receives the proof and encrypted outputs, never the plaintext data.

This is fundamentally different from EVM execution. There is no global state that every validator reads. Private state exists only inside the PXE that owns it.

## Why pxe-bridge?

EVM intent solvers speak JSON-RPC and have no concept of private execution, PXEs, or encrypted notes. They can't create shielded positions on Aztec directly.

pxe-bridge embeds a PXE wallet and wraps it in a JSON-RPC interface that solvers already understand. When a solver says "create a shielded note for this token," the bridge handles private execution, proof generation, and note encryption transparently. The solver gets back a transaction hash.

```
EVM Solver --JSON-RPC--> pxe-bridge --Aztec SDK--> Aztec L2 Node
                         (this repo)
                         +- Embedded PXE (private execution)
                         +- Schnorr Account (key management)
                         +- TokenContract calls (note creation)
```

## Quick Start

### Environment Variables

| Variable                | Required | Default                 | Description                                    |
| ----------------------- | -------- | ----------------------- | ---------------------------------------------- |
| `PXE_BRIDGE_SECRET_KEY` | Yes      | --                      | 32-byte hex key for Schnorr account derivation |
| `PXE_BRIDGE_API_KEY`    | No       | --                      | Bearer token for RPC auth (warns if unset)     |
| `AZTEC_NODE_URL`        | No       | `http://localhost:8080` | Aztec L2 node RPC endpoint                     |
| `PXE_BRIDGE_HOST`       | No       | `127.0.0.1`             | Bind address (localhost-only by default)       |
| `PXE_BRIDGE_PORT`       | No       | `8547`                  | HTTP listen port (0-65535)                     |

### Docker

```bash
docker run -e PXE_BRIDGE_SECRET_KEY=0x... \
           -e PXE_BRIDGE_API_KEY=your-secret-key \
           -e AZTEC_NODE_URL=http://aztec-node:8080 \
           -e PXE_BRIDGE_HOST=0.0.0.0 \
           -p 8547:8547 \
           ghcr.io/xochi-fi/pxe-bridge:0.1.0
```

### From Source

```bash
npm install
npm run build
PXE_BRIDGE_SECRET_KEY=0x... PXE_BRIDGE_API_KEY=your-key npm start
```

## API Reference

All methods use JSON-RPC 2.0 over HTTP POST to `/` or `/api/rpc`. Requests require `Content-Type: application/json`. When `PXE_BRIDGE_API_KEY` is set, include `Authorization: Bearer <key>`.

### `aztec_createNote`

Create a shielded note on Aztec L2.

**Params:** `[{ recipient, token, amount, chainId, tradeId?, subTradeIndex?, totalSubTrades? }]`

| Field            | Type     | Description                                 |
| ---------------- | -------- | ------------------------------------------- |
| `recipient`      | `string` | Hex Aztec address                           |
| `token`          | `string` | Hex token contract address                  |
| `amount`         | `string` | Numeric string (wei)                        |
| `chainId`        | `number` | L1 chain ID                                 |
| `tradeId`        | `string` | (Optional) XIP-1 trade identifier (bytes32) |
| `subTradeIndex`  | `number` | (Optional) Sub-trade index within the split |
| `totalSubTrades` | `number` | (Optional) Total sub-trades in the split    |

Trade context fields (`tradeId`, `subTradeIndex`, `totalSubTrades`) must be provided together or all omitted. When present, the note is tagged with settlement splitting metadata for SettlementRegistry finalization. Backwards compatible -- existing callers are unaffected.

**Returns:** `{ noteCommitment, nullifierHash, l2TxHash }`

### `aztec_getVersion`

Returns the connected Aztec node version string.

### Health Check

`GET /status` returns `{ status: "ok", version }` (200) or `{ status: "starting" }` (503).

## Security

- Binds to `127.0.0.1` by default -- set `PXE_BRIDGE_HOST=0.0.0.0` only behind a reverse proxy
- Set `PXE_BRIDGE_API_KEY` for production -- without it, anyone with network access can create notes
- `Content-Type: application/json` required on POST requests (prevents browser CSRF)
- Rate limited to 60 RPC requests/min
- Secret key zeroed from memory after wallet derivation
- Docker image runs as non-root user

## License

MIT
