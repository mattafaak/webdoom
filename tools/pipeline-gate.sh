#!/usr/bin/env bash
# tools/pipeline-gate.sh — browser-pipeline metrics vs this host's baseline.
#
# Hostname-gated: a host with no committed baseline cannot be compared, and must
# say so rather than pass.  Dedicated port 8677 (12.2b stale-server lesson).
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

PORT=8677
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

node tools/browser-pipeline.mjs --url "http://127.0.0.1:$PORT/" --json > "$CURRENT"
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null || true
SRV=""

rc=0
node tools/browser-pipeline-compare.mjs --baseline "$BASELINE" --current "$CURRENT" || rc=$?
if [ "$rc" -ne 0 ]; then
    echo "FAIL browser-pipeline: regression against $BASELINE (see comparison above)"
    exit "$rc"
fi
echo "PASS browser-pipeline: within tolerance of $BASELINE"
