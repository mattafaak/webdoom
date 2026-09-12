#!/usr/bin/env bash
# tools/n64/run-n64-demos.sh — N64 ares sim-hash gate (task 20.4c).
#
# Builds N64 ROMs for 13 demos across 4 IWADs, runs each under ares, reads the
# per-tic sim-hash trace the ROM PRINTS on completion, and compares it against
# tools/golden/<iwad>-<demo>.json bit-by-bit.
#
# The ROM runs `-timedemo <demo> -nodraw` -- the same argv tools/demo-test.mjs
# records the golden with, because a differential is only a differential if both
# sides run the same command line.  On completion the timing I_Error longjmps out
# and n64_dump_trace() prints the whole trace between N64_TRACE_BEGIN/END markers,
# which is what this script parses.  There is no debugger in the loop: see
# tools/n64/n64_hash.c for why the GDB-stub extraction path was replaced.
#
# DoD: exits 0 iff all 13 traces match golden bit-identically.
# Partial results are reported honestly with the count.
#
# Prerequisites:
#   source ~/toolchains/env.sh  (mips64-elf-gcc, ares, N64_INST)
#   wads/lib/ populated with doom.wad, doom2.wad, tnt.wad, plutonia.wad
#   xvfb-run (for headless ares)
#   python3
#
# Usage:
#   bash tools/gate.sh n64-demos -- bash tools/n64/run-n64-demos.sh
#
# Engine/core: 0-diff.  Only tools/n64/ changes.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GOLDEN_DIR="$REPO_ROOT/tools/golden"
N64_DIR="$SCRIPT_DIR"
WORK_DIR="$N64_DIR/n64_trace_work"

# Toolchain environment (mips64-elf-gcc, ares, N64_INST, LIBDRAGON, etc.)
if [ -f "$HOME/toolchains/env.sh" ]; then
    # shellcheck source=/dev/null
    . "$HOME/toolchains/env.sh"
fi

# Timeout in seconds per demo run.
# Longest demo: plutonia-demo1 = 7403 tics @ 35 Hz = ~211 s real-time.
# ares typically runs at 150–300 % speed; 600 s is generous.
RUN_TIMEOUT=600

ARES="${ARES:-ares}"

# ── Sanity checks ────────────────────────────────────────────────────────────

if ! command -v "$ARES" >/dev/null 2>&1; then
    echo "run-n64-demos: ERROR: ares not found on PATH (try: source ~/toolchains/env.sh)" >&2
    exit 1
fi

if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "run-n64-demos: ERROR: xvfb-run not found (install xvfb package)" >&2
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "run-n64-demos: ERROR: python3 not found" >&2
    exit 1
fi

# ── Demo manifest ────────────────────────────────────────────────────────────
# Format: "iwad_key:wad_filename:wad_name_for_engine:demo_name"
# wad_name_for_engine: what IdentifyVersion() sees in d_main.c:592-630.
# doom.wad is Ultimate DOOM → present as doomu.wad.

DEMOS="
doom:doom.wad:doomu.wad:demo1
doom:doom.wad:doomu.wad:demo2
doom:doom.wad:doomu.wad:demo3
doom:doom.wad:doomu.wad:demo4
doom2:doom2.wad:doom2.wad:demo1
doom2:doom2.wad:doom2.wad:demo2
doom2:doom2.wad:doom2.wad:demo3
tnt:tnt.wad:tnt.wad:demo1
tnt:tnt.wad:tnt.wad:demo2
tnt:tnt.wad:tnt.wad:demo3
plutonia:plutonia.wad:plutonia.wad:demo1
plutonia:plutonia.wad:plutonia.wad:demo2
plutonia:plutonia.wad:plutonia.wad:demo3
"

# Optional filter: run only the tags matching $1 (a grep -E pattern over
# "<iwad>-<demo>").  The full 13-demo fan-out is minutes of emulation per demo,
# so bisecting one demo must not cost a full run.  A filter that matches
# NOTHING is a hard error, not an empty green -- an empty run would otherwise
# print "all N64 sim-hash goldens bit-identical (0 demos)".
FILTER="${1:-}"
if [ -n "$FILTER" ]; then
    KEPT=""
    for e in $DEMOS; do
        k="${e%%:*}"; r="${e#*:}"; r="${r#*:}"; d="${r#*:}"
        if printf '%s' "$k-$d" | grep -qE "$FILTER"; then KEPT="$KEPT$e
"; fi
    done
    if [ -z "$KEPT" ]; then
        echo "run-n64-demos: ERROR: filter '$FILTER' matched none of the 13 demos" >&2
        exit 2
    fi
    DEMOS="$KEPT"
    echo "run-n64-demos: filter '$FILTER' selected $(printf '%s' "$DEMOS" | grep -c .) of 13 demos"
fi

NDEMOS=$(printf '%s' "$DEMOS" | grep -c .)
TOTAL=0
PASS=0
FAIL=0
FAIL_NAMES=""

mkdir -p "$WORK_DIR"

# ── Helper: reap the emulator ────────────────────────────────────────────────
# ares is started under `setsid`, so $ARES_PID is a session leader and its
# process-group id equals its pid.  Killing the GROUP (the negative pid) takes
# xvfb-run, Xvfb and ares together.
#
# Killing $ARES_PID alone is NOT enough and this was observed, not assumed: it
# is xvfb-run's pid, and a run left ares alive and still holding a socket after
# the script had exited.  The previous reaper looked the process up by whoever
# held the GDB port -- which cannot work now that the harness no longer asks
# ares to open one, and would have silently reaped nothing.
kill_ares_group() {
    local pid="$1"
    [ -n "$pid" ] || return 0
    kill -TERM -- "-$pid" 2>/dev/null || true
    # Give it a moment, then insist.
    for _ in 1 2 3 4 5; do
        kill -0 -- "-$pid" 2>/dev/null || return 0
        sleep 1
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
}

# Leave no emulator running even on an abort or a Ctrl-C mid-demo.
cleanup() {
    kill_ares_group "${ARES_PID:-}"
}
trap cleanup EXIT

# ── Main loop ────────────────────────────────────────────────────────────────

for entry in $DEMOS; do
    [ -z "$entry" ] && continue

    IWAD_KEY="${entry%%:*}"; rest="${entry#*:}"
    WAD_FILE="${rest%%:*}";  rest="${rest#*:}"
    WAD_NAME="${rest%%:*}";  DEMO="${rest#*:}"

    WAD_PATH="$REPO_ROOT/wads/lib/$WAD_FILE"
    TAG="${IWAD_KEY}-${DEMO}"
    ELF="$WORK_DIR/${TAG}.elf"
    ROM="$WORK_DIR/${TAG}.z64"
    ARES_LOG="$WORK_DIR/${TAG}.ares.log"
    TRACE_TXT="$WORK_DIR/${TAG}.trace.txt"

    TOTAL=$((TOTAL + 1))

    echo ""
    echo "=== [$TOTAL/$NDEMOS] Building $TAG ==="

    if [ ! -f "$WAD_PATH" ]; then
        echo "FAIL: $TAG — WAD not found: $WAD_PATH"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(missing-wad)"
        continue
    fi

    # Rebuild EVERY shim object, not a hand-picked subset.  make cannot see a
    # changed -D flag -- the sources have not changed, so an object compiled for
    # the previous demo or the previous IWAD is "up to date" and gets reused with
    # the wrong constants baked in.
    #
    # This used to remove n64_main.o always and n64_hash.o on an IWAD change.
    # Both choices were wrong: n64_hash.c uses none of these macros, while
    # files_n64.c uses N64_WAD_NAME and was never removed -- so every doom2, tnt
    # and plutonia ROM registered its WAD under the FIRST IWAD's name.  Picking
    # which objects to invalidate by hand is the bug; the shim is nine small
    # files, so rebuild all of them and stop guessing.  (engine/core takes the
    # same -D flags but reads none of them, so it stays cached.)
    rm -rf "$N64_DIR/obj/plat"

    # Build ROM.  Parallelise across CPUs; route only tail of stdout.
    if ! make -j"$(nproc)" -C "$N64_DIR" \
            N64_WAD="$WAD_PATH" \
            N64_WAD_NAME="$WAD_NAME" \
            N64_TIMEDEMO="$DEMO" \
            OUT_ELF="$ELF" \
            OUT_ROM="$ROM" 2>&1 | tail -4; then
        echo "FAIL: $TAG — make failed"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(build-fail)"
        continue
    fi

    if [ ! -f "$ELF" ] || [ ! -f "$ROM" ]; then
        echo "FAIL: $TAG — ROM/ELF missing after make"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(build-fail)"
        continue
    fi

    echo "=== [$TOTAL/$NDEMOS] Running $TAG under ares ==="

    rm -f "$ARES_LOG" "$TRACE_TXT"
    ARES_PID=""
    setsid timeout "$RUN_TIMEOUT" xvfb-run -a "$ARES" \
        --system "Nintendo 64" \
        --no-file-prompt "$ROM" \
        >"$ARES_LOG" 2>&1 &
    ARES_PID=$!

    # Wait for the ROM to print its END marker, or for ares to die, or for the
    # budget to run out.  Polling the LOG rather than the process means a ROM
    # that finishes and then spins (which is exactly what it does) is detected
    # immediately instead of at the timeout.
    WAITED=0
    while [ "$WAITED" -lt "$RUN_TIMEOUT" ]; do
        if grep -q "N64_TRACE_END" "$ARES_LOG" 2>/dev/null; then break; fi
        if ! kill -0 "$ARES_PID" 2>/dev/null; then break; fi
        sleep 5
        WAITED=$((WAITED + 5))
    done

    kill_ares_group "$ARES_PID"
    ARES_PID=""

    # The ROM prints the WAD name compiled into files_n64.c.  Assert it before
    # looking at any hash: a ROM built against the wrong IWAD identity can still
    # produce a full trace (tnt registered as doom2 is commercial either way),
    # and that trace would be compared against the right golden and reported as
    # a simulation divergence.  Fail on the identity, by name.
    if ! grep -q "registry name '$WAD_NAME'" "$ARES_LOG" 2>/dev/null; then
        GOT=$(grep -o "registry name '[^']*'" "$ARES_LOG" 2>/dev/null | head -1)
        echo "FAIL: $TAG - ROM registered the wrong IWAD identity: expected '$WAD_NAME', log says ${GOT:-<nothing>}"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(wrong-wad-identity)"
        continue
    fi

    if ! grep -q "N64_TRACE_END" "$ARES_LOG" 2>/dev/null; then
        echo "FAIL: $TAG - no N64_TRACE_END marker after ${WAITED}s (see $ARES_LOG)"
        tail -5 "$ARES_LOG" >&2 || true
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(no-trace)"
        continue
    fi

    # Compare trace against golden.
    GOLDEN="$GOLDEN_DIR/${TAG}.json"
    if [ ! -f "$GOLDEN" ]; then
        echo "FAIL: $TAG — golden not found: $GOLDEN"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(no-golden)"
        continue
    fi

    # Parse the printed trace and compare against the JSON golden.
    RESULT=$(python3 - "$ARES_LOG" "$GOLDEN" "$TRACE_TXT" << 'PYEOF'
import sys, json

ares_log, golden_path, trace_out = sys.argv[1], sys.argv[2], sys.argv[3]

# latin1: ares's log carries emulator chatter that is not guaranteed UTF-8, and
# a decode error here must not read as a hash mismatch.
lines = open(ares_log, encoding='latin1').read().splitlines()
begin = [i for i, l in enumerate(lines) if l.startswith('N64_TRACE_BEGIN')]
end   = [i for i, l in enumerate(lines) if l.startswith('N64_TRACE_END')]
if not begin or not end:
    print("FAIL:no_markers")
    sys.exit(0)
b, e = begin[0], end[0]
declared = int(lines[b].split()[1])

trace = []
try:
    for l in lines[b + 1:e]:
        trace += [int(x, 16) for x in l.split()]
except ValueError as ex:
    print(f"FAIL:unparseable_trace_line:{ex}")
    sys.exit(0)

# The ROM states its own length before printing.  If the printed body does not
# match that count, the log was truncated or interleaved -- which must be a
# named failure, not a length mismatch blamed on the simulation.
if declared != len(trace):
    print(f"FAIL:truncated_log:declared={declared},parsed={len(trace)}")
    sys.exit(0)

open(trace_out, 'w').write('\n'.join(f'{h:08x}' for h in trace) + '\n')

golden   = json.load(open(golden_path))
expected = [int(x) for x in golden['trace']]

if len(trace) != len(expected):
    print(f"FAIL:len_mismatch:n64={len(trace)},golden={len(expected)}")
    sys.exit(0)

first_bad = next((i for i, (a, x) in enumerate(zip(trace, expected)) if a != x), None)
if first_bad is not None:
    bad = sum(1 for a, x in zip(trace, expected) if a != x)
    print(f"FAIL:hash_mismatch:first_at_tic={first_bad},"
          f"n64=0x{trace[first_bad]:08x},"
          f"golden=0x{expected[first_bad]:08x},"
          f"mismatches={bad}/{len(expected)}")
    sys.exit(0)

print(f"PASS:{len(trace)}_tics")
PYEOF
)

    if [[ "$RESULT" == PASS:* ]]; then
        echo "PASS: $TAG ($RESULT)"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $TAG — $RESULT"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG($RESULT)"
    fi
done

# ── Final report ─────────────────────────────────────────────────────────────

echo ""
if [ "$FAIL" -eq 0 ]; then
    if [ -n "$FILTER" ]; then
    echo "PASS — N64 sim-hash bit-identical ($PASS demos, FILTERED by '$FILTER' — NOT the full 13)"
else
    echo "PASS — all N64 sim-hash goldens bit-identical ($PASS demos)"
fi
    exit 0
else
    echo "FAIL — $PASS/$TOTAL N64 sim-hash demos matched golden"
    echo "Failed:$FAIL_NAMES"
    exit 1
fi
