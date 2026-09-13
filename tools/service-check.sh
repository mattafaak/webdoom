#!/usr/bin/env bash
# service-check.sh — webdoom.service is a READY systemd unit (promises rme-009).
#
# README:41 claims the repo ships a ready systemd unit and nothing checked it:
# no boot test, no service-file validation, not one assertion.
#
# `systemd-analyze verify` alone is NOT this gate.  On a good unit it exits 0
# and prints NOTHING, so a leg wrapping it bare is a quiet exit-0 -- it cannot
# distinguish "the unit is sound" from "the check did nothing", which is the
# shape CLAUDE.md names.  So this script makes its own assertions, COUNTS them,
# and prints the count; the count is the evidence, not the exit code.
#
# What it cannot check, stated rather than implied: whether the unit actually
# BOOTS. That needs root and a live systemd. This gate is about the unit file.
set -uo pipefail
cd "$(dirname "$0")/.."

UNIT=webdoom.service
fails=0
checks=0
ok ()   { checks=$((checks+1)); }
bad ()  { checks=$((checks+1)); fails=$((fails+1)); echo "FAIL service-check: $1"; }

[ -f "$UNIT" ] || { echo "FAIL service-check: $UNIT not found"; exit 1; }

# 1. systemd's own parser.  Warnings go to stderr and still exit 0, so the
#    OUTPUT is graded, not just the status.
out=$(systemd-analyze verify "./$UNIT" 2>&1); rc=$?
if [ $rc -ne 0 ]; then bad "systemd-analyze verify exited $rc: $out"
elif [ -n "$out" ]; then bad "systemd-analyze verify warned: $out"
else ok; fi

# 2. The directives a "ready" unit must carry.  A unit missing Restart or
#    [Install] parses clean and is not ready.
for d in Description After Wants Type User WorkingDirectory ExecStart Restart WantedBy; do
    if grep -qE "^${d}=" "$UNIT"; then ok; else bad "no ${d}= directive"; fi
done

# 3. ExecStart must name a program that exists and a script this repo ships.
exec_line=$(grep -E '^ExecStart=' "$UNIT" | head -1 | cut -d= -f2-)
prog=$(echo "$exec_line" | awk '{print $1}')
script=$(echo "$exec_line" | awk '{print $2}')
if [ -x "$prog" ]; then ok; else bad "ExecStart program not executable here: $prog"; fi
if [ -n "$script" ] && [ -f "$script" ]; then ok; else bad "ExecStart script not in this repo: ${script:-<none>}"; fi

# 4. WorkingDirectory must name a directory whose basename is this repo's, so a
#    unit pointing at someone else's checkout is caught.  The absolute path is
#    deliberately NOT asserted: it is correct only on the author's box.
wd=$(grep -E '^WorkingDirectory=' "$UNIT" | head -1 | cut -d= -f2-)
if [ "$(basename "$wd")" = "$(basename "$PWD")" ]; then ok
else bad "WorkingDirectory basename '$(basename "$wd")' != repo dir '$(basename "$PWD")'"; fi

# 5. The env the unit pins must agree with the server's own defaults, or the
#    unit silently serves somewhere else than every doc says.
for pair in DOOM_HOST:13 DOOM_PORT:14; do
    var=${pair%%:*}
    unit_val=$(grep -E "^Environment=${var}=" "$UNIT" | head -1 | cut -d= -f3-)
    srv_val=$(grep -oE "${var} \?\? '?[0-9A-Za-z.]+'?" server/serve.js | head -1 |
              sed -E "s/.*\?\? '?([0-9A-Za-z.]+)'?/\1/")
    if [ -z "$unit_val" ]; then bad "$var not pinned in the unit"
    elif [ "$unit_val" = "$srv_val" ]; then ok
    else bad "$var: unit says '$unit_val', server/serve.js defaults to '$srv_val'"; fi
done

# A run that asserted nothing must not read as a pass.
if [ "$checks" -lt 10 ]; then
    echo "FAIL service-check: only $checks assertion(s) ran — the check did not check"
    exit 1
fi
if [ "$fails" -gt 0 ]; then
    echo "FAIL service-check: $fails of $checks assertions failed on $UNIT"
    exit 1
fi
echo "PASS service-check: $UNIT is a ready unit ($checks assertions: parser clean, 9 directives, ExecStart resolves, WorkingDirectory + DOOM_HOST/DOOM_PORT agree with server/serve.js)"
