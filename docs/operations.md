# Operating the bridge

Operator procedures: recording the account address, the spending-limit
deployment record, fee juice, and administering the spending-limit account.
The settlement contract, readiness and attestations are in
[settlement-operations.md](settlement-operations.md); threat model and
incident runbook in [SECURITY.md](../SECURITY.md). The complete environment
variable table is in [CLAUDE.md](../CLAUDE.md#required-environment).

## Account address

The bridge's account address derives from its key **and** from the account
contract's class, so an SDK upgrade that changes the class moves the address
even though the key did not change. Aztec 5.2.0 and 6.0.0 both did exactly that
for the stock SchnorrAccount. A bridge that simply derived its address would
come up at the new, empty address and deploy an account there while the funded
one sat at the old address.

So the address is recorded, and `connect()` refuses to deploy or serve as
anything else:

1. First deployment: start with `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1` (production
   only; development needs nothing). The bridge logs
   `[pxe-bridge] Account address: 0x...`.
2. Set `PXE_BRIDGE_ACCOUNT_ADDRESS` to that address and remove the flag. In
   production one of the two is required.
3. If the bridge later refuses with "derives to ... but PXE_BRIDGE_ACCOUNT_ADDRESS
   is ...", do not change the variable to the new address to make it start.
   Read SECURITY.md, "Account address pinning", first.

In spending-limit mode the address also commits to the account's constructor
inputs: admin, token, `PXE_BRIDGE_MAX_AMOUNT`, `PXE_BRIDGE_DAILY_LIMIT` and the
allowlist root. The deployment record (`PXE_BRIDGE_ACCOUNT_DEPLOYMENT`, see
below) fixes those inputs, so `npm run update-allowlist` or new limits do not
move the address of a bridge that carries it. Its `address` field records the
same account as `PXE_BRIDGE_ACCOUNT_ADDRESS`: with the record set the variable
is optional, and if both are set they must be equal or the bridge refuses to
start. Without the record, changing any input moves the derived address, and a
bridge with `PXE_BRIDGE_ACCOUNT_ADDRESS` recorded refuses to restart on it. Do
not unset `PXE_BRIDGE_ACCOUNT_ADDRESS` or set `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1`
to bring it up: without either record the bridge deploys a fresh, empty account
at the new address.

Upgrading without the old logs, you can see the address this key derives to
without deploying anything. Set `PXE_BRIDGE_ACCOUNT_ADDRESS` to the address you
believe is funded (or any nonzero 32-byte placeholder) and start the bridge.
`connect()` logs `[pxe-bridge] Account address: 0x...` and, on a mismatch,
refuses before deploying, with an error naming the derived address. If the
address is not the funded one, do not record it; see step 3.

## Spending-limit account deployment record

The spending-limit account's address derives from its constructor arguments:
the per-tx cap, the daily limit, the admin, the token and the allowlist root.
The cap, the limit and the root are all meant to change after deployment, so
the bridge does not derive the address from live configuration once the account
exists. It derives it from a deployment record instead:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PXE_BRIDGE_ACCOUNT_DEPLOYMENT` | Prod, after first deploy | -- | JSON record of what the account was deployed with |
| `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY` | Prod, first deploy only | -- | `1` lets a production bridge deploy without a record |

1. First deployment: start with no record (in production, with
   `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1`). The bridge deploys and logs the
   record:

   ```
   [pxe-bridge] ACCOUNT DEPLOYMENT RECORD. Persist this as PXE_BRIDGE_ACCOUNT_DEPLOYMENT ...
   {"address":"0x...","maxAmountPerTx":"...","dailyLimit":"...","admin":"0x...","token":"0x...","allowlistRoot":"0x..."}
   ```

2. Store that JSON as `PXE_BRIDGE_ACCOUNT_DEPLOYMENT`, remove
   `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY`, and archive the record with the
   allowlist seed. Do not edit it afterwards.
3. After `npm run update-allowlist`, change only
   `PXE_BRIDGE_ALLOWLIST_RECIPIENTS` and restart. After `apply_limits`, change
   `PXE_BRIDGE_MAX_AMOUNT` / `PXE_BRIDGE_DAILY_LIMIT` if you want the
   application-level limits to follow. Neither moves the address.

With a record set the bridge never deploys. It refuses to start if the record
does not derive the recorded address from the secret key (wrong key, edited
record, or a moved contract class), if no initialized account exists at that
address on `AZTEC_NODE_URL`, or if `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` /
`PXE_BRIDGE_SPENDING_LIMIT_TOKEN` differ from the record. In production it also
refuses to start without a record unless `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1`.
Outside production it deploys without asking, and logs the record on every
start that lacks one.

## Fee juice

Every transaction the bridge sends is paid for in fee juice, which is bridged
in from L1 and cannot be bought, transferred or withdrawn on L2. How the bridge
gets it depends on which account it runs:

| Account | Deployment fee | Later transactions | How you fund it |
| --- | --- | --- | --- |
| Plain Schnorr (default) | `FEE_JUICE_CLAIM`, else SponsoredFPC | Own balance | `npm run bridge-fee-juice -- --recipient <Account address>` (with `PXE_BRIDGE_ACCOUNT_ADDRESS` set to the same address, or `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1` before the first deployment), then set `FEE_JUICE_CLAIM` |
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

2. **Bridge fee juice to it.** Keep the L1 key out of shell history and the
   process list: read it from the terminal, or run under `op run` with an
   `op://` reference.

   ```bash
   read -s L1_PRIVATE_KEY; export L1_PRIVATE_KEY
   L1_RPC_URL=https://... L1_CHAIN_ID=1 \
   AZTEC_NODE_URL=https://... BRIDGE_AMOUNT=... \
     npm run bridge-fee-juice -- --deployer --recipient <Deployer address>
   unset L1_PRIVATE_KEY
   ```

   Before any L1 write it writes the claim secret, its hash, the starting L1
   block and the L1 sender to `fee-juice-deposit-<secretHash>.json` in the
   working directory (mode 0600), and prints a `--recover` command naming it.
   Once the deposit lands the claim is added to the file, which is deleted
   only after the message has synced. A hangup exits the run rather than
   killing it mid-write. If the run dies (timeout, signal, crash), the deposit
   may still land: run that command from the same directory, with the same
   `AZTEC_NODE_URL` and `L1_RPC_URL`, instead of this step. It finds the
   deposit on L1 (or, if the file already records the landed claim, takes it
   from there), prints the claim and waits, without depositing. Keep
   `--deployer`: without it the claim prints as `FEE_JUICE_CLAIM`, which the
   spending-limit bridge refuses:

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
   from a separate payer account (bootstrapped as described in the next
   section):

   ```bash
   read -s FEE_JUICE_PAYER_KEY; export FEE_JUICE_PAYER_KEY
   read -s L1_PRIVATE_KEY; export L1_PRIVATE_KEY
   FEE_JUICE_RECIPIENT=<Account address> NODE_ENV=production \
   L1_RPC_URL=https://... L1_CHAIN_ID=1 \
   AZTEC_NODE_URL=https://... BRIDGE_AMOUNT=... \
     npm run top-up-fee-juice
   unset FEE_JUICE_PAYER_KEY L1_PRIVATE_KEY
   ```

   Or keep both in 1Password and run under `op run --env-file=topup.env --
   npm run top-up-fee-juice`, with `op://` references in `topup.env`.

   The account's transfers pay from that balance, not the payer's.
   `FEE_JUICE_PAYER_DEPLOYER=true`, which pays from the deployer's leftover
   balance, is refused under `NODE_ENV=production`: the deployer's key is the
   bridge's signing key, and the script would load it onto the operator's
   machine.

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

- `FEE_JUICE_PAYER_DEPLOYER=true`: the spending-limit account's deployer. Its
  key is the bridge's signing key, read from `PXE_BRIDGE_SECRET_KEY`, so it is
  refused under `NODE_ENV=production`; use it on sandbox and testnet only.
- `FEE_JUICE_PAYER_KEY`: a separate plain Schnorr account at the address the
  bridge derives from that key. To deploy it on a network without
  SponsoredFPC, start the bridge once with the payer's key and **without**
  `PXE_BRIDGE_SPENDING_LIMIT_ADMIN`; it logs `Account address` and stops.
  Bridge to that address with `npm run bridge-fee-juice -- --recipient
  <Account address>`, then start it again with the printed `FEE_JUICE_CLAIM`.
  It deploys itself and keeps the remainder as its balance. Record that
  address as `FEE_JUICE_PAYER_ADDRESS`: the script refuses to send unless the
  key still derives to it, which it stops doing when an SDK upgrade changes
  the stock SchnorrAccount class (SECURITY.md, "Account address pinning").

Neither key is written to `./aztec-wallet-data`. The wallet stores are created
under `os.tmpdir()` and deleted on exit, SIGINT, SIGTERM and SIGHUP; SIGKILL or a
crash leaves them.

Before any L1 write, the script writes the deposit to
`fee-juice-deposit-<secretHash>.json` in the working directory (mode 0600) and
prints its path. Once the deposit lands the claim is added to the file, which
is deleted only after the claim transaction succeeds. If the run dies, rerun
with `FEE_JUICE_RECOVER=<file>`: it finds the deposit on L1 (or takes the
recorded claim from the file), waits for the message and sends the claim,
without depositing.

The script takes no arguments and refuses any, since an ignored
`-- --recover <file>` would deposit again. Every option is an env variable.
`FEE_JUICE_PAYER_DEPLOYER`, `FEE_JUICE_MINT` and `FEE_JUICE_PAYER_SPONSORED`
accept only `true` or `false`. `FEE_JUICE_PAYER_SPONSORED=true` is refused
wherever the bridge would refuse SponsoredFPC: under `NODE_ENV=production`
unless `PXE_BRIDGE_ALLOW_SPONSORED_FPC=true`.

As soon as the L1 deposit lands, the script prints
`FEE_JUICE_RESUME_CLAIM='{...}'`. If the wait or the claim transaction fails
after that, rerun with that variable set: it skips the deposit, waits for the
message and sends the claim. Rerunning with neither deposits again.

```bash
read -s FEE_JUICE_PAYER_KEY; export FEE_JUICE_PAYER_KEY
read -s L1_PRIVATE_KEY; export L1_PRIVATE_KEY
FEE_JUICE_RECIPIENT=0x...   \
FEE_JUICE_PAYER_ADDRESS=0x... \
AZTEC_NODE_URL=http://localhost:8080 \
L1_RPC_URL=https://... L1_CHAIN_ID=1 \
BRIDGE_AMOUNT=1000000000000000000 \
npm run top-up-fee-juice
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FEE_JUICE_RECIPIENT` | Yes | -- | Aztec address to credit |
| `FEE_JUICE_PAYER_KEY` | One of these two | -- | Secret key of a separate payer account |
| `FEE_JUICE_PAYER_ADDRESS` | With `FEE_JUICE_PAYER_KEY` | -- | The payer's recorded address; the key must derive to it. Optional with `FEE_JUICE_PAYER_DEPLOYER`, checked the same way when set |
| `FEE_JUICE_PAYER_DEPLOYER` | One of these two | -- | `true` pays from the spending-limit account's deployer, using the bridge's key; refused under `NODE_ENV=production` |
| `FEE_JUICE_RESUME_CLAIM` | No | -- | JSON printed by an earlier run; skips the L1 deposit |
| `FEE_JUICE_RECOVER` | No | -- | Deposit file an earlier run wrote before its deposit, or its secret hash; finds that deposit on L1 instead of making one |
| `FEE_JUICE_CLAIM_SECRET` | With `FEE_JUICE_RECOVER` as a hash with no file | -- | Claim secret of that deposit |
| `FEE_JUICE_RECOVER_FROM_BLOCK` | With `FEE_JUICE_RECOVER` as a hash with no file | -- | L1 block recorded with it; the scan starts there |
| `L1_PRIVATE_KEY` | Yes, unless resuming or recovering | -- | Ethereum key holding at least `BRIDGE_AMOUNT` of the Fee Juice ERC20; checked before any L1 write |
| `AZTEC_NODE_URL` | No | `http://localhost:8080` | Aztec node |
| `L1_RPC_URL` | No | `http://localhost:8545` | Ethereum RPC |
| `L1_CHAIN_ID` | No | Anvil's | Required for any L1 other than the sandbox |
| `BRIDGE_AMOUNT` | No | `1e18` | Fee juice in wei |
| `FEE_JUICE_PAYER_SPONSORED` | No | -- | `true` pays via SponsoredFPC; sandbox and testnet only, refused under the same policy as `PXE_BRIDGE_ALLOW_SPONSORED_FPC` |
| `FEE_JUICE_MINT` | No | -- | `true` mints from the L1 faucet first; sandbox only, and `BRIDGE_AMOUNT` must equal the faucet's fixed mint amount |

There is nothing to set on the bridge afterwards. The balance is on chain, and
the account finds it on its next transaction.

Getting `FEE_JUICE_RECIPIENT` wrong is not recoverable: the L1 to L2 message
commits to the recipient it was built with, and FeeJuice has no transfer, so
juice credited to the wrong address stays there. The script checks the address
shape before it writes to L1, which catches a truncated paste but not a
well-formed wrong address.

## Account administration

Admin calls on the spending-limit account. The admin is a deployed Schnorr
account, derived from its key the way the bridge derives its own, and pays its
own fees.

Prerequisites:

- The admin account is deployed and holds fee juice. To deploy it:
  1. `npm run admin -- deploy` with `SPENDING_LIMIT_ADMIN_KEY` set. It prints
     `admin: <address>`, then stops with "SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM is required" if
     the account is not deployed yet. Nothing is sent, and the wallet it opens
     lives in `os.tmpdir()` and is deleted on exit.
  2. `npm run bridge-fee-juice -- --admin --recipient <admin address>`, with
     `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` set to the same address (the script
     refuses a recipient that differs from it), `L1_PRIVATE_KEY` set and no
     `PXE_BRIDGE_SECRET_KEY`. It prints the claim as
     `SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM`; the deposit file, `--wait` and
     `--recover` (with `--admin`) work as in "Deploying the spending-limit
     account in production" above.
  3. `npm run admin -- deploy` again, with `SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM` set to the
     printed claim JSON. This is not `FEE_JUICE_CLAIM`, the bridge's own claim.
     `deploy` sends nothing if the admin is already deployed.

  Never put the admin key in `PXE_BRIDGE_SECRET_KEY`, for any script or for
  the bridge: `bridge-fee-juice` and the bridge both open a persistent wallet
  that writes the key to `./aztec-wallet-data`, and the admin key cannot be
  rotated. Keep the admin funded with `npm run top-up-fee-juice` and
  `FEE_JUICE_RECIPIENT` set to the admin address: `pause` cannot be sent
  without it.
- The contract artifact is in `contracts/spending_limit_account/target/`, for
  every command including `status`, which takes storage slots from it. It is
  gitignored: download `contract-artifact` from CI or build it with
  `aztec compile`. Commands refuse when its class ID differs from the
  account's, except `pause` and `unpause`, which read no storage: they warn
  and send, since `aztec compile` is not reproducible (see `SECURITY.md`).

```bash
npm run admin -- deploy
npm run admin -- status [--expect-root <hex>] [--expect-paused] [--min-fee-juice <n>]
npm run admin -- pause
npm run admin -- unpause
npm run admin -- propose-limits --max-per-tx <n> --daily <n>
npm run admin -- apply-limits
npm run admin -- cancel-limits
npm run update-allowlist -- --add 0x<addr> --index <n>
npm run update-allowlist -- --revoke 0x<addr>
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SPENDING_LIMIT_ACCOUNT` | All but `deploy` | -- | Address of the spending-limit account |
| `SPENDING_LIMIT_ADMIN_KEY` | All but `status` | -- | Secret key of the admin |
| `SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM` | `deploy` | -- | Claim JSON from `npm run bridge-fee-juice -- --admin --recipient <admin address>`. Not needed if already deployed |
| `PXE_BRIDGE_ALLOWLIST_SEED` | `update-allowlist` | -- | The bridge's allowlist seed. Optional for `status`, see below |
| `PXE_BRIDGE_ALLOWLIST_RECIPIENTS` | `update-allowlist` | -- | The current set, as the bridge has it. Optional for `status` |
| `AZTEC_NODE_URL` | No | `http://localhost:8080` | Aztec node |

Keys, the seed and the claim are checked without echoing them and deleted from the
process environment on read. The admin wallet's stores, which hold the admin
key, live in `os.tmpdir()` (`wallet_data-*`, `pxe_data-*`) and are deleted on
exit, on error and on SIGHUP/SIGINT/SIGTERM. SIGKILL or a crash leaves them.

Limits are in token base units, decimal, and must satisfy the contract:
both non-zero, daily >= per-tx, each within u128. A proposal becomes
applicable 24h after it lands and stays applicable for 24h; after that,
`cancel-limits` and propose again. Sends print the tx hash, wait for the
receipt, print the fee paid, and exit 1 unless it executed successfully.
`update-allowlist` refuses before sending unless the key derives the account's
admin and the configured set reproduces the account's `allowlist_root`.

`status` reads public storage and needs no key. Exit code bits, ORed, for cron:

| Bit | Meaning |
| --- | --- |
| 1 | Error, alone: unreachable node, no account at the address, class ID not the artifact's |
| 2 | Pause state is not the expected one: paused, or with `--expect-paused` unpaused |
| 4 | Limit proposal pending, expired included, until applied or cancelled |
| 8 | `allowlist_root` is not the expected root: `--expect-root`, else the root of `PXE_BRIDGE_ALLOWLIST_SEED` and `PXE_BRIDGE_ALLOWLIST_RECIPIENTS` when set, else unchecked |
| 16 | Admin fee juice below `--min-fee-juice`; unchecked without it |

Codes >= 128 are interrupts, not bits: 129 SIGHUP, 130 SIGINT, 143 SIGTERM.
Status bits stay below 32.

A send is admitted only if the admin holds its declared fee limit: estimated
gas plus 10%, at 10x the worst predicted base fee. That is about 11x the `fee`
a send prints at unchanged base fees. Set `--min-fee-juice` above that for the
costliest command, with room for base fees to rise.

`status` sees state at the latest block only. It cannot detect a send not yet
included, a change undone between two runs (unpause, drain, pause), transfers a
compromised signing key makes within the live limits and allowlist, or an
allowlist change when no expected root is configured. Values are read without
a public-data witness, so the node is trusted: point it at a node you run, over
https, independent of the one the bridge uses.

See `SECURITY.md` for the incident runbook.

## Oxide mode (`PXE_BRIDGE_SEND_MODE=oxide`)

Oxide mode pays OXDAI through the Oxide sender (`src/oxide/`). It uses the
standard Schnorr account (the approved Oxide sender `0x15ff...cb22`), not the
spending-limit account. It serves only `aztec_createNote` with
`sendMode: "oxide"`; a `spending_limit` request is refused with `-32602`
`send_mode_unsupported`, and a spending-limit bridge refuses `oxide` the same
way. The wire contract is in
[settlement-operations.md](settlement-operations.md#sendmode-and-the-oxide-payout-proof-040-pxe-bridge84).

`PXE_BRIDGE_SEND_MODE` takes `spending_limit` (also the value when unset: the
design-A bridge, unchanged) or `oxide`; any other value refuses to start.

**Variables (Oxide mode):**

| Variable | Required | Meaning |
| --- | --- | --- |
| `PXE_BRIDGE_JOURNAL` | yes | The settlement journal, bound to the standard account as in any mode |
| `PXE_BRIDGE_OXIDE_JOURNAL` | yes | The Oxide journal: its own SQLite file, never the settlement journal's path (compared after `path.resolve`); directory 0700, files 0600 |
| `PXE_BRIDGE_OXIDE_L1_RPC_URL` | yes | Ethereum mainnet RPC, `http(s)`, view calls only (TeeRegistry, CertManager, OxidePortal) |
| `PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT` | yes | The OxideToken artifact `npm run build:oxide-token` writes; refused unless it is the OXDAI class `0x27df40f9...3f949` |
| `PXE_BRIDGE_SETTLEMENT_CORRIDOR` | yes | The corridor (manifest rev 2); a request naming another corridor or network digest is `not_submitted` `corridor_mismatch` / `network_mismatch` |
| `PXE_BRIDGE_MAY_BROADCAST_URL` / `_TOKEN` | yes | Riddler's may-broadcast endpoint, asked for each operation's v2 fingerprint |
| `PXE_BRIDGE_OXIDE_ALLOWLIST_SEED` / `_RECIPIENTS` | yes | The private recipient allowlist ([settlement-operations.md](settlement-operations.md#oxide-mode-the-private-allowlist-xochi751-xochi775-option-a)) |
| `PXE_BRIDGE_OXIDE_MAX_PER_TX` | no, 1,000 DAI | Off-chain per-transaction cap, base units; never above the token's 5,166 DAI note cap |
| `PXE_BRIDGE_OXIDE_DAILY_LIMIT` | no, 10,000 DAI | Rolling-24h cap, base units, re-checked inside the may-broadcast mark |
| `PXE_BRIDGE_ACCOUNT_ADDRESS` | production | The Oxide sender's recorded address, as for any standard account |
| `PXE_BRIDGE_ATTESTATION_API_KEY`, `_SECRET_ARN` (dev: `_SECRET_KEY`), `_SOURCE_CHAIN_ID`, `_ENVIRONMENT`, `_RELAY_URL` / `_RELAY_TOKEN` | for OX-11 | The readiness attestation producer ([settlement-operations.md](settlement-operations.md#recipient-readiness-attestations)): without it no Membership or RootUpdate is signed over the private allowlist and no recipient binding becomes ready. Optional to start; startup logs a warning when Oxide mode runs without it |

### Funding the Oxide sender's private OXDAI balance

`npm run fund-oxide` performs the canonical Oxide deposit: approve the pinned
DAI portal, compute the recipient commitment with Oxide's helper, call
`OxidePortal.deposit`, wait for its L1-to-L2 message, then run the existing
`storeOxideDeposit` utility call in the sender's PXE. The helper and portal
surface come from `aztec-labs-eng/zkmoney-public` commit
`8fd198412a956f214639b5782d3a86e3d47ca60e`; see
`src/oxide/vendor/VENDORED.md` and `src/oxide/portal-deposit.ts`.

Stop the Oxide bridge before the store phase: the one-shot tool opens the same
wallet data directory. Set `PXE_BRIDGE_ACCOUNT_ADDRESS` to the recorded Oxide
sender. The command requires the chain, token, portal, L1 sender and Aztec
recipient explicitly, then refuses any value that differs from the shipped
Oxide v6 pins, the recorded account or the L1 key. The amount is a canonical
positive decimal in DAI base units, not a decimal DAI display amount.

Plan first. This validates arguments and an existing state file, if any, but
makes no network request and creates no state:

```bash
PXE_BRIDGE_ACCOUNT_ADDRESS='<OXIDE_SENDER_AZTEC_ADDRESS>' \
npm run fund-oxide -- \
  --dry-run \
  --state '<OWNER_ONLY_STATE_PATH>' \
  --chain-id 1 \
  --token '<PINNED_DAI_ADDRESS>' \
  --portal '<PINNED_OXIDE_PORTAL_ADDRESS>' \
  --recipient '<OXIDE_SENDER_AZTEC_ADDRESS>' \
  --sender '<FUNDER_L1_ADDRESS>' \
  --amount '<DAI_BASE_UNITS>'
```

For the live operator run, provide `L1_PRIVATE_KEY`,
`PXE_BRIDGE_SECRET_KEY`, `PXE_BRIDGE_OXIDE_L1_RPC_URL`, `AZTEC_NODE_URL` and
`PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT` from the operator secret/config store. Never
put either key on the command line. Use the same arguments as the plan, without
`--dry-run`; `--wallet-data-dir '<PXE_WALLET_DATA_DIRECTORY>'` names the
bridge's durable wallet store when it is not the default.

The state path must not exist on the first run. The tool creates it as a 0600
regular file and fsyncs it before approval or deposit. It contains the random
shared-secret salt and signed transactions, but no private key; neither the
salt nor the state JSON is printed. Its phases are:
`prepared -> approved -> deposited -> message_ready -> stored`. Each change is
an owner-only temporary file, fsync and atomic rename. The `deposited` phase is
written with the signed raw transaction and hash **before broadcast**. A crash,
timeout or RPC error after that point can only query or rebroadcast those exact
bytes (same hash and nonce); no retry path calls `deposit` again.

Rerun the exact command with the same state path after any interruption. A
not-ready message leaves the verified event key, index and credited amount in
`deposited`; rerunning polls it and continues. `store_deposit` is considered
complete on a duplicate only when OxideToken returns its exact
`deposit already stored` assertion. Every other store error is fatal and the
state remains `message_ready`.

Treat the state and every backup as a secret because they contain the salt.
With the tool stopped, back it up without loosening permissions:

```bash
install -m 600 '<OWNER_ONLY_STATE_PATH>' '<OWNER_ONLY_BACKUP_PATH>'
```

To recover, restore that file with mode 0600 and rerun the identical command.
Never edit it, choose a new state path or start another deposit to work around
an error. If both state and backup are lost after deposit preparation or
broadcast, stop: recover the exact known transaction and salt from controlled
operator records. **Never submit a second L1 deposit.** Preserve the `stored`
state as the immutable receipt.

**Startup refuses**, before a key is fetched or a node is touched
(`src/oxide/config.ts`):
- an unknown `PXE_BRIDGE_SEND_MODE`;
- any `PXE_BRIDGE_OXIDE_*` variable without `PXE_BRIDGE_SEND_MODE=oxide`,
  because a spending-limit bridge would silently ignore it;
- in Oxide mode, any spending-limit or generic-limit variable
  (`PXE_BRIDGE_SPENDING_LIMIT_ADMIN`, `_SPENDING_LIMIT_TOKEN`,
  `PXE_BRIDGE_ACCOUNT_DEPLOYMENT`, `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM`,
  `PXE_BRIDGE_ALLOWLIST_RECIPIENTS`, `PXE_BRIDGE_MAX_AMOUNT`,
  `PXE_BRIDGE_DAILY_LIMIT`, `PXE_BRIDGE_COOLDOWN_*`). Oxide caps are
  `PXE_BRIDGE_OXIDE_MAX_PER_TX` and `_DAILY_LIMIT`;
- a missing required variable, one file for both journals, a non-http(s) L1
  RPC, or caps that exceed the note cap or each other.

After the wallet connects, `createOxideSender` refuses (and the process exits)
only on a local defect: an artifact that is not the OXDAI class, an OXDAI
instance not locked to it, or spend keys that do not derive the account. The
live deployment (L1, the Oxide manifest, the zk.money profile, the portal, the
enclave) is not asserted at startup: an outage there must not stop
`aztec_getSettlement` or the recovery of journaled payouts. It is checked
before every fresh attempt and every resend (a fresh attempt is refused
`not_submitted`, a held attempt stays `prepared`), the enclave is connected on
first sign, and `/ready` reports it. The refusal's class follows what was
found (xochi#748 OX-6): a deployment that is no longer the pinned one --
manifest or profile moved (`oxide_pin_mismatch`), L1 not the pinned
chain/registry/portal (`enclave_refused:l1_not_pinned`), the fleet's PCR0
not the pinned image or not hashing to `TeeRegistry.PCR0_HASH()`
(`enclave_refused:pcr0_not_pinned` / `pcr0_hash_mismatch`) -- is PERMANENT:
nothing this process retries clears it, an operator re-pins after review and
ships a new release, and Riddler refunds the order. An unread pin
(`oxide_pin_unverified`), a frozen portal and an attestation document that
does not verify are transient. The same split applies at admission
(`OxideReadiness.admit`, docs/settlement-operations.md "Oxide readiness"). `/ready` reports `initializing` until the
sender is built.

**Oxide journal schema 2.** Each row holds the operation's v2 terms
(`sendMode: "oxide"`) and their v2 request fingerprint. A phase-1 (schema 1)
Oxide journal, written by the unreleased `createOxideSender` callers before
0.4.0, opens with writes disabled (`unknown_schema_version`); no release
wrote one. Start Oxide mode on a fresh file. Never reuse a phase-1 journal,
and never delete a schema-2 journal that holds unresolved operations: it is
the only record of what may have been broadcast.
