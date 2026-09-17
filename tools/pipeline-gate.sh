#!/usr/bin/env bash
# tools/pipeline-gate.sh — the browser-pipeline leg: collect, then compare.
#
# A host without a committed baseline SKIPs by name.  That is the correct
# behaviour and not a gap (Phase Z: alder-only by policy); `load-budget` uses
# the same pattern.
#
# This script used to spawn the server itself on a fixed port 8693 with its own
# curl-poll loop -- a copy of firefox-smoke.sh's block, which was a copy of the
# runner's.  browser-pipeline.mjs starts its own server through
# tools/lib/server.mjs now (free port, polled ready), so the only thing left
# here is the two-step the leg actually exists for.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="$(hostname)"
BASELINE="tools/golden/browser-pipeline-${HOST}.json"
if [ ! -f "$BASELINE" ]; then
    echo "SKIP browser-pipeline: no baseline for host '${HOST}'"
    echo "  add $BASELINE to gate this host"
    exit 0
fi

CURRENT="$(mktemp -t browser-pipeline-current-XXXXXX.json)"
trap 'rm -f "$CURRENT"' EXIT

node tools/browser-pipeline.mjs --json > "$CURRENT"

rc=0
CMP_OUT="$(node tools/browser-pipeline-compare.mjs --baseline "$BASELINE" --current "$CURRENT")" || rc=$?
printf '%s\n' "$CMP_OUT"

COMPARED="$(printf '%s\n' "$CMP_OUT" | grep -oE '[0-9]+ of [0-9]+ checks compared' | tail -1)"
COMPARED="${COMPARED:-count not reported by the comparator}"
if [ "$rc" -ne 0 ]; then
    echo "FAIL browser-pipeline: regression against $BASELINE (see comparison above)"
    exit "$rc"
fi
echo "PASS browser-pipeline: within tolerance of $BASELINE ($COMPARED)"
