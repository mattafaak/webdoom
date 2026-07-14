#!/bin/bash
# webdoom launcher: one process, one port. Binds all interfaces so LAN
# and tailnet clients just open http://<this-host>:8666/
set -e
cd "$(dirname "$0")"

export DOOM_HOST="${DOOM_HOST:-0.0.0.0}"
export DOOM_PORT="${DOOM_PORT:-8666}"

[ -f build/doom.wasm ] || { echo "no engine build — run: source tools/emsdk-env.sh && make -C engine"; exit 1; }
[ -f wads/manifest.json ] || { echo "no WADs — run: tools/fetch-wads.sh"; exit 1; }

exec node server/serve.js
