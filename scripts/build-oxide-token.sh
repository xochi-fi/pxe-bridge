#!/usr/bin/env bash
# Builds the OxideToken artifact the Oxide sender registers
# (PXE_BRIDGE_OXIDE_TOKEN_ARTIFACT) from the Noir sources vendored in
# contracts/oxide (src/oxide/vendor/VENDORED.md), then refuses it unless its
# contract class is the deployed OXDAI class.
#
#   npm run build:oxide-token
#
# Writes contracts/oxide/oxide_token_contract/target/oxide_token_contract-OxideToken.json
# (gitignored, ~4 MB). The class ID covers the bytecode, the verification keys
# and the artifact hash, so it only matches when every input is the one OXDAI
# was built from:
#
#   - the sources at zkmoney-public 8fd19841 (Oxide 3b5e1f7c8), as vendored;
#   - the aztec-up 6.0.0 toolchain (aztec, aztec-nargo, bb), upstream's
#     AZTEC_TOOLCHAIN_VERSION in vendor/oxide/aztec-toolchain.sh;
#   - upstream's compile flags (vendor/oxide/noir-projects/bootstrap.sh):
#     `aztec compile --silence-warnings --inliner-aggressiveness 0`;
#   - the git dependencies the Nargo.toml files name by tag (aztec-node v6.0.0,
#     noir-lang keccak256 v0.1.3, sha256 v0.2.1, noir_base64 v0.5.1), fetched
#     by nargo. A tag can move; the class check below is what catches that.
#
# HARDWARE_CONCURRENCY=1 for the same reason as the CI `contract` job: bb
# derives verification keys one per thread otherwise, and has emitted a wrong
# key that way, which moves the class ID.
set -euo pipefail

cd "$(dirname "$0")/.."

AZTEC_TOOLCHAIN_VERSION="6.0.0"
PACKAGE="oxide_token_contract"
DIR="contracts/oxide/$PACKAGE"
ARTIFACT="$DIR/target/$PACKAGE-OxideToken.json"

# `aztec compile` and bb.js read these to pick another nargo or bb; the
# toolchain's own must win (upstream aztec-toolchain.sh does the same).
unset NARGO BB BB_BINARY_PATH
# Keeps the `aztec` shim from re-executing through a .aztecrc's version.
export AZTEC_VERSIONED=1

for tool in node aztec aztec-nargo; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool not found on PATH. Install the toolchain: aztec-up install $AZTEC_TOOLCHAIN_VERSION && aztec-up use $AZTEC_TOOLCHAIN_VERSION" >&2
    exit 1
  }
done
found="$(aztec --version 2>/dev/null | tail -1 || true)"
if [ "$found" != "$AZTEC_TOOLCHAIN_VERSION" ]; then
  echo "aztec --version reports '${found:-nothing}'; OXDAI was built with $AZTEC_TOOLCHAIN_VERSION." >&2
  echo "Fix: aztec-up install $AZTEC_TOOLCHAIN_VERSION && aztec-up use $AZTEC_TOOLCHAIN_VERSION" >&2
  exit 1
fi

rm -f "$ARTIFACT" "$ARTIFACT.bak"
(cd "$DIR" && HARDWARE_CONCURRENCY=1 aztec compile --silence-warnings --inliner-aggressiveness 0 --package "$PACKAGE")
# The pre-transpile copy `aztec compile` leaves beside the artifact. Not the
# artifact, and the image would otherwise carry both.
rm -f "$ARTIFACT.bak"

npx tsx scripts/oxide-token-artifact.ts "$ARTIFACT"
