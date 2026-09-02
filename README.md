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

> **What "shielded" covers.** The note and its recipient are private. With the
> on-chain spending-limit account enabled, the transfer **amount is public**.
> Enforcing caps against public contract state requires putting the amount in a
> public call's arguments. The recipient is not: membership in the allowlist is
> proven in private against a Merkle root, and the public call sees only that
> root. See [SECURITY.md](SECURITY.md#what-is-public). A plain Schnorr account,
> the default, publishes neither.

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

## Fee juice

Every transaction the bridge sends is paid for in fee juice, which is bridged
in from L1 and cannot be bought, transferred or withdrawn on L2. How the bridge
gets it depends on which account it runs:

| Account | How it pays | How you fund it |
| --- | --- | --- |
| Plain Schnorr (default) | Claims during deployment | `npm run bridge-fee-juice`, then set `FEE_JUICE_CLAIM` |
| Spending limit (`PXE_BRIDGE_SPENDING_LIMIT_ADMIN`) | Pre-existing balance only | `npm run top-up-fee-juice` |

The spending-limit account cannot claim for itself. Its entrypoint admits
exactly one call and requires it to be `transfer_to_private` on the pinned
token, and every way of paying a fee adds a second call to the same payload, so
each of them is rejected by the account's own guard. Setting `FEE_JUICE_CLAIM`
alongside `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` is refused at startup rather than
failing during deployment.

### Topping up the spending-limit account

`FeeJuice.claim` names its beneficiary in an argument rather than taking the
caller, so a second account can claim on the bridge's behalf. That is what the
top-up script does: bridge from L1 to the bridge's address, wait for the L1 to
L2 message, then send the claim from a payer you control.

The bridge logs the address to fund on startup:

```
[pxe-bridge] Account address: 0x...
```

The payer must already be deployed and able to pay for one transaction. Running
the bridge once with the payer's key and **without**
`PXE_BRIDGE_SPENDING_LIMIT_ADMIN` deploys a plain Schnorr account at the address
the script derives from that key.

```bash
FEE_JUICE_RECIPIENT=0x...   \
FEE_JUICE_PAYER_KEY=0x...   \
L1_PRIVATE_KEY=0x...        \
AZTEC_NODE_URL=http://localhost:8080 \
L1_RPC_URL=https://... L1_CHAIN_ID=1 \
BRIDGE_AMOUNT=1000000000000000000 \
npm run top-up-fee-juice
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FEE_JUICE_RECIPIENT` | Yes | -- | Aztec address to credit |
| `FEE_JUICE_PAYER_KEY` | Yes | -- | Secret key of the account that sends the claim |
| `L1_PRIVATE_KEY` | Yes | -- | Ethereum key holding the Fee Juice ERC20 |
| `AZTEC_NODE_URL` | No | `http://localhost:8080` | Aztec node |
| `L1_RPC_URL` | No | `http://localhost:8545` | Ethereum RPC |
| `L1_CHAIN_ID` | No | Anvil's | Required for any L1 other than the sandbox |
| `BRIDGE_AMOUNT` | No | `1e18` | Fee juice in wei |
| `FEE_JUICE_PAYER_SPONSORED` | No | -- | `true` pays via SponsoredFPC; sandbox and testnet only |

There is nothing to set on the bridge afterwards. The balance is on chain, and
the account finds it on its next transaction.

Getting `FEE_JUICE_RECIPIENT` wrong is not recoverable: the L1 to L2 message
commits to the recipient it was built with, and FeeJuice has no transfer, so
juice credited to the wrong address stays there. The script checks the address
shape before it writes to L1, which catches a truncated paste but not a
well-formed wrong address.

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

### Idempotency

Send an `Idempotency-Key` header to make retries safe:

```
Idempotency-Key: 0x9f2c..-0
```

Any later request with the same key replays the first one's response instead of
transferring again, including the "submitted, result unknown" case above. That
is the point: the ambiguous error stays ambiguous rather than being resolved by
sending a second transfer.

- Use one key per settlement. `(tradeId, subTradeIndex)` is a natural choice,
  but the bridge does not require trade context and does not inspect the key.
- 1 to 128 printable ASCII characters. A malformed key is a `400`, never
  cleaned up: a key silently altered would stop matching the one you retry
  with.
- A duplicate arriving while the first is still running gets an error saying
  so, not a second transfer.
- Keys are remembered for 24 hours and survive a restart when
  `PXE_BRIDGE_AUDIT_LOG` is a file path. Without it they are in-memory only.
- A request that definitively moved nothing -- rejected by the limits, or
  failed before submission -- **frees** its key, so retrying with it is
  allowed. This differs from Stripe, where a recorded error replays forever.
  The key guards against repeating a transfer, and there is no transfer to
  repeat.

Requests without the header behave exactly as before: every one executes.

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
