#!/usr/bin/env bash
# xochi-fi/xochi#633 recipient-account compatibility spike. Sandbox only, on the
# compose sandbox (aztecprotocol/aztec:5.2.0) with the root @aztec/* 5.2.0 SDK.
# Run from the repo root after `npm ci` and `(cd spike/633-recipient-schnorr && npm ci)`.
# Set L1_RPC_URL when anvil is not published on localhost:8545.
set -euo pipefail

S=spike/633-recipient-schnorr
export SPIKE_STATE_DIR="${SPIKE_STATE_DIR:-$(mktemp -d -t spike-633)}"
# One compose project per run, so a failed or concurrent run never shares state.
PROJECT="${SPIKE_COMPOSE_PROJECT:-pxe633-$(date +%s)-$$}"
WORKER_PORT="${WORKER_PORT:-8799}"
WORKER_PID=""
echo "state: $SPIKE_STATE_DIR  compose project: $PROJECT"

# Mine L1 blocks so anvil's `finalized` (head - 64) passes the proof txs. The
# sandbox mines L1 only on demand, so L2 `finalized` never moves on its own.
mine_l1() {
  curl -sf -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"anvil_mine","params":["0x46"]}' \
    "${L1_RPC_URL:-http://localhost:8545}" >/dev/null
}
field() { node -e "console.log(require('$SPIKE_STATE_DIR/public.json')['$1'])"; }

stop_worker() {
  [ -n "$WORKER_PID" ] || return 0
  # The Worker runs in its own process group (npx -> wrangler -> workerd).
  kill -TERM -- "-$WORKER_PID" 2>/dev/null || echo "worker group $WORKER_PID already gone"
  wait "$WORKER_PID" 2>/dev/null || echo "worker exited with status $?"
  WORKER_PID=""
}

# Every exit path, failures included, stops the Worker and removes the sandbox,
# keeping the status of the command that ended the run. Installed before `up`
# so a sandbox that never turns healthy is removed too.
cleanup() {
  local rc=$?
  stop_worker
  docker compose -p "$PROJECT" down -v || { echo "compose down failed for $PROJECT"; [ "$rc" -ne 0 ] || rc=1; }
  echo "run.sh exit status $rc"
  exit "$rc"
}
trap cleanup EXIT

# A forged descriptor must be refused by check-descriptor.ts before address
# derivation or any node call, for the case's own reason (exit 2).
expect_refused() {
  local rc=0
  npx tsx "$S/check-descriptor.ts" --mutate "$1" || rc=$?
  if [ "$rc" -ne 2 ]; then
    echo "FAIL negative $1: check-descriptor exited $rc, expected 2 (refused)"
    exit 1
  fi
  echo "PASS negative $1: refused"
}

docker compose -p "$PROJECT" up -d --wait anvil aztec-sandbox

npx tsx "$S/class-identity.ts"                       # items 1-3, offline
npx tsx "$S/sender.ts" setup                         # sender account + token + public mint
npx tsx "$S/recipient.ts" create                     # recipient keys + descriptor (own PXE)
npx tsx "$S/recipient.ts" deploy                     # waits up to 10 min, logs tips
mine_l1
npx tsx "$S/finality.ts" "$(field recipientDeployTx)" 120
npx tsx "$S/check-descriptor.ts"                     # node-only descriptor + class check
for m in initializerless immutables artifact-hash init-hash; do expect_refused "$m"; done
npx tsx "$S/sender.ts" pay 1000                      # transfer_to_private -> recipient
npx tsx "$S/recipient.ts" receive                    # note discovery in recipient PXE
npx tsx "$S/recipient.ts" spend 400                  # private transfer back to sender
npx tsx "$S/sender.ts" balance
mine_l1
npx tsx "$S/finality.ts" "$(field spendTxHash)" 120
npx tsx "$S/recipient.ts" sign                       # Schnorr over the reduced digest
npx tsx "$S/verifier/run.ts"                         # standalone verifier vs bb.js

# The same verifier inside workerd, with the Wrangler pinned in package.json.
set -m # own process group, so stop_worker reaches workerd too
(cd "$S/verifier" && WRANGLER_SEND_METRICS=false exec npx --no-install wrangler dev \
  --port "$WORKER_PORT" --ip 127.0.0.1 </dev/null) &
WORKER_PID=$!
set +m
for _ in $(seq 120); do
  kill -0 "$WORKER_PID" 2>/dev/null || { echo "FAIL wrangler dev exited before ready"; exit 1; }
  curl -s -o /dev/null "http://127.0.0.1:$WORKER_PORT/" && break
  sleep 1
done
curl -s -o /dev/null "http://127.0.0.1:$WORKER_PORT/" || { echo "FAIL wrangler dev not ready after 120s"; exit 1; }
npx tsx "$S/verifier/workerd-check.ts" "http://127.0.0.1:$WORKER_PORT"
stop_worker
