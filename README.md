# @xochi-fi/pxe-bridge

JSON-RPC bridge from EVM intent solvers to Aztec shielded settlement via embedded PXE.

## Overview

pxe-bridge runs a lightweight HTTP server exposing JSON-RPC methods that wrap Aztec SDK operations. It creates an EmbeddedWallet with a Schnorr account, connects to an Aztec L2 node, and provides a simple RPC interface for creating shielded notes.

```
EVM Solver --JSON-RPC--> pxe-bridge --Aztec SDK--> Aztec L2 Node
                         (this repo)
                         +- EmbeddedWallet (embedded PXE)
                         +- Schnorr Account
                         +- TokenContract calls
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

**Params:** `[{ recipient, token, amount, chainId }]`

| Field       | Type     | Description                |
| ----------- | -------- | -------------------------- |
| `recipient` | `string` | Hex Aztec address          |
| `token`     | `string` | Hex token contract address |
| `amount`    | `string` | Numeric string (wei)       |
| `chainId`   | `number` | L1 chain ID                |

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
