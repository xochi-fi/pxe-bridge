# Operating the bridge

Operator procedures: the account address, the spending-limit deployment
record, fee juice, account administration and Oxide mode. Settlement
contract, readiness and attestations: [settlement-operations.md](settlement-operations.md).
Threat model and incident runbook: [SECURITY.md](../SECURITY.md). Full
environment table: [CLAUDE.md](../CLAUDE.md#required-environment).

## Account address

The address derives from the key and the account contract's class, so an SDK
upgrade that changes the class moves it. The bridge records the address and
`connect()` refuses to deploy or serve as anything else:

1. First deployment: start with `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1`
   (production only). The bridge logs `[pxe-bridge] Account address: 0x...`.
2. Set `PXE_BRIDGE_ACCOUNT_ADDRESS` to that address and remove the flag.
3. If the bridge later refuses with "derives to ... but
   PXE_BRIDGE_ACCOUNT_ADDRESS is ...", do not change the variable or set the
   flag: either deploys a fresh, empty account. Read SECURITY.md, "Account
   address pinning".

In spending-limit mode the address also commits to admin, token,
`PXE_BRIDGE_MAX_AMOUNT`, `PXE_BRIDGE_DAILY_LIMIT` and the allowlist root. The
deployment record below fixes those, so `update-allowlist` and limit changes
do not move it. Its `address` field satisfies `PXE_BRIDGE_ACCOUNT_ADDRESS`;
if both are set they must be equal.

To see which address a key derives to without deploying, set
`PXE_BRIDGE_ACCOUNT_ADDRESS` to the address you believe is funded (or any
nonzero placeholder) and start: on a mismatch the bridge refuses before
deploying, naming the derived address.

## Spending-limit account deployment record

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PXE_BRIDGE_ACCOUNT_DEPLOYMENT` | Prod, after first deploy | -- | JSON record of what the account was deployed with |
| `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY` | Prod, first deploy only | -- | `1` lets a production bridge deploy without a record |

1. First deployment: start with no record (in production, with
   `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1`). The bridge deploys and logs:

   ```
   [pxe-bridge] ACCOUNT DEPLOYMENT RECORD. Persist this as PXE_BRIDGE_ACCOUNT_DEPLOYMENT ...
   {"address":"0x...","maxAmountPerTx":"...","dailyLimit":"...","admin":"0x...","token":"0x...","allowlistRoot":"0x..."}
   ```

2. Store that JSON as `PXE_BRIDGE_ACCOUNT_DEPLOYMENT`, remove
   `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY`, and archive the record with the
   allowlist seed. Do not edit it.
3. After `npm run update-allowlist`, change only
   `PXE_BRIDGE_ALLOWLIST_RECIPIENTS` and restart. After `apply_limits`, change
   `PXE_BRIDGE_MAX_AMOUNT` / `PXE_BRIDGE_DAILY_LIMIT` if the application-level
   limits should follow.

With a record set the bridge never deploys. It refuses to start if the record
does not derive the recorded address from the secret key, if no initialized
account exists at that address, or if `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` /
`PXE_BRIDGE_SPENDING_LIMIT_TOKEN` differ from it. Outside production it
deploys and logs the record on every start that lacks one.

## Fee juice

Every transaction is paid in fee juice, bridged from L1; it cannot be bought,
transferred or withdrawn on L2.

| Account | Deployment fee | Later transactions | How you fund it |
| --- | --- | --- | --- |
| Plain Schnorr (default) | `FEE_JUICE_CLAIM`, else SponsoredFPC | Own balance | `npm run bridge-fee-juice -- --recipient <Account address>` (with `PXE_BRIDGE_ACCOUNT_ADDRESS` set, or `PXE_BRIDGE_ALLOW_ACCOUNT_DEPLOY=1` before the first deployment), then set `FEE_JUICE_CLAIM` |
| Spending limit (`PXE_BRIDGE_SPENDING_LIMIT_ADMIN`) | `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM`, via the deployer, else SponsoredFPC | Pre-existing balance only | `npm run bridge-fee-juice -- --deployer --recipient <Deployer address>` to deploy, `npm run top-up-fee-juice` to run |

The spending-limit account cannot claim for itself (its entrypoint admits
exactly one call); `FEE_JUICE_CLAIM` alongside `PXE_BRIDGE_SPENDING_LIMIT_ADMIN`
is refused at startup.

### Deployment fee and SponsoredFPC

A plain Schnorr account pays its deployment from `FEE_JUICE_CLAIM`, else from
SponsoredFPC (sandbox and testnet only). The spending-limit account is
deployed from a plain Schnorr **deployer** at salt + 1 of the same key, logged
as `Deployer address: 0x...` while the account needs deploying. With
`PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM` (bridged to the deployer) it deploys
itself and pays the account's deployment from the remainder; without it, a
deployer with a balance pays both, one with none falls back to SponsoredFPC.

The fallback is refused under `NODE_ENV=production` (set by the image) unless
`PXE_BRIDGE_ALLOW_SPONSORED_FPC=true`; `false` refuses it anywhere; any other
value is rejected at startup. When refused, an undeployed account stops the
bridge before anything is sent. Set `true` only against a sandbox or testnet.

### Deploying the spending-limit account in production

1. **Get the deployer address.** Start the bridge once with the spending-limit
   configuration and no claim. It logs `Account address` and
   `Deployer address`, then stops at the SponsoredFPC refusal.

2. **Bridge fee juice to it.** Keep the L1 key out of shell history: read it
   from the terminal, or run under `op run` with an `op://` reference.

   ```bash
   read -s L1_PRIVATE_KEY; export L1_PRIVATE_KEY
   L1_RPC_URL=https://... L1_CHAIN_ID=1 \
   AZTEC_NODE_URL=https://... BRIDGE_AMOUNT=... \
     npm run bridge-fee-juice -- --deployer --recipient <Deployer address>
   unset L1_PRIVATE_KEY
   ```

   Before any L1 write it writes `fee-juice-deposit-<secretHash>.json` (mode
   0600) in the working directory and prints a `--recover` command. If the run
   dies, run that command from the same directory with the same
   `AZTEC_NODE_URL` and `L1_RPC_URL` instead of repeating this step. Keep
   `--deployer`, or the claim prints as `FEE_JUICE_CLAIM`:

   ```bash
   L1_RPC_URL=https://... AZTEC_NODE_URL=https://... \
     npm run bridge-fee-juice -- --deployer --recipient <Deployer address> \
       --recover fee-juice-deposit-<secretHash>.json
   ```

   `--recover <secretHash>` finds the same file, or without one takes
   `FEE_JUICE_CLAIM_SECRET`, `FEE_JUICE_RECOVER_FROM_BLOCK` and
   `BRIDGE_AMOUNT`. When the deposit is not on L1, recovery reads the sender's
   nonces: a pending transaction can still land (recover again once mined);
   none pending means bridging anew is safe.

   Once the deposit lands it prints `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM='{...}'`
   and the message hash, then waits until the message has synced. Start the
   bridge only after that. If the wait times out, **do not run this step
   again**; resume it:

   ```bash
   AZTEC_NODE_URL=https://... npm run bridge-fee-juice -- --wait <messageHash>
   ```

   One claim pays both deployments and any top-up claims sent from the
   deployer; size it for all of them (see below).

3. **Start the bridge** with `PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM`. It deploys
   the deployer, then the account, and logs `Ready`. The variable can then be
   removed. If the deployer is already deployed but its balance cannot cover
   the account deployment, bridge a fresh claim (step 2) and restart.

4. **Top up the spending-limit account** at the logged `Account address` from
   a separate payer (next section):

   ```bash
   read -s FEE_JUICE_PAYER_KEY; export FEE_JUICE_PAYER_KEY
   read -s L1_PRIVATE_KEY; export L1_PRIVATE_KEY
   FEE_JUICE_RECIPIENT=<Account address> NODE_ENV=production \
   L1_RPC_URL=https://... L1_CHAIN_ID=1 \
   AZTEC_NODE_URL=https://... BRIDGE_AMOUNT=... \
     npm run top-up-fee-juice
   unset FEE_JUICE_PAYER_KEY L1_PRIVATE_KEY
   ```

   Or `op run --env-file=topup.env -- npm run top-up-fee-juice` with `op://`
   references. `FEE_JUICE_PAYER_DEPLOYER=true` is refused under
   `NODE_ENV=production`: the deployer's key is the bridge's signing key.

The node admits a transaction only if the fee payer's balance covers
`gasLimits x maxFeesPerGas`; the bridge sets `maxFeesPerGas` to 10x the worst
predicted base fee. Size the deployer claim for the deployer's own fee, the
account deployment's full fee limit (it publishes the contract class) and each
top-up claim the deployer will send. The remainder stays with the deployer and
is spendable only on its own transactions. Refill it with
`npm run top-up-fee-juice` and `FEE_JUICE_RECIPIENT` set to the deployer.

### Topping up the spending-limit account

`FeeJuice.claim` names its beneficiary, so a payer you control claims on the
bridge's behalf: bridge from L1 to the bridge's address, wait for the message,
send the claim from the payer. The address to fund is logged at startup as
`[pxe-bridge] Account address: 0x...`.

The payer must already be deployed. Set exactly one of:

- `FEE_JUICE_PAYER_DEPLOYER=true`: the deployer. Refused under
  `NODE_ENV=production`; sandbox and testnet only.
- `FEE_JUICE_PAYER_KEY`: a separate plain Schnorr account. To deploy it
  without SponsoredFPC, start the bridge once with the payer's key and
  **without** `PXE_BRIDGE_SPENDING_LIMIT_ADMIN`; it logs `Account address`
  and stops. Bridge to that address with `npm run bridge-fee-juice --
  --recipient <Account address>`, then start again with the printed
  `FEE_JUICE_CLAIM`. Record that address as `FEE_JUICE_PAYER_ADDRESS`; the
  script refuses to send unless the key still derives to it (SECURITY.md,
  "Account address pinning").

Wallet stores are created under `os.tmpdir()` and deleted on exit, SIGINT,
SIGTERM and SIGHUP; SIGKILL or a crash leaves them.

Before any L1 write the script writes `fee-juice-deposit-<secretHash>.json`
(0600) and prints its path; the file is deleted only after the claim
transaction succeeds. If the run dies, rerun with `FEE_JUICE_RECOVER=<file>`.
Once the deposit lands it prints `FEE_JUICE_RESUME_CLAIM='{...}'`; if the wait
or claim fails after that, rerun with that variable set. Rerunning with neither
deposits again. The script takes no arguments and refuses any.

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
| `FEE_JUICE_PAYER_DEPLOYER` | One of these two | -- | `true` pays from the deployer, using the bridge's key; refused under `NODE_ENV=production` |
| `FEE_JUICE_RESUME_CLAIM` | No | -- | JSON printed by an earlier run; skips the L1 deposit |
| `FEE_JUICE_RECOVER` | No | -- | Deposit file an earlier run wrote, or its secret hash; finds that deposit on L1 instead of making one |
| `FEE_JUICE_CLAIM_SECRET` | With `FEE_JUICE_RECOVER` as a hash with no file | -- | Claim secret of that deposit |
| `FEE_JUICE_RECOVER_FROM_BLOCK` | With `FEE_JUICE_RECOVER` as a hash with no file | -- | L1 block the scan starts at |
| `L1_PRIVATE_KEY` | Yes, unless resuming or recovering | -- | Ethereum key holding at least `BRIDGE_AMOUNT` of the Fee Juice ERC20 |
| `AZTEC_NODE_URL` | No | `http://localhost:8080` | Aztec node |
| `L1_RPC_URL` | No | `http://localhost:8545` | Ethereum RPC |
| `L1_CHAIN_ID` | No | Anvil's | Required for any L1 other than the sandbox |
| `BRIDGE_AMOUNT` | No | `1e18` | Fee juice in wei |
| `FEE_JUICE_PAYER_SPONSORED` | No | -- | `true` pays via SponsoredFPC; same policy as `PXE_BRIDGE_ALLOW_SPONSORED_FPC` |
| `FEE_JUICE_MINT` | No | -- | `true` mints from the L1 faucet first; sandbox only, `BRIDGE_AMOUNT` must equal the faucet's mint amount |

`FEE_JUICE_PAYER_DEPLOYER`, `FEE_JUICE_MINT` and `FEE_JUICE_PAYER_SPONSORED`
accept only `true` or `false`. Nothing is set on the bridge afterwards.
A wrong `FEE_JUICE_RECIPIENT` is not recoverable: the message commits to it
and FeeJuice has no transfer. The script checks the address shape only.

## Account administration

The admin is a deployed Schnorr account that pays its own fees.

Prerequisites:

- The admin account is deployed and holds fee juice. To deploy it:
  1. `npm run admin -- deploy` with `SPENDING_LIMIT_ADMIN_KEY` set. It prints
     `admin: <address>`, then stops with "SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM
     is required" if not yet deployed.
  2. `npm run bridge-fee-juice -- --admin --recipient <admin address>`, with
     `PXE_BRIDGE_SPENDING_LIMIT_ADMIN` set to the same address,
     `L1_PRIVATE_KEY` set and no `PXE_BRIDGE_SECRET_KEY`. It prints
     `SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM`; the deposit file, `--wait` and
     `--recover` (with `--admin`) work as above.
  3. `npm run admin -- deploy` again with that claim. `deploy` sends nothing
     if the admin is already deployed.

  Never put the admin key in `PXE_BRIDGE_SECRET_KEY`: the bridge and
  `bridge-fee-juice` write it to `./aztec-wallet-data`, and the admin key
  cannot be rotated. Keep the admin funded (`npm run top-up-fee-juice`,
  `FEE_JUICE_RECIPIENT=<admin address>`): `pause` cannot be sent without it.
- The artifact is in `contracts/spending_limit_account/target/` (download
  `contract-artifact` from CI or build with `aztec compile`). Commands refuse
  when its class ID differs from the account's, except `pause` and `unpause`,
  which read no storage: they warn and send.

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
| `SPENDING_LIMIT_ADMIN_FEE_JUICE_CLAIM` | `deploy` | -- | Claim JSON from `npm run bridge-fee-juice -- --admin --recipient <admin address>` |
| `PXE_BRIDGE_ALLOWLIST_SEED` | `update-allowlist` | -- | The bridge's allowlist seed. Optional for `status` |
| `PXE_BRIDGE_ALLOWLIST_RECIPIENTS` | `update-allowlist` | -- | The current set. Optional for `status` |
| `AZTEC_NODE_URL` | No | `http://localhost:8080` | Aztec node |

Keys, the seed and the claim are deleted from the process environment on read.
The admin wallet's stores (`os.tmpdir()`) are deleted on exit, error and
SIGHUP/SIGINT/SIGTERM; SIGKILL or a crash leaves them.

Limits are token base units, decimal: both non-zero, daily >= per-tx, within
u128. A proposal becomes applicable 24h after it lands and stays applicable for
24h; after that, `cancel-limits` and propose again. Sends print the tx hash,
wait for the receipt and exit 1 unless it succeeded. `update-allowlist`
refuses unless the key derives the account's admin and the configured set
reproduces `allowlist_root`.

`status` needs no key. Exit code bits, ORed, for cron:

| Bit | Meaning |
| --- | --- |
| 1 | Error, alone: unreachable node, no account at the address, class ID not the artifact's |
| 2 | Pause state is not the expected one: paused, or with `--expect-paused` unpaused |
| 4 | Limit proposal pending, expired included, until applied or cancelled |
| 8 | `allowlist_root` is not the expected root: `--expect-root`, else the root of `PXE_BRIDGE_ALLOWLIST_SEED` and `PXE_BRIDGE_ALLOWLIST_RECIPIENTS` when set, else unchecked |
| 16 | Admin fee juice below `--min-fee-juice`; unchecked without it |

Codes >= 128 are interrupts (129 SIGHUP, 130 SIGINT, 143 SIGTERM).

A send is admitted only if the admin holds its declared fee limit: estimated
gas plus 10%, at 10x the worst predicted base fee, about 11x the `fee` a send
prints. Set `--min-fee-juice` above that for the costliest command.

`status` reads the latest block from one node without a public-data witness:
point it at a node you run, over https, independent of the bridge's. It cannot
see a send not yet included or a change undone between runs.

## Oxide mode (`PXE_BRIDGE_SEND_MODE=oxide`)

Pays OXDAI through the Oxide sender (`src/oxide/`) on the standard Schnorr
account (the approved Oxide sender `0x15ff...cb22`). Serves only
`aztec_createNote` with `sendMode: "oxide"`; the other mode is refused with
`-32602` `send_mode_unsupported`. Wire contract:
[settlement-operations.md](settlement-operations.md#sendmode-and-the-oxide-payout-proof-040-pxe-bridge84).
`PXE_BRIDGE_SEND_MODE` takes `spending_limit` (the default) or `oxide`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `PXE_BRIDGE_JOURNAL` | yes | The settlement journal, bound to the standard account |
| `PXE_BRIDGE_OXIDE_JOURNAL` | yes | The Oxide journal: its own SQLite file, never the settlement journal's path; directory 0700, files 0600 |
| `PXE_BRIDGE_WALLET_DATA_DIRECTORY` | recommended; required by `oxide-deposit store` | Absolute path to the persistent PXE/wallet LMDB directory; the same path on the bridge and the operator command |
| `PXE_BRIDGE_OXIDE_L1_RPC_URL` | yes | Ethereum mainnet RPC, `http(s)`, view calls only |
| `PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT` | yes | The OxideToken artifact from `npm run build:oxide-token`; must be the OXDAI class `0x27df40f9...3f949` |
| `PXE_BRIDGE_SETTLEMENT_CORRIDOR` | yes | The corridor (manifest rev 2) |
| `PXE_BRIDGE_MAY_BROADCAST_URL` / `_TOKEN` | yes | Riddler's may-broadcast endpoint |
| `PXE_BRIDGE_OXIDE_ALLOWLIST_SEED` / `_RECIPIENTS` | yes | The private recipient allowlist ([settlement-operations.md](settlement-operations.md#oxide-mode-the-private-allowlist-xochi751-xochi775-option-a)) |
| `PXE_BRIDGE_OXIDE_MAX_PER_TX` | no, 1,000 DAI | Per-transaction cap, base units; never above the token's 5,166 DAI note cap |
| `PXE_BRIDGE_OXIDE_DAILY_LIMIT` | no, 10,000 DAI | Rolling-24h cap, base units |
| `PXE_BRIDGE_ACCOUNT_ADDRESS` | production | The Oxide sender's recorded address |
| `PXE_BRIDGE_ATTESTATION_API_KEY`, `_SECRET_ARN` (dev: `_SECRET_KEY`), `_SOURCE_CHAIN_ID`, `_ENVIRONMENT`, `_RELAY_URL` / `_RELAY_TOKEN` | for OX-11 | The readiness attestation producer ([settlement-operations.md](settlement-operations.md#recipient-readiness-attestations)); without it no recipient binding becomes ready. Startup warns when absent |

**Startup refuses** (`src/oxide/config.ts`): an unknown `PXE_BRIDGE_SEND_MODE`;
any `PXE_BRIDGE_OXIDE_*` variable outside Oxide mode; in Oxide mode any
spending-limit or generic-limit variable (`PXE_BRIDGE_SPENDING_LIMIT_ADMIN`,
`_SPENDING_LIMIT_TOKEN`, `PXE_BRIDGE_ACCOUNT_DEPLOYMENT`,
`PXE_BRIDGE_DEPLOYER_FEE_JUICE_CLAIM`, `PXE_BRIDGE_ALLOWLIST_RECIPIENTS`,
`PXE_BRIDGE_MAX_AMOUNT`, `PXE_BRIDGE_DAILY_LIMIT`, `PXE_BRIDGE_COOLDOWN_*`);
a missing required variable, one file for both journals, a non-http(s) L1
RPC, or caps that exceed the note cap or each other.

The live deployment (L1, manifest, profile, portal, enclave) is checked before
every fresh attempt and resend, not at startup, so an outage there never stops
`aztec_getSettlement`. A deployment that is no longer the pinned one
(`oxide_pin_mismatch`, `enclave_refused:*`) is PERMANENT (OX-6): re-pin and
ship a new release. See settlement-operations.md "Oxide readiness".

A schema-1 Oxide journal opens with writes disabled (`unknown_schema_version`);
start Oxide mode on a fresh file. Never delete a schema-2 journal that holds
unresolved operations.

### Funding the Oxide sender's private OXDAI balance

`npm run fund-oxide` performs the canonical Oxide deposit: approve the pinned
DAI portal, compute the recipient commitment, call `OxidePortal.deposit`, wait
for the L1-to-L2 message, then run `storeOxideDeposit` in the sender's PXE.
Helper and portal surface: `aztec-labs-eng/zkmoney-public` commit
`8fd198412a956f214639b5782d3a86e3d47ca60e` (`src/oxide/vendor/VENDORED.md`,
`src/oxide/portal-deposit.ts`).

Stop the Oxide bridge before the store phase (same wallet data directory). Set
`PXE_BRIDGE_ACCOUNT_ADDRESS` to the recorded sender. Every argument is
required and must equal the shipped Oxide v6 pins; the amount is DAI base
units.

Plan first (validates arguments and any existing state, no network, no state):

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

Live run: provide `L1_PRIVATE_KEY`, `PXE_BRIDGE_SECRET_KEY`,
`PXE_BRIDGE_OXIDE_L1_RPC_URL`, `AZTEC_NODE_URL` and
`PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT` from the secret store, never on the command
line; same arguments without `--dry-run`; `--wallet-data-dir` names the
bridge's wallet store when not the default.

The state path must not exist on the first run. It is a 0600 file holding the
salt and signed transactions, phases
`prepared -> approved -> deposited -> message_ready -> stored`. `deposited` is
written with the signed raw transaction **before broadcast**; after that only
those exact bytes are ever rebroadcast. Rerun the exact command with the same
state path after any interruption.

The state and every backup are secrets (they hold the salt). Back up with the
tool stopped:

```bash
install -m 600 '<OWNER_ONLY_STATE_PATH>' '<OWNER_ONLY_BACKUP_PATH>'
```

To recover, restore that file with mode 0600 and rerun the identical command.
Never edit it, choose a new state path or start another deposit. If both are
lost after preparation or broadcast, stop and recover the transaction and salt
from operator records. **Never submit a second L1 deposit.** Keep the `stored`
state as the receipt.

### Funding the sender's private OXDAI balance (split signer)

`oxide-deposit` never accepts a private key, signs or broadcasts. `prepare`
reads the salt from an open file descriptor and prints canonical DAI `approve`
and `OxidePortal.deposit` calldata:

```bash
exec 3</run/secrets/oxide-deposit-salt
npm run oxide-deposit -- prepare --amount-dai 25 --salt-fd 3 \
  > /tmp/oxide-deposit-plan.json
exec 3<&-
```

The plan pins Ethereum chain 1, DAI
`0x6B175474E89094C44Da98b954EedeAC495271d0F`, OXDAI
`0x11d2bed21a36289fd6f6a6af93a546b5be7115caf957f0f700f42d56e25fe0a3`,
rollup version `2070860440`, portal
`0xCB99C58Fe81Ae6b2cB4835e46F7b703745879042`, and the approved sender
`0x15ff3aa2270843241b4405bfc8ba72ae59b68c85996cff9e5c03daf03109cb22`. It
contains the recipient commitment, not the salt. Submit the approval and
deposit with an operator-held L1 signer outside pxe-bridge.

After the deposit is finalized, stop the bridge and store it with the same
salt and the confirmed **deposit** transaction hash:

```bash
export PXE_BRIDGE_OXIDE_DEPOSIT_JOURNAL=/var/lib/pxe-bridge/oxide-deposits.sqlite
export PXE_BRIDGE_OXIDE_DEPOSIT_HWM=/var/lib/pxe-bridge-hwm/oxide-deposits.hwm
export PXE_BRIDGE_WALLET_DATA_DIRECTORY=/var/lib/pxe-bridge/aztec-wallet-data
# Existing bridge settings are also required:
# AZTEC_NODE_URL, PXE_BRIDGE_OXIDE_L1_RPC_URL,
# PXE_BRIDGE_OXIDE_JOURNAL, PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT,
# PXE_BRIDGE_ACCOUNT_ADDRESS, PXE_BRIDGE_SECRET_ARN
exec 3</run/secrets/oxide-deposit-salt
npm run oxide-deposit -- store \
  --tx-hash 0xCONFIRMED_DEPOSIT_TRANSACTION_HASH \
  --salt-fd 3 \
  --initialize-journal
exec 3<&-
```

`--initialize-journal` is the one-time acknowledgement for a new deposit
journal; omit it later. Put `PXE_BRIDGE_OXIDE_DEPOSIT_HWM` on an owner-only
directory in a separate snapshot domain from the journal (the journal's own
directory is refused). Never replace or rewind either file. Run from the
shipped image (`dist/oxide/deposit-cli.js`) or a matching checkout, with the
production wallet volume at the exact `PXE_BRIDGE_WALLET_DATA_DIRECTORY`; the
deposit journal binds to that path, the approved account/token/deployment and
the send-journal ID. Unset the deposit-journal and HWM variables before
restarting the bridge. A raw `PXE_BRIDGE_SECRET_KEY` is refused.

Before touching PXE, `store` fetches the receipt and transaction and requires:

- chain 1, a successful receipt at or below the finalized head, and the same
  block hash from receipt, transaction and block;
- exactly one `Deposit` event from the pinned portal, canonical `deposit`
  calldata, the approved sender's salt-bound recipient commitment, matching
  amount, message key and inbox index;
- the portal's DAI `UNDERLYING`, OXDAI `L2_TOKEN`, rollup version and exact
  1,000 DAI cap at the receipt block;
- no amount above 1,000 DAI and no local rolling 24-hour total above 10,000
  DAI (the 5,166 DAI note maximum is also checked);
- the event's L1-to-L2 message present in the PXE's latest message tree.

The journal is keyed by transaction hash and event identity and writes
`submitting` before the one `store_deposit` call. A completed row replays as
`already_stored`. A row left at `submitting` refuses a second store, whatever
the interruption: preserve both journals and inspect the PXE state. Balance
deltas are never reconciliation evidence (an unrelated credit can match);
until a PXE view keyed by inbox index exists, the ambiguous row stays
`submitting`.
