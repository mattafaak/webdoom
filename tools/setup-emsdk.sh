#!/bin/bash
# Installs the pinned emsdk locally if the shared install is unavailable.
set -e
EMSDK_DIR="${EMSDK_DIR:-$HOME/projects/bee-kettle-doom/emsdk}"
EMSDK_VERSION=6.0.2

if [ -x "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
    echo "emsdk already present at $EMSDK_DIR"
    exit 0
fi

EMSDK_DIR="$(cd "$(dirname "$0")" && pwd)/emsdk"
git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
"$EMSDK_DIR/emsdk" install "$EMSDK_VERSION"
"$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION"
echo "installed. export EMSDK_DIR=$EMSDK_DIR then source tools/emsdk-env.sh"
