#!/usr/bin/env bash
# xochi-fi/xochi#633 recipient-account compatibility spike. Sandbox only.
# Run from the repo root after `npm ci` and `(cd spike/633-recipient-schnorr && npm ci)`.
set -euo pipefail

S=spike/633-recipient-schnorr
export SPIKE_STATE_DIR="${SPIKE_STATE_DIR:-$(mktemp -d -t spike-633)}"
echo "state: $SPIKE_STATE_DIR"

# Mine L1 blocks so anvil's `finalized` (head - 64) passes the proof txs. The
# sandbox mines L1 only on demand, so L2 `finalized` never moves on its own.
mine_l1() {
  curl -sf -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"anvil_mine","params":["0x46"]}' \
    "${L1_RPC_URL:-http://localhost:8545}" >/dev/null
}
field() { node -e "console.log(require('$SPIKE_STATE_DIR/public.json')['$1'])"; }

docker compose -p pxe633 up -d --wait anvil aztec-sandbox

npx tsx "$S/class-identity.ts"                       # items 1-3, offline
npx tsx "$S/sender.ts" setup                         # sender account + token + public mint
npx tsx "$S/recipient.ts" create                     # recipient keys + descriptor (own PXE)
npx tsx "$S/recipient.ts" deploy                     # waits up to 10 min, logs tips
mine_l1 && npx tsx "$S/finality.ts" "$(field recipientDeployTx)" 120
npx tsx "$S/check-descriptor.ts"                     # node-only descriptor + class check
npx tsx "$S/sender.ts" pay 1000                      # transfer_to_private -> recipient
npx tsx "$S/recipient.ts" receive                    # note discovery in recipient PXE
npx tsx "$S/recipient.ts" spend 400                  # private transfer back to sender
npx tsx "$S/sender.ts" balance
mine_l1 && npx tsx "$S/finality.ts" "$(field spendTxHash)" 120
npx tsx "$S/recipient.ts" sign                       # Schnorr over the reduced digest
npx tsx "$S/verifier/run.ts"                         # standalone verifier vs bb.js
# Worker: (cd $S/verifier && wrangler dev --port 8799) then
#   npx tsx $S/verifier/workerd-check.ts http://127.0.0.1:8799

docker compose -p pxe633 down -v
