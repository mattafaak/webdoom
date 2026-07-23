#!/usr/bin/env bash
# tools/gate.sh — run a gate and report its TRUE exit code.
#
# Usage:
#   bash tools/gate.sh <label> -- <command> [args...]
#   bash tools/gate.sh --tail 5 <label> -- <command> [args...]
#   bash tools/gate.sh --full <label> -- <command> [args...]
#
# Why this exists
# ---------------
# Six times in this project an exit code was read after a pipe and reported
# wrong:  `node tools/demo-test.mjs | tail -1` then `$?` yields tail's status
# (always 0), not the gate's.  A red gate got reported green.  The cause is
# structural, not carelessness: the command and the status check are two
# separate steps, so there is always a chance to check the wrong thing.
#
# This wrapper removes the second step.  The command runs WITHOUT a pipeline
# (output goes to a temp file), so `$?` is exact, and the status is printed as
# part of the same output as the log tail:
#
#     GATE demo-sim rc=0
#
# There is nothing left to pair up by hand, and nothing to forget.
#
# Trimming output is the reason people reach for `| tail` in the first place,
# so this does it for you — from the file, after the code is already captured.
# On failure it widens the tail automatically, because that is exactly when
# the extra context is wanted.
#
# The script exits with the command's real code, so it composes normally with
# `set -e`, `&&`, and CI runners.

set -uo pipefail        # deliberately NOT -e: we must survive a failing gate
                        # in order to report its code

TAIL_LINES=2
FAIL_TAIL_LINES=25
SHOW_FULL=0

while [ $# -gt 0 ]; do
    case "$1" in
        --tail) TAIL_LINES="$2"; shift 2 ;;
        --full) SHOW_FULL=1; shift ;;
        --) shift; break ;;
        *)
            if [ -z "${LABEL:-}" ]; then LABEL="$1"; shift
            else break
            fi
            ;;
    esac
done

if [ -z "${LABEL:-}" ] || [ $# -eq 0 ]; then
    echo "usage: bash tools/gate.sh [--tail N] [--full] <label> -- <command> [args...]" >&2
    exit 2
fi

LOG="$(mktemp -t "webdoom-gate-${LABEL//[^A-Za-z0-9_-]/_}-XXXXXX.log")"
trap 'rm -f "$LOG"' EXIT

# The command is NOT in a pipeline: $? below is the command's own status.
"$@" > "$LOG" 2>&1
rc=$?

if [ "$SHOW_FULL" -eq 1 ]; then
    cat "$LOG"
elif [ "$rc" -ne 0 ]; then
    tail -n "$FAIL_TAIL_LINES" "$LOG"
else
    tail -n "$TAIL_LINES" "$LOG"
fi

echo "GATE $LABEL rc=$rc"
exit "$rc"
