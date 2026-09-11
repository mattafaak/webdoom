#!/usr/bin/env bash
# tools/build-toggle.sh — build one compile-time toggle into its own artifact dir.
#
#   bash tools/build-toggle.sh WEBDOOM_FAKEFLAT build-fakeflat
#   bash tools/build-toggle.sh '' build-invariants WEBDOOM_INVARIANTS
#
# The shipping build/ is never touched: each toggle gets its own BUILD and OUT so
# the byte-identity claims in docs/optimization-ledger.md stay checkable.
set -euo pipefail
cd "$(dirname "$0")/.."

DEFINE="${1:?usage: build-toggle.sh <DEFINE> <build-dir>}"
BUILD_DIR="${2:?usage: build-toggle.sh <DEFINE> <build-dir>}"

# shellcheck source=/dev/null
source tools/emsdk-env.sh

echo "building -D$DEFINE into $BUILD_DIR/"
cd engine
make -j8 EXTRA_CFLAGS="-D$DEFINE" BUILD="../$BUILD_DIR" OUT="../$BUILD_DIR/doom.js" 2>&1 | tail -3
echo "PASS build-toggle: $DEFINE -> $BUILD_DIR/doom.js"
