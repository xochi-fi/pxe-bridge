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
| `PXE_BRIDGE_SECRET_KEY` | Yes      | --                      | 32-byte hex key, below the BN254 Fr modulus    |
| `PXE_BRIDGE_API_KEY`    | No       | --                      | Bearer token for RPC auth (warns if unset)     |
| `PXE_BRIDGE_ADMIN_KEY`  | No       | --                      | Bearer token for `POST /admin/resume`          |
| `AZTEC_NODE_URL`        | No       | `http://localhost:8080` | Aztec L2 node RPC endpoint                     |
| `PXE_BRIDGE_HOST`       | No       | `127.0.0.1`             | Bind address (localhost-only by default)       |
| `PXE_BRIDGE_PORT`       | No       | `8547`                  | HTTP listen port (0-65535)                     |

The secret key is a BN254 scalar, not an arbitrary 32 bytes. About 81% of
random 32-byte values are at or above the field modulus and are rejected at
startup, so generate one by retrying until it is in range:

```bash
node -e 'const {randomBytes} = require("crypto");
const MODULUS = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
let k; do { k = randomBytes(32).toString("hex"); } while (BigInt("0x" + k) >= MODULUS);
console.log("0x" + k);'
```

### Docker

```bash
docker run -e PXE_BRIDGE_SECRET_KEY=0x... \
           -e PXE_BRIDGE_API_KEY=your-secret-key \
           -e AZTEC_NODE_URL=http://aztec-node:8080 \
           -e PXE_BRIDGE_HOST=0.0.0.0 \
           -p 8547:8547 \
           ghcr.io/xochi-fi/pxe-bridge:0.1.0
```

`PXE_BRIDGE_HOST=0.0.0.0` is required in a container: the default `127.0.0.1`
binds inside the container and the published port reaches nothing.

The image sets `NODE_ENV=production`, under which `PXE_BRIDGE_SECRET_KEY` is
rejected and `PXE_BRIDGE_SECRET_ARN` is required. Pass `NODE_ENV=development`
to use a raw key, which is what `docker-compose.yml` does.

Building the image locally does not require the compiled Noir artifact. An
image without it runs the default Schnorr configuration; enabling
`PXE_BRIDGE_SPENDING_LIMIT_ADMIN` needs the artifact under
`contracts/spending_limit_account/target/`, built by the CI `contract` job or
by `aztec compile` on an x86 host.

### Local sandbox

```bash
docker compose up          # anvil + aztec sandbox + bridge
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

**Returns:** `{ noteHashes, nullifiers, l2TxHash, noteCommitment, nullifierHash }`

| Field            | Type       | Description                                                        |
| ---------------- | ---------- | ------------------------------------------------------------------ |
| `noteHashes`     | `string[]` | Every note hash the transaction emitted, in emission order          |
| `nullifiers`     | `string[]` | Every nullifier the transaction emitted, in emission order          |
| `l2TxHash`       | `string`   | Transaction hash on L2                                              |
| `noteCommitment` | `string`   | Deprecated. `noteHashes[0]`                                         |
| `nullifierHash`  | `string`   | Deprecated. `nullifiers[0]`, the protocol nullifier                 |

A `transfer_to_private` emits two note hashes and three nullifiers, so no single
value identifies the note. `nullifiers[0]` in particular is the protocol
(transaction) nullifier, not a note's: the transfer spends the public balance
and nullifies no note. The two scalar fields are the historical shape and are
retained so existing callers keep parsing; read the arrays and pick
deliberately.

**Errors:** most failures mean nothing happened and are safe to retry. One is
not. When the send deadline expires, or the transfer succeeds and only reading
its effects back fails, the response is:

```json
{ "code": -32603,
  "message": "Transaction submitted, result unknown -- do not retry without reconciling",
  "data": { "txHash": "0x..." } }
```

The transfer may be on L2. Look up `data.txHash` before deciding; a blind retry
sends a second transfer. The bridge counts the amount against its daily window
in this case, on the assumption that it landed. `data` is absent when no hash
was obtained, which is the deadline case.

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
