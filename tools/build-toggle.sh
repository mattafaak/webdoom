#!/usr/bin/env bash
# tools/build-toggle.sh — build one compile-time toggle into its own artifact dir.
#
#   bash tools/build-toggle.sh WEBDOOM_INVARIANTS build-invariants
#
# The shipping build/ is never touched: each toggle gets its own BUILD and OUT so
# the byte-identity claims in docs/optimization-ledger.md stay checkable.
set -euo pipefail
cd "$(dirname "$0")/.."

DEFINE="${1:?usage: build-toggle.sh <DEFINE> <build-dir>}"
BUILD_DIR="${2:?usage: build-toggle.sh <DEFINE> <build-dir>}"

# shellcheck source=/dev/null
source tools/emsdk-env.sh

# The toggle builds back the byte-identity claims in docs/optimization-ledger.md.
# Those are claims about a specific compiler; emsdk-env.sh only warned on drift,
# into a stderr stream the build log trimmed away (task 21.8).
if [ "${EMSDK_PIN_OK:-0}" != "1" ] && [ "${WEBDOOM_ALLOW_EMCC_DRIFT:-0}" != "1" ]; then
    echo "FAIL build-toggle: emcc is not the pinned toolchain; byte-identity claims are not"
    echo "                   meaningful across compiler versions."
    echo "                   Install the pin, or set WEBDOOM_ALLOW_EMCC_DRIFT=1 to build anyway."
    exit 1
fi

echo "building -D$DEFINE into $BUILD_DIR/"
cd engine
make -j8 EXTRA_CFLAGS="-D$DEFINE" BUILD="../$BUILD_DIR" OUT="../$BUILD_DIR/doom.js" 2>&1 | tail -3
echo "PASS build-toggle: $DEFINE -> $BUILD_DIR/doom.js"
