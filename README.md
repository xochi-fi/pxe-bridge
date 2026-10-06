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

| Account | Deployment fee | Later transactions | How you fund it |
| --- | --- | --- | --- |
| Plain Schnorr (default) | `FEE_JUICE_CLAIM`, else SponsoredFPC | Own balance | `npm run bridge-fee-juice -- --recipient <Account address>`, then set `FEE_JUICE_CLAIM` |
| Spending limit (`PXE_BRIDGE_SPENDING_LIMIT_ADMIN`) | `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM`, via the deployer, else SponsoredFPC | Pre-existing balance only | `npm run bridge-fee-juice -- --deployer --recipient <Deployer address>` to deploy, `npm run top-up-fee-juice` to run |

The spending-limit account cannot claim for itself. Its entrypoint admits
exactly one call and requires it to be `transfer_to_private` on the pinned
token, and every way of paying a fee adds a second call to the same payload, so
each of them is rejected by the account's own guard. Setting `FEE_JUICE_CLAIM`
alongside `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` is refused at startup rather than
failing during deployment.

### Deployment fee and SponsoredFPC

An account the node does not know yet is deployed on first start, and that
deployment needs a fee. A plain Schnorr account pays it from `FEE_JUICE_CLAIM`
when one is set. Otherwise the bridge falls back to SponsoredFPC, a testing
contract that pays anyone's fee and exists only on sandbox and testnet.

The spending-limit account cannot deploy itself (its guard rejects the
deployment payload), so the bridge first deploys a plain Schnorr **deployer**
account and sends the deployment from it. The deployer is derived from the same
secret key under the account salt plus one, so it needs no key material of its
own and lands at the same address on every restart. Its address is logged as
`Deployer address: 0x...` whenever the account still needs deploying.

With `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM` set, the deployer deploys itself
with that claim and then pays for the spending-limit account's deployment out
of what is left: the deployment is sent from the deployer with no fee payment
method, so the deployer pays from its own fee juice balance. The claim has to be
bridged to the deployer, not to the account (`npm run bridge-fee-juice --
--deployer --recipient <Deployer address>`), and is refused without
`PXE_BRIDGE_SPENDING_LIMIT_ADMIN`. Without it, a deployer that already holds
fee juice pays both deployments from that balance; one that holds none falls
back to SponsoredFPC for both. If the claim is already spent while the deployer is not yet
deployed, the deployer deploys itself from the balance the claim credited; with
no balance left, startup fails naming the spent claim before sending anything.

The fallback is refused when `NODE_ENV=production`, which the image sets,
unless `PXE_BRIDGE_ALLOW_SPONSORED_FPC=true`. `false` refuses it in any
environment, and any other value is rejected at startup. Startup logs which way
it is set. When refused, an undeployed account stops the bridge during startup
with an error naming the account and this variable, before anything is sent,
rather than failing inside the deployment. An account that is already deployed
(initialized on chain, published or not, as v0.1.2 left it) needs no deployment
fee and starts either way.

Set `PXE_BRIDGE_ALLOW_SPONSORED_FPC=true` only when the node is a sandbox or
testnet.

### Deploying the spending-limit account in production

1. **Get the deployer address.** Start the bridge once with the
   spending-limit configuration and no claim. It logs
   `[pxe-bridge] Account address: 0x...` and `[pxe-bridge] Deployer address: 0x...`,
   then stops at the SponsoredFPC refusal before sending anything. Both
   addresses are public; the key stays in Secrets Manager.

2. **Bridge fee juice to it.**

   ```bash
   L1_PRIVATE_KEY=0x... L1_RPC_URL=https://... L1_CHAIN_ID=1 \
   AZTEC_NODE_URL=https://... BRIDGE_AMOUNT=... \
     npm run bridge-fee-juice -- --deployer --recipient <Deployer address>
   ```

   Before any L1 write it writes the claim secret, its hash, the starting L1
   block and the L1 sender to `fee-juice-deposit-<secretHash>.json` in the
   working directory (mode 0600), and prints a `--recover` command naming it.
   The file is deleted once the claim is printed. A hangup exits the run
   rather than killing it mid-write. If the run dies before the claim is
   printed (timeout, signal, crash), the deposit may still land: run that
   command from the same directory, with the same `AZTEC_NODE_URL` and
   `L1_RPC_URL`, instead of this step. It finds the deposit on L1, prints the
   claim and waits, without depositing:

   ```bash
   L1_RPC_URL=https://... AZTEC_NODE_URL=https://... \
     npm run bridge-fee-juice -- --deployer --recipient <Deployer address> \
       --recover fee-juice-deposit-<secretHash>.json
   ```

   `--recover <secretHash>` finds the same file in the working directory, or
   without one takes `FEE_JUICE_CLAIM_SECRET`, `FEE_JUICE_RECOVER_FROM_BLOCK`
   and `BRIDGE_AMOUNT`. When the deposit is not on L1, recovery from the file
   reads the L1 sender's nonces: a transaction still pending at that RPC can
   land, so recover again once it is mined; none pending means the deposit
   was never sent or was dropped, and bridging anew is safe.

   As soon as the L1 deposit lands it prints
   `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM='{...}'` and the L1 to L2 message
   hash, then waits until the message has synced and says so. Start the bridge
   only after that, or its first deployment fails with "No L1 to L2 message
   found". If the wait times out, **do not run this step again**: the deposit is
   done and a second run deposits again. Resume the wait instead:

   ```bash
   AZTEC_NODE_URL=https://... npm run bridge-fee-juice -- --wait <messageHash>
   ```

   One claim pays for both deployments and for top-up claims sent from the
   deployer (step 4), so size it for all of them (see below).

3. **Start the bridge** with the spending-limit configuration and
   `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM`. It deploys the deployer, then the
   account, and logs `Ready` without touching SponsoredFPC. Once the account is
   deployed the claim is spent and the variable can be removed; a restart finds
   the account on chain and needs no deployment fee. If the deployer is already
   deployed but its balance cannot cover the account deployment, bridge a fresh
   claim to the deployer (step 2) and restart with that one.

4. **Top up the spending-limit account** at the logged `Account address`, paying
   from the deployer:

   ```bash
   FEE_JUICE_RECIPIENT=<Account address> FEE_JUICE_PAYER_DEPLOYER=true \
   PXE_BRIDGE_SECRET_ARN=... NODE_ENV=production \
   L1_PRIVATE_KEY=0x... L1_RPC_URL=https://... L1_CHAIN_ID=1 \
   AZTEC_NODE_URL=https://... BRIDGE_AMOUNT=... \
     npm run top-up-fee-juice
   ```

   The account's transfers pay from that balance, not the deployer's. The
   deployer's key is the bridge's, so this step reads it from Secrets Manager
   into the script's memory, not its environment. The wallet stores holding it
   are created under `os.tmpdir()` and deleted on exit, SIGINT, SIGTERM and SIGHUP;
   SIGKILL or a crash leaves them. To keep it
   off the operator's machine, use a separate payer instead (next section).

The node admits a transaction only if its fee payer's balance covers the fee
limit, `gasLimits x maxFeesPerGas`, while what is charged is the gas actually
used at the base fee of inclusion. The bridge sets `maxFeesPerGas` to 10x the
worst predicted base fee, so the deployer claim must cover the deployer's own
fee, plus the full fee limit of the account deployment, which publishes the
account's contract class and is the expensive one, plus the fee limit of every
top-up claim the deployer is to send. The unspent remainder stays with the
deployer, which cannot transfer it; it is spendable only on the deployer's own
transactions, i.e. top-up claims.

When the deployer runs low, it can be refilled like any other account:
`npm run top-up-fee-juice` with `FEE_JUICE_RECIPIENT` set to the deployer
address, paid by a payer that still has balance.

### Topping up the spending-limit account

`FeeJuice.claim` names its beneficiary in an argument rather than taking the
caller, so a second account can claim on the bridge's behalf. That is what the
top-up script does: bridge from L1 to the bridge's address, wait for the L1 to
L2 message, then send the claim from a payer you control.

The bridge logs the address to fund on startup:

```
[pxe-bridge] Account address: 0x...
```

The payer sends the claim and pays its fee from its own balance, so it must
already be deployed. Set exactly one of:

- `FEE_JUICE_PAYER_DEPLOYER=true`: the spending-limit account's deployer, as
  in step 4 above. Its key is the bridge's, resolved the way the bridge
  resolves it (`PXE_BRIDGE_SECRET_ARN`; `PXE_BRIDGE_SECRET_KEY` outside
  production).
- `FEE_JUICE_PAYER_KEY`: a separate plain Schnorr account at the address the
  bridge derives from that key. To deploy it on a network without
  SponsoredFPC, start the bridge once with the payer's key and **without**
  `PXE_BRIDGE_SPENDING_LIMIT_ADMIN`; it logs `Account address` and stops.
  Bridge to that address with `npm run bridge-fee-juice -- --recipient
  <Account address>`, then start it again with the printed `FEE_JUICE_CLAIM`.
  It deploys itself and keeps the remainder as its balance.

Neither key is written to `./aztec-wallet-data`. The wallet stores are created
under `os.tmpdir()` and deleted on exit, SIGINT, SIGTERM and SIGHUP; SIGKILL or a
crash leaves them.

Before any L1 write, the script writes the deposit to
`fee-juice-deposit-<secretHash>.json` in the working directory (mode 0600) and
prints its path; the file is deleted once `FEE_JUICE_RESUME_CLAIM` is printed.
If the run dies before then, rerun with `FEE_JUICE_RECOVER=<file>`: it finds
the deposit on L1, waits for the message and sends the claim, without
depositing.

As soon as the L1 deposit lands, the script prints
`FEE_JUICE_RESUME_CLAIM='{...}'`. If the wait or the claim transaction fails
after that, rerun with that variable set: it skips the deposit, waits for the
message and sends the claim. Rerunning with neither deposits again.

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
| `FEE_JUICE_PAYER_KEY` | One of these two | -- | Secret key of a separate payer account |
| `FEE_JUICE_PAYER_DEPLOYER` | One of these two | -- | `true` pays from the spending-limit account's deployer, using the bridge's key |
| `FEE_JUICE_RESUME_CLAIM` | No | -- | JSON printed by an earlier run; skips the L1 deposit |
| `FEE_JUICE_RECOVER` | No | -- | Deposit file an earlier run wrote before its deposit, or its secret hash; finds that deposit on L1 instead of making one |
| `FEE_JUICE_CLAIM_SECRET` | With `FEE_JUICE_RECOVER` as a hash with no file | -- | Claim secret of that deposit |
| `FEE_JUICE_RECOVER_FROM_BLOCK` | With `FEE_JUICE_RECOVER` as a hash with no file | -- | L1 block recorded with it; the scan starts there |
| `L1_PRIVATE_KEY` | Yes, unless resuming or recovering | -- | Ethereum key holding at least `BRIDGE_AMOUNT` of the Fee Juice ERC20; checked before any L1 write |
| `AZTEC_NODE_URL` | No | `http://localhost:8080` | Aztec node |
| `L1_RPC_URL` | No | `http://localhost:8545` | Ethereum RPC |
| `L1_CHAIN_ID` | No | Anvil's | Required for any L1 other than the sandbox |
| `BRIDGE_AMOUNT` | No | `1e18` | Fee juice in wei |
| `FEE_JUICE_PAYER_SPONSORED` | No | -- | `true` pays via SponsoredFPC; sandbox and testnet only |
| `FEE_JUICE_MINT` | No | -- | `true` mints from the L1 faucet first; sandbox only, and `BRIDGE_AMOUNT` must equal the faucet's fixed mint amount |

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
