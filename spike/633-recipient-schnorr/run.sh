#!/usr/bin/env bash
# xochi-fi/xochi#633 recipient-account compatibility spike. Sandbox only, on the
# compose sandbox (aztecprotocol/aztec:5.2.0) with the root @aztec/* 5.2.0 SDK.
# Run from the repo root after `npm ci` and `(cd spike/633-recipient-schnorr && npm ci)`.
# Host ports: SPIKE_L1_PORT (anvil, default 8545), SPIKE_NODE_PORT (node,
# default 8080), WORKER_PORT (wrangler dev, default 8799); L1_RPC_URL and
# AZTEC_NODE_URL are derived from the first two.
set -euo pipefail

S=spike/633-recipient-schnorr
# A plain assignment, so a failing mktemp aborts the run under set -e.
if [ -z "${SPIKE_STATE_DIR:-}" ]; then
  tmp="${TMPDIR:-/tmp}"
  SPIKE_STATE_DIR="$(mktemp -d "${tmp%/}/spike-633.XXXXXX")"
fi
export SPIKE_STATE_DIR
export SPIKE_L1_PORT="${SPIKE_L1_PORT:-8545}"
export SPIKE_NODE_PORT="${SPIKE_NODE_PORT:-8080}"
export L1_RPC_URL="http://127.0.0.1:$SPIKE_L1_PORT"
export AZTEC_NODE_URL="http://127.0.0.1:$SPIKE_NODE_PORT"
# One compose project per run, so a failed or concurrent run never shares state.
PROJECT="${SPIKE_COMPOSE_PROJECT:-pxe633-$(date +%s)-$$}"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f "$S/compose.ports.yml")
WORKER_PORT="${WORKER_PORT:-8799}"
WORKER_URL="http://127.0.0.1:$WORKER_PORT"
WORKER_PID=""
echo "state: $SPIKE_STATE_DIR  compose project: $PROJECT  L1: $L1_RPC_URL  node: $AZTEC_NODE_URL  worker: $WORKER_URL"

# Refuse a host port something already listens on. Docker Desktop published
# 127.0.0.1:8545 for the sandbox's anvil while a local anvil was listening on
# it, with no error, so a client could reach the local anvil instead (and
# finality.ts would mine it).
for port in "$SPIKE_L1_PORT" "$SPIKE_NODE_PORT" "$WORKER_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "FAIL host port $port is already in use; set SPIKE_L1_PORT / SPIKE_NODE_PORT / WORKER_PORT"
    exit 1
  fi
done

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
  "${COMPOSE[@]}" down -v || { echo "compose down failed for $PROJECT"; [ "$rc" -ne 0 ] || rc=1; }
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

"${COMPOSE[@]}" up -d --wait anvil aztec-sandbox

npx tsx "$S/class-identity.ts"                       # items 1-3, offline
npx tsx "$S/sender.ts" setup                         # sender account + token + public mint
npx tsx "$S/recipient.ts" create                     # recipient keys + descriptor (own PXE)
npx tsx "$S/recipient.ts" deploy                     # account deploy, asserted mined
npx tsx "$S/finality.ts" "$(field recipientDeployTx)" 300   # proven -> mine L1 -> finalized
npx tsx "$S/check-descriptor.ts"                     # node-only descriptor + class check
for m in initializerless immutables artifact-hash init-hash; do expect_refused "$m"; done
npx tsx "$S/sender.ts" pay 1000                      # transfer_to_private -> recipient
npx tsx "$S/recipient.ts" receive                    # note discovery in recipient PXE
npx tsx "$S/recipient.ts" spend 400                  # private transfer back to sender
npx tsx "$S/sender.ts" balance
npx tsx "$S/finality.ts" "$(field spendTxHash)" 300
npx tsx "$S/recipient.ts" sign                       # Schnorr over the reduced digest
npx tsx "$S/verifier/run.ts"                         # case table: pure-JS vs bb.js

# The same case table inside workerd, with the Wrangler pinned in package.json.
set -m # own process group, so stop_worker reaches workerd too
(cd "$S/verifier" && WRANGLER_SEND_METRICS=false exec npx --no-install wrangler dev \
  --port "$WORKER_PORT" --ip 127.0.0.1 </dev/null) &
WORKER_PID=$!
set +m
ready=""
for _ in $(seq 120); do
  kill -0 "$WORKER_PID" 2>/dev/null || { echo "FAIL wrangler dev exited before ready"; exit 1; }
  if curl -s --connect-timeout 1 --max-time 3 -o /dev/null "$WORKER_URL/"; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { echo "FAIL wrangler dev not ready after 120 attempts"; exit 1; }
npx tsx "$S/verifier/workerd-check.ts" "$WORKER_URL"
stop_worker
