#!/bin/bash
# Build an instrumented Chocolate Doom (the vanilla reference port) that
# prints the same per-tic fingerprint webdoom exports, for
#   node tools/demo-test.mjs --cross <path-to-binary>
# Chocolate is demo-exact against DOS vanilla; matching it tic-for-tic is
# the strongest available proof of vanilla compatibility.
# Needs: git, cmake, gcc, SDL2 + SDL2_mixer + SDL2_net dev packages.
set -eo pipefail
cd "$(dirname "$0")"

DIR="${1:-/tmp/webdoom-choco}"
git clone --depth 1 https://github.com/chocolate-doom/chocolate-doom.git "$DIR/src" 2>/dev/null || true
(cd "$DIR/src" && git apply --check "$PWD/../../choco-trace.patch" 2>/dev/null \
    && git apply "$PWD/../../choco-trace.patch") || true
# (git apply paths are relative to the clone; fall back to plain patch)
if ! grep -q WebdoomTrace "$DIR/src/src/doom/g_game.c"; then
    patch -d "$DIR/src" -p1 < choco-trace.patch
fi

cmake -S "$DIR/src" -B "$DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$DIR/build" -j"$(nproc)" --target chocolate-doom
echo
echo "reference binary: $DIR/build/src/chocolate-doom"
echo "run: node tools/demo-test.mjs --cross $DIR/build/src/chocolate-doom"
