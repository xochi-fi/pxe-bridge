#!/usr/bin/env bash
# xochi-fi/xochi#633 recipient-account compatibility spike against the Aztec
# PUBLIC TESTNET (node default https://aztec-testnet.drpc.org; override with
# AZTEC_NODE_URL). Uses only this directory's @aztec-labs 6.0.0 SDK (and
# rc3/'s 6.0.0-rc.3 for one offline comparison), never the bridge's 5.2.0.
# Run from the repo root after
#   (cd spike/633-recipient-schnorr-testnet && npm ci) && (cd spike/633-recipient-schnorr-testnet/rc3 && npm ci)
# Sends one tx: a throwaway SchnorrAccount deploy, fee paid by the testnet's
# SponsoredFPC. Keys are generated per run into SPIKE_STATE_DIR (0600) and
# hold no funds. FINALITY_SECONDS bounds the wait for L2 `finalized`.
set -euo pipefail

S=spike/633-recipient-schnorr-testnet
TSX="$S/node_modules/.bin/tsx"
if [ -z "${SPIKE_STATE_DIR:-}" ]; then
  tmp="${TMPDIR:-/tmp}"
  SPIKE_STATE_DIR="$(mktemp -d "${tmp%/}/spike-633-testnet.XXXXXX")"
fi
export SPIKE_STATE_DIR
FINALITY_SECONDS="${FINALITY_SECONDS:-5400}"
echo "state: $SPIKE_STATE_DIR  node: ${AZTEC_NODE_URL:-https://aztec-testnet.drpc.org (default)}"

field() { node -e "console.log(require('$SPIKE_STATE_DIR/public.json')['$1'])"; }

# A forged descriptor must be refused by check-descriptor.ts before address
# derivation or any node call, for the case's own reason (exit 2).
expect_refused() {
  local rc=0
  "$TSX" "$S/check-descriptor.ts" --mutate "$1" || rc=$?
  if [ "$rc" -ne 2 ]; then
    echo "FAIL negative $1: check-descriptor exited $rc, expected 2 (refused)"
    exit 1
  fi
  echo "PASS negative $1: refused"
}

"$TSX" "$S/class-identity.ts"                       # (a) offline id, (b) derivation, (c) ABI
(cd "$S/rc3" && node_modules/.bin/tsx class-id.ts)  # the same class under 6.0.0-rc.3, for comparison
"$TSX" "$S/testnet-node.ts"                         # node version, SponsoredFPC, class record before
"$TSX" "$S/recipient.ts" create                     # throwaway keys + public descriptor
for m in initializerless immutables artifact-hash init-hash; do expect_refused "$m"; done
"$TSX" "$S/recipient.ts" deploy                     # (d) deploy via SponsoredFPC, asserted mined
"$TSX" "$S/finality.ts" "$(field recipientDeployTx)" "$FINALITY_SECONDS"   # (d) finalized + init nullifier
"$TSX" "$S/check-descriptor.ts"                     # (a)(b)(d) node instance/class vs descriptor and pin
echo "run.sh complete; state in $SPIKE_STATE_DIR"
