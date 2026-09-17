#!/usr/bin/env bash
# tools/deploy.sh — put the working tree on the running server.
#
# WHY THIS EXISTS.  webdoom.service runs `node server/serve.js` straight out of
# ~/projects/webdoom, so the CLIENT files it serves are whatever is on disk
# right now, while the SERVER process is whatever was running when it started.
# The two drift apart silently and nothing noticed: on 2026-09-17 the live
# service had been up since before round 10, serving round-10 client files from
# a round-9 server -- so the LAN launcher fetched /api/thumb (404) and got no
# compression, and the only symptom was box art that never appeared.
#
# A restart drops anyone mid-game, so this refuses while a game is live and
# says how many players.  --force overrides.
#
# usage:
#   bash tools/deploy.sh            # gate, then restart if nobody is playing
#   bash tools/deploy.sh --force    # restart anyway
#   bash tools/deploy.sh --check    # report drift and stop, change nothing
#
# Copyright (C) 2026, GPL-2.0-or-later.
set -uo pipefail
cd "$(dirname "$0")/.."

UNIT=webdoom.service
PORT="${DOOM_PORT:-8666}"
BASE="http://127.0.0.1:${PORT}"
FORCE=0
CHECK=0
for a in "$@"; do
    case "$a" in
        --force) FORCE=1 ;;
        --check) CHECK=1 ;;
        -h|--help) sed -n '/^# usage:/,/^#$/p' "$0"; exit 0 ;;
        *) echo "unknown argument '$a' (see --help)" >&2; exit 2 ;;
    esac
done

say () { printf '  %s\n' "$*"; }

# ── 1. is the unit even ours, and when did it start ──────────────────────────
if ! systemctl is-active --quiet "$UNIT"; then
    echo "deploy: $UNIT is not active — nothing to redeploy"
    echo "  start it with: sudo systemctl start $UNIT"
    exit 1
fi
STARTED="$(systemctl show -p ActiveEnterTimestamp --value "$UNIT")"
STARTED_S="$(date -d "$STARTED" +%s 2>/dev/null || echo 0)"
# The newest thing the RUNNING process would have read at startup.
NEWEST_S="$(find server -type f -name '*.js' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)"
NEWEST_S="${NEWEST_S:-0}"
if [ "$NEWEST_S" -gt "$STARTED_S" ]; then
    say "STALE: server/ was modified $(( (NEWEST_S - STARTED_S) / 60 )) min after the service started"
    STALE=1
else
    say "fresh: the running service is newer than everything in server/"
    STALE=0
fi
say "unit started: $STARTED"

# ── 2. who would a restart drop ──────────────────────────────────────────────
STATUS="$(curl -fsS --max-time 5 "$BASE/api/status" 2>/dev/null)"
if [ -z "$STATUS" ]; then
    say "WARNING: $BASE/api/status did not answer — this build predates it, or the server is wedged"
    PLAYERS=0
else
    PLAYERS="$(printf '%s' "$STATUS" | grep -oE '"players":[0-9]+' | cut -d: -f2)"
    PLAYERS="${PLAYERS:-0}"
    say "live: $STATUS"
fi

if [ "$CHECK" = "1" ]; then
    [ "$STALE" = "1" ] && { echo "deploy --check: STALE (restart to pick up server/ changes)"; exit 1; }
    echo "deploy --check: the running service matches server/"
    exit 0
fi

if [ "$PLAYERS" -gt 0 ] && [ "$FORCE" = "0" ]; then
    echo "deploy: REFUSING — $PLAYERS player(s) are in a game right now."
    echo "  A restart drops them mid-level.  Re-run with --force when the LAN is idle."
    exit 1
fi

# ── 3. the tree has to pass before it ships ──────────────────────────────────
say "running the quick tier..."
if ! bash tools/run-tests.sh --quick --jobs 3 >/tmp/webdoom-deploy-quick.log 2>&1; then
    echo "deploy: REFUSING — the quick tier is red (see /tmp/webdoom-deploy-quick.log)"
    tail -20 /tmp/webdoom-deploy-quick.log
    exit 1
fi
say "quick tier green"

# ── 4. restart, then prove the new server is the one answering ───────────────
systemctl restart "$UNIT" || { echo "deploy: systemctl restart failed (polkit rule missing?)"; exit 1; }
for _ in $(seq 1 40); do
    curl -fsS --max-time 3 -o /dev/null "$BASE/" 2>/dev/null && break
    sleep 0.25
done

fails=0
probe () {   # probe <name> <curl args...>
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then say "ok   $name"; else say "FAIL $name"; fails=$((fails+1)); fi
}
probe "page answers"          curl -fsS --max-time 5 "$BASE/"
probe "/api/status answers"   curl -fsS --max-time 5 "$BASE/api/status"
# the two round-10 features whose absence was the symptom
THUMB="$(curl -fsS --max-time 5 -o /dev/null -w '%{size_download}' "$BASE/api/thumb/doom.wad" 2>/dev/null || echo 0)"
if [ "$THUMB" = "5568" ]; then say "ok   /api/thumb/doom.wad is 5,568 bytes"; else say "FAIL /api/thumb/doom.wad returned $THUMB bytes (want 5568)"; fails=$((fails+1)); fi
ENC="$(curl -fsS --max-time 5 -H 'Accept-Encoding: br' -o /dev/null -D - "$BASE/" 2>/dev/null | grep -i '^content-encoding:' | tr -d '\r' | awk '{print $2}')"
if [ "$ENC" = "br" ]; then say "ok   / negotiates br"; else say "FAIL / content-encoding is '${ENC:-none}', want br"; fails=$((fails+1)); fi

if [ "$fails" -gt 0 ]; then
    echo "deploy: restarted, but $fails probe(s) failed — the service is up and something is wrong"
    exit 1
fi
echo "deploy: $UNIT restarted and serving this tree ($(git rev-parse --short HEAD))"
