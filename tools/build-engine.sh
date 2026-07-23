#!/bin/bash
# Build wrapper that sources emsdk and runs make
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMSDK_DIR="${EMSDK_DIR:-$HOME/projects/bee-kettle-doom/emsdk}"
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
exec make -C "$SCRIPT_DIR/../engine" "$@"
