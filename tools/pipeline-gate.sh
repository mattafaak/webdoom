#!/usr/bin/env bash
# tools/pipeline-gate.sh — browser-pipeline metrics vs this host's baseline.
#
# Hostname-gated: a host with no committed baseline cannot be compared, and must
# say so rather than pass.  Dedicated port 8693 (12.2b stale-server lesson).
#
# Extracted from run-tests.sh in task 21.1.  The inline version ended with
#     node tools/browser-pipeline-compare.mjs ... ; _BP_RC=$? ; if [ $_BP_RC -ne 0 ]
# under `set -e`, so the comparison's failure aborted the script at the compare
# line and lines 211-216 — the diagnostic and the temp-file cleanup — never ran.
# Fail-closed, but the reason never printed and the JSON leaked into /tmp.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="$(hostname)"
BASELINE="tools/golden/browser-pipeline-${HOST}.json"
if [ ! -f "$BASELINE" ]; then
    echo "SKIP browser-pipeline: no baseline for host '${HOST}'"
    echo "  add $BASELINE to gate this host"
    exit 0
fi

PORT=8693
CURRENT="$(mktemp -t browser-pipeline-current-XXXXXX.json)"
SRV=""
cleanup() {
    [ -n "$SRV" ] && { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; } || true
    rm -f "$CURRENT"
}
trap cleanup EXIT

DOOM_PORT="$PORT" DOOM_HOST=127.0.0.1 node server/serve.js >/dev/null 2>&1 &
SRV=$!
for _ in $(seq 1 40); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
    sleep 0.25
done
# A poll that proceeds anyway is a sleep with extra steps.
#
# This loop broke on success and then fell straight through on failure, so a
# server that never came up was measured against regardless -- exactly the
# 12.2b shape (a stale or absent server served to the collector), in the two
# files that own their own ports and never took the runner's
# assert_port_owned. Fail closed, and say which port.
if ! curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    echo "FAIL browser-pipeline: server on ${PORT} never became ready — nothing was measured" >&2
    exit 1
fi

node tools/browser-pipeline.mjs --url "http://127.0.0.1:$PORT/" --json > "$CURRENT"
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null || true
SRV=""

rc=0
CMP_OUT="$(node tools/browser-pipeline-compare.mjs --baseline "$BASELINE" --current "$CURRENT")" || rc=$?
printf '%s\n' "$CMP_OUT"
COMPARED="$(printf '%s\n' "$CMP_OUT" | grep -oE '[0-9]+ of [0-9]+ checks compared' | tail -1)"
COMPARED="${COMPARED:-count not reported by the comparator}"
if [ "$rc" -ne 0 ]; then
    echo "FAIL browser-pipeline: regression against $BASELINE (see comparison above)"
    exit "$rc"
fi
# The comparator already prints "PASS (N of M checks compared)".  This wrapper
# line used to be the LAST ^PASS, and run-tests.sh's headline() takes the last
# one -- so a countless sentence displaced a counted one in the summary table.
# Carry the count up instead of overwriting it.
echo "PASS browser-pipeline: within tolerance of $BASELINE ($COMPARED)"
