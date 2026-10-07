#!/usr/bin/env bash
# tools/floor/run-x86.sh — the floor gate on the host: fs-doom over all 13
# demos, a correctness run (mode A) and a timing run (mode B) each, then
# tools/floor/floor-gate.mjs.  The verdict is DEMAND: x86 instructions per tic,
# the demand every other target is measured against.
#
# Instructions are counted with perf_event_open, and on a hybrid CPU that
# counter belongs to one core type: on an E-core it counts nothing (measured:
# 1,710 of 1,710 tics read 0).  So every run is pinned to a P-core, one per
# job; the gate refuses a tic that took 0.
#
# usage: bash tools/floor/run-x86.sh [out_dir]
# Copyright (C) 2026, GPL-2.0-or-later.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/tools/floor/out-x86}"
FS="$ROOT/tools/freestanding/fs-doom"
WADS="$ROOT/wads/lib"
[ -x "$FS" ] || { echo "FAIL floor-x86: $FS not built (make -C tools/freestanding)"; exit 1; }
BUILD="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ -n "$(git -C "$ROOT" status --porcelain -- engine tools/freestanding tools/floor 2>/dev/null)" ] && BUILD="$BUILD+dirty"

# P-cores: the cpu_core PMU's CPUs on a hybrid part, else every CPU
expand () { local r a b; for r in ${1//,/ }; do a=${r%-*}; b=${r#*-}; seq "$a" "$b"; done; }
if [ -r /sys/devices/cpu_core/cpus ]; then
    mapfile -t CPUS < <(expand "$(cat /sys/devices/cpu_core/cpus)")
else
    mapfile -t CPUS < <(seq 0 $(( $(nproc) - 1 )))
fi

rm -rf "$OUT"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DEMOS=(
    "doom.wad     doomu.wad    demo1 doom-demo1"
    "doom.wad     doomu.wad    demo2 doom-demo2"
    "doom.wad     doomu.wad    demo3 doom-demo3"
    "doom.wad     doomu.wad    demo4 doom-demo4"
    "doom2.wad    doom2.wad    demo1 doom2-demo1"
    "doom2.wad    doom2.wad    demo2 doom2-demo2"
    "doom2.wad    doom2.wad    demo3 doom2-demo3"
    "tnt.wad      tnt.wad      demo1 tnt-demo1"
    "tnt.wad      tnt.wad      demo2 tnt-demo2"
    "tnt.wad      tnt.wad      demo3 tnt-demo3"
    "plutonia.wad plutonia.wad demo1 plutonia-demo1"
    "plutonia.wad plutonia.wad demo2 plutonia-demo2"
    "plutonia.wad plutonia.wad demo3 plutonia-demo3"
)

jobs_run=0
fails=0
pids=()
for entry in "${DEMOS[@]}"; do
    read -r src as demo name <<< "$entry"
    [ -f "$WADS/$src" ] || { echo "FAIL floor-x86: $WADS/$src absent (tools/fetch-wads.sh)"; exit 1; }
    mkdir -p "$TMP/$name"
    ln -sf "$WADS/$src" "$TMP/$name/$as"
    for mode in A B; do
        cpu="${CPUS[$(( jobs_run % ${#CPUS[@]} ))]}"
        ( WD_CYCLES=1 WD_BUILD="$BUILD" WD_FLOOR_MODE=$mode WD_FLOOR_NAME="$name" \
              taskset -c "$cpu" "$FS" "$TMP/$name/$as" -timedemo "$demo" \
              -floor "$OUT/$name.$mode.log" > /dev/null 2> "$OUT/$name.$mode.err" ) &
        pids+=($!)
        jobs_run=$(( jobs_run + 1 ))
        if [ $(( jobs_run % ${#CPUS[@]} )) -eq 0 ]; then
            for p in "${pids[@]}"; do wait "$p" || fails=$(( fails + 1 )); done
            pids=()
        fi
    done
done
for p in "${pids[@]}"; do wait "$p" || fails=$(( fails + 1 )); done
[ "$fails" -eq 0 ] || { echo "FAIL floor-x86: $fails fs-doom run(s) exited non-zero (see $OUT/*.err)"; exit 1; }

echo "floor-x86: $jobs_run runs of fs-doom ($BUILD), pinned to ${#CPUS[@]} CPU(s)"

# The tic flags come from floor_wrap.c's --wrap hooks.  Every attract demo opens
# with a level load, so a demo with no L tic, or a run that counted no bytes
# out of the WAD, means the hooks were not linked: the demand would then
# silently include the 4-42 M-instruction load tics.
node -e '
const fs = require("fs"), dir = process.argv[1];
const logs = fs.readdirSync(dir).filter(f => f.endsWith(".A.log"));
const noLoad = logs.filter(f => !/^T \d+ \d+ \d+ \S*L/m.test(fs.readFileSync(dir + "/" + f, "utf8")));
const anyMiss = logs.some(f => /^T .* (\S*,)?M:\d+/m.test(fs.readFileSync(dir + "/" + f, "utf8")));
if (noLoad.length) { console.log(`FAIL floor-x86: ${noLoad.length} of ${logs.length} demos have no load tic: the --wrap hooks did not fire (${noLoad[0]})`); process.exit(1); }
if (!anyMiss) { console.log("FAIL floor-x86: no tic copied a byte out of the WAD: the memcpy hook did not fire"); process.exit(1); }
' "$OUT" || exit 1
exec node "$ROOT/tools/floor/floor-gate.mjs" "$OUT"/*.log
