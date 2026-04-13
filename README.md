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

| Variable | Required | Default | Description |
|---|---|---|---|
| `PXE_BRIDGE_SECRET_KEY` | Yes | -- | Hex key for Schnorr account derivation |
| `AZTEC_NODE_URL` | No | `http://localhost:8080` | Aztec L2 node RPC endpoint |
| `PXE_BRIDGE_PORT` | No | `8547` | HTTP listen port |

### Docker

```bash
docker run -e PXE_BRIDGE_SECRET_KEY=0x... \
           -e AZTEC_NODE_URL=http://aztec-node:8080 \
           -p 8547:8547 \
           ghcr.io/xochi-fi/pxe-bridge:0.1.0
```

### From Source

```bash
npm install
npm run build
PXE_BRIDGE_SECRET_KEY=0x... npm start
```

## API Reference

All methods use JSON-RPC 2.0 over HTTP POST to `/` or `/api/rpc`.

### `aztec_createNote`

Create a shielded note on Aztec L2.

**Params:** `[{ recipient, token, amount, chainId }]`

| Field | Type | Description |
|---|---|---|
| `recipient` | `string` | Hex Aztec address |
| `token` | `string` | Hex token contract address |
| `amount` | `string` | Numeric string (wei) |
| `chainId` | `number` | L1 chain ID |

**Returns:** `{ noteCommitment, nullifierHash, l2TxHash }`

### `aztec_getVersion`

Returns the connected Aztec node version string.

### Health Check

`GET /status` returns `{ status: "ok", version }` (200) or `{ status: "starting" }` (503).

## License

MIT
