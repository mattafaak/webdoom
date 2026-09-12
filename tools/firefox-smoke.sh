#!/usr/bin/env bash
# tools/firefox-smoke.sh — Firefox loads the page and executes JS.
#
# Asserts, from the server's own request log:
#   (1) a Firefox UA fetched something (the page HTML parsed)
#   (2) /api/wads was requested (lobby.js ran — JS executed)
# It does NOT assert that a frame rendered; there is no CDP equivalent for
# Firefox in this repo and geckodriver is not present.  spec.md records that
# limit deliberately, and README's "stock Chrome / Edge / Firefox" rests on it.
#
# Extracted from run-tests.sh in task 21.1.  The inline version counted matches
# with `$(grep -c X f || echo 0)`: grep -c prints 0 AND exits 1 when nothing
# matches, so the fallback fired IN ADDITION to grep's own output and the
# variable became the two-line string "0\n0", which `[ -gt 0 ]` then rejected
# with "integer expression expected".  It failed closed, but it reported the
# wrong thing in the one case it exists to describe.  awk counts instead.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8675   # dedicated (12.2b stale-server lesson)
LOG="$(mktemp -t ff-smoke-XXXXXX.log)"
PROFILE="$(mktemp -d -t ff-profile-XXXXXX)"
SRV=""
cleanup() {
    [ -n "$SRV" ] && { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; } || true
    rm -rf "$PROFILE" "$LOG"
}
trap cleanup EXIT

DOOM_PORT="$PORT" DOOM_HOST=127.0.0.1 LOG_REQUESTS=1 node server/serve.js 2>"$LOG" >/dev/null &
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
    echo "FAIL firefox smoke: server on ${PORT} never became ready — nothing was measured" >&2
    exit 1
fi

# Let Firefox execute JS for a few seconds, then kill it.  No --screenshot: the
# service-worker registration and /api/wads fetch are async and must complete
# before the process exits.  timeout's rc=124 is expected.
timeout 11 firefox --headless --no-remote --profile "$PROFILE" \
    "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || true
sleep 1   # let in-flight requests land in the log

kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null || true
SRV=""

UA=$(awk '/Firefox\//{n++} END{print n+0}' "$LOG")
WADS=$(awk '/\/api\/wads/{n++} END{print n+0}' "$LOG")
echo "  Firefox UA requests: $UA   /api/wads requests: $WADS"

if [ "$UA" -gt 0 ] && [ "$WADS" -gt 0 ]; then
    echo "PASS firefox smoke: Firefox UA confirmed, JS executed ($UA UA hits, $WADS /api/wads)"
    exit 0
fi
echo "FAIL firefox smoke: Firefox UA=$UA /api/wads=$WADS (expected both > 0)"
exit 1
