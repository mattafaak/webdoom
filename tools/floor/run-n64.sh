#!/usr/bin/env bash
# tools/floor/run-n64.sh — the floor gate on the emulated N64 (ares).
#
# Builds a render-mode ROM per demo (tools/n64, N64_FLOOR=A|B: no -nodraw),
# runs each under ares, extracts the FLOOR log the ROM prints after its demo
# (between N64_FLOOR_BEGIN/END), and grades the logs with floor-gate.mjs.
#
#   default        mode A once and mode B twice per demo, then the floor gate,
#                  then floor-stats.mjs's per-demo summary.  The gate FAILs
#                  today on audio alone: the N64 build has none (music_events=0,
#                  sfx_starts=0).  Its worst-graded-tic line and the CPU-only
#                  PREDICTED line from floor-stats are the timing evidence.
#   --correctness  mode A only, graded with floor-gate --correctness: every
#                  tic's sim and render hash on all 13 demos (the n64-floor leg).
#
# The time unit is COP0 COUNT (unit=count, unit_hz=46875000: half of the
# VR4300's 93.75 MHz), so the 35 Hz budget is 1,339,285 counts per tic.  ares
# is deterministic in emulated time: two mode B runs agree to the count, and
# running it unthrottled (Audio/Blocking=false, Video/Blocking=false) changes
# no count, only the wall time.
#
# usage: bash tools/floor/run-n64.sh [--correctness] [--filter RE] [--jobs N]
#            [--out DIR] [--work DIR] [--nodraw] [--golden-dir DIR]
#            [--cart-dma 0|1] [--expansion-pak] [--interpreter]
#            [--xprof FILE [--no-homebrew] [--cal-skew N]] [--regrade]
#            [--timing-once] [--zone-kb N]
#   --filter RE      only demos whose <iwad>-<demo> matches (grep -E); the gate
#                    then grades those alone and the run says it is FILTERED
#   --nodraw         build the mode A ROMs with -nodraw (the red-proof: the
#                    gate must refuse the frozen framebuffer at a named tic)
#   --golden-dir DIR grade against these goldens (the corrupted-golden red-proof)
#   --cart-dma 0     the word-by-word cartridge copy instead of PI DMA
#   --expansion-pak  run with ares's 8 MB Expansion Pak (a data point only:
#                    the graded configuration is the stock 4 MB console)
#   --interpreter    ares Developer/ForceInterpreter (full I-cache emulation)
#   --xprof FILE     profile builds: FILE lines "<iwad>-<demo> <tic,tic,...>";
#                    mode B with N64_XPROF=1 under HomebrewMode, no gate; the
#                    XPROF blocks land in OUT/<tag>.X.xprof
#   --no-homebrew    with --xprof: run without HomebrewMode (the profiler's
#                    red-proof: calibration must FAIL)
#   --cal-skew N     with --xprof: N calibration iterations outside the
#                    profiler (the calibration red-proof)
#   --regrade        grade the logs already in OUT; build and run nothing
#   --timing-once    mode B once per demo and floor-stats only (no mode A, no
#                    gate): a timing comparison, e.g. --cart-dma 0 against 1
#   --zone-kb N      the zone size (default 2560); above ~3,000 the ROM needs
#                    --expansion-pak
#
# Copyright (C) 2026, GPL-2.0-or-later.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
N64="$ROOT/tools/n64"
OUT="$ROOT/tools/floor/out-n64"
WORK="$N64/n64_floor_work"
CORRECTNESS=0; FILTER=""; JOBS=""; NODRAW=0; GOLDEN=""; CART_DMA=1
EXPAK=0; INTERP=0; XPROF=""; HOMEBREW=1; CAL_SKEW=0; REGRADE=0; ONCE=0; ZONE_KB="" 
while [ $# -gt 0 ]; do
    case "$1" in
        --correctness)   CORRECTNESS=1; shift ;;
        --filter)        FILTER="$2"; shift 2 ;;
        --jobs)          JOBS="$2"; shift 2 ;;
        --out)           OUT="$2"; shift 2 ;;
        --work)          WORK="$2"; shift 2 ;;
        --nodraw)        NODRAW=1; shift ;;
        --golden-dir)    GOLDEN="$2"; shift 2 ;;
        --cart-dma)      CART_DMA="$2"; shift 2 ;;
        --expansion-pak) EXPAK=1; shift ;;
        --interpreter)   INTERP=1; shift ;;
        --xprof)         XPROF="$2"; shift 2 ;;
        --no-homebrew)   HOMEBREW=0; shift ;;
        --cal-skew)      CAL_SKEW="$2"; shift 2 ;;
        --regrade)       REGRADE=1; shift ;;
        --timing-once)   ONCE=1; shift ;;
        --zone-kb)       ZONE_KB="$2"; shift 2 ;;
        -h|--help)       sed -n '/^# usage:/,/^# Copyright/p' "$0"; exit 0 ;;
        *) echo "run-n64: unknown argument '$1' (see --help)" >&2; exit 2 ;;
    esac
done
case "$CART_DMA" in 0|1) ;; *) echo "run-n64: --cart-dma takes 0 or 1" >&2; exit 2 ;; esac
# Absolute, because make runs in tools/n64 (-C): a relative OUT_ROM there
# names a different file from the one ares is then handed.  Measured: with a
# relative --work, every ROM landed under tools/n64/tools/n64/... and all 26
# ares starts of two runs found no ROM.
WORK="$(realpath -m -- "$WORK")"
OUT="$(realpath -m -- "$OUT")"
[ -n "$GOLDEN" ] && GOLDEN="$(realpath -m -- "$GOLDEN")"
[ -n "$XPROF" ] && XPROF="$(realpath -m -- "$XPROF")"

if [ -f "$HOME/toolchains/env.sh" ]; then
    # shellcheck source=/dev/null
    . "$HOME/toolchains/env.sh"
fi
for t in make node; do
    command -v "$t" >/dev/null 2>&1 || { echo "FAIL floor-n64: $t not found"; exit 1; }
done
if [ "$REGRADE" = 0 ]; then
    for t in ares xvfb-run "${N64_INST:-$HOME/toolchains/n64}/bin/mips64-elf-gcc"; do
        command -v "$t" >/dev/null 2>&1 || [ -x "$t" ] || { echo "FAIL floor-n64: $t not found (source ~/toolchains/env.sh)"; exit 1; }
    done
fi
[ -n "$JOBS" ] || JOBS=$(( $(nproc) / 2 > 0 ? $(nproc) / 2 : 1 ))

# "<tag> <wad file> <engine name> <demo>"; doom.wad is Ultimate DOOM and must be
# presented as doomu.wad (demo4 desyncs from tic 0 otherwise; docs/retro.md).
ALL_DEMOS=(
    "doom-demo1     doom.wad     doomu.wad    demo1"
    "doom-demo2     doom.wad     doomu.wad    demo2"
    "doom-demo3     doom.wad     doomu.wad    demo3"
    "doom-demo4     doom.wad     doomu.wad    demo4"
    "doom2-demo1    doom2.wad    doom2.wad    demo1"
    "doom2-demo2    doom2.wad    doom2.wad    demo2"
    "doom2-demo3    doom2.wad    doom2.wad    demo3"
    "tnt-demo1      tnt.wad      tnt.wad      demo1"
    "tnt-demo2      tnt.wad      tnt.wad      demo2"
    "tnt-demo3      tnt.wad      tnt.wad      demo3"
    "plutonia-demo1 plutonia.wad plutonia.wad demo1"
    "plutonia-demo2 plutonia.wad plutonia.wad demo2"
    "plutonia-demo3 plutonia.wad plutonia.wad demo3"
)
declare -A XTICS=()
if [ -n "$XPROF" ]; then
    [ -f "$XPROF" ] || { echo "run-n64: --xprof $XPROF: no such file" >&2; exit 2; }
    while read -r tag tics; do
        [ -n "$tag" ] && [ "${tag:0:1}" != "#" ] && XTICS[$tag]="$tics"
    done < "$XPROF"
fi
DEMOS=()
for e in "${ALL_DEMOS[@]}"; do
    read -r tag _ <<< "$e"
    if [ -n "$XPROF" ]; then [ -n "${XTICS[$tag]:-}" ] || continue; fi
    if [ -n "$FILTER" ] && ! grep -qE -- "$FILTER" <<< "$tag"; then continue; fi
    DEMOS+=("$e")
done
[ "${#DEMOS[@]}" -gt 0 ] || { echo "FAIL floor-n64: filter '${FILTER}' ${XPROF:+and --xprof $XPROF }selected none of the 13 demos"; exit 2; }
NAMES=$(for e in "${DEMOS[@]}"; do read -r tag _ <<< "$e"; printf '%s,' "$tag"; done); NAMES="${NAMES%,}"

if [ -n "$XPROF" ]; then MODES=(X); RUNS=(1)
elif [ "$CORRECTNESS" = 1 ]; then MODES=(A); RUNS=(1)
elif [ "$ONCE" = 1 ]; then MODES=(B); RUNS=(1)
else MODES=(A B); RUNS=(1 2); fi

BUILD="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ -n "$(git -C "$ROOT" status --porcelain -- engine tools/n64 tools/floor 2>/dev/null)" ] && BUILD="$BUILD+dirty"
[ "$CART_DMA" = 0 ] && BUILD="$BUILD+wordcopy"
[ "$NODRAW" = 1 ] && BUILD="$BUILD+nodraw"
[ -n "$ZONE_KB" ] && BUILD="$BUILD+zone${ZONE_KB}k"
ZONE_ARG=()
[ -n "$ZONE_KB" ] && ZONE_ARG=(N64_ZONE_KB="$ZONE_KB")

SETTINGS=(--setting Audio/Blocking=false --setting Video/Blocking=false)
[ "$EXPAK" = 1 ]  && SETTINGS+=(--setting Nintendo64/ExpansionPak=true)
[ "$INTERP" = 1 ] && SETTINGS+=(--setting Developer/ForceInterpreter=true)
[ -n "$XPROF" ] && [ "$HOMEBREW" = 1 ] && SETTINGS+=(--setting Developer/HomebrewMode=true)

T0=$(date +%s)
if [ "$REGRADE" = 0 ]; then
    rm -rf "$OUT" "$WORK"
    mkdir -p "$OUT" "$WORK"

    # ── build: the engine once, then every ROM in parallel ──────────────────
    # The engine objects read none of the per-ROM -D flags, so they are built
    # once into a directory every ROM links from; each ROM's shim objects get
    # their own directory, rebuilt from nothing (make cannot see a changed -D).
    if ! make -C "$N64" -j"$(nproc)" core-objs CORE_OBJ_DIR="$WORK/core" > "$WORK/core.build.log" 2>&1; then
        echo "FAIL floor-n64: the engine objects did not build (see $WORK/core.build.log)"; tail -5 "$WORK/core.build.log"; exit 1
    fi
    build_one() {   # tag wad name demo mode
        local tag=$1 wad=$2 name=$3 demo=$4 mode=$5 floor=$5 extra=()
        [ "$mode" = X ] && { floor=B; extra=(N64_XPROF=1 "N64_XPROF_TICS=${XTICS[$tag]}" "N64_XPROF_CAL_SKEW=$CAL_SKEW"); }
        [ "$mode" = A ] && [ "$NODRAW" = 1 ] && extra=(N64_FLOOR_NODRAW=1)
        make -C "$N64" CORE_OBJ_DIR="$WORK/core" OBJ_DIR="$WORK/obj/$tag.$mode" \
             N64_WAD="$ROOT/wads/lib/$wad" N64_WAD_NAME="$name" N64_TIMEDEMO="$demo" \
             N64_FLOOR="$floor" N64_FLOOR_NAME="$tag" N64_BUILD="$BUILD" N64_CART_DMA="$CART_DMA" \
             "${extra[@]}" "${ZONE_ARG[@]}" OUT_ELF="$WORK/$tag.$mode.elf" OUT_ROM="$WORK/$tag.$mode.z64" \
             > "$WORK/$tag.$mode.build.log" 2>&1
    }
    pids=(); what=()
    for e in "${DEMOS[@]}"; do
        read -r tag wad name demo <<< "$e"
        [ -f "$ROOT/wads/lib/$wad" ] || { echo "FAIL floor-n64: wads/lib/$wad absent (tools/fetch-wads.sh)"; exit 1; }
        for mode in "${MODES[@]}"; do
            while [ "$(jobs -rp | wc -l)" -ge "$(nproc)" ]; do wait -n || true; done
            build_one "$tag" "$wad" "$name" "$demo" "$mode" & pids+=($!); what+=("$tag.$mode")
        done
    done
    bfail=0
    for k in "${!pids[@]}"; do
        if ! wait "${pids[$k]}"; then
            echo "FAIL floor-n64: ${what[$k]} did not build (see $WORK/${what[$k]}.build.log)"; bfail=$((bfail + 1))
        fi
    done
    [ "$bfail" = 0 ] || exit 1
    for e in "${DEMOS[@]}"; do
        read -r tag _ <<< "$e"
        for mode in "${MODES[@]}"; do
            [ -s "$WORK/$tag.$mode.z64" ] || { echo "FAIL floor-n64: make succeeded but $WORK/$tag.$mode.z64 is absent"; exit 1; }
        done
    done
    RAM=$(grep -h "RDRAM in-use" "$WORK"/*.build.log | sort -u | tr -s ' ' | sed 's/^ //' | paste -sd'|' -)
    echo "floor-n64: built $(( ${#DEMOS[@]} * ${#MODES[@]} )) ROMs ($BUILD) in $(( $(date +%s) - T0 )) s; ${RAM}"

    # ── run: every ROM under ares, $JOBS at a time ──────────────────────────
    # Each ares is a setsid session leader, so its process-group id is its pid
    # and killing the group takes xvfb-run, Xvfb and ares together.  Only pids
    # this script started are ever signalled.
    # Each run writes its session leader's pid to a .pid file; on an abort the
    # trap kills every group named there (a background subshell's own pid is
    # not a process group, so it cannot be used for that).
    reap() { local f; for f in "$WORK"/*.pid; do [ -f "$f" ] && kill -TERM -- "-$(cat "$f")" 2>/dev/null; done; return 0; }
    trap reap EXIT
    # One X display per run.  `xvfb-run -a` picks a free display by looking
    # for /tmp/.X<n>-lock, and two runs starting together can pick the same
    # one: measured on the first 39-run pass, ares instances that printed
    # nothing at all (not a line of N64 output) and died.  Each run here gets
    # its own number from a block chosen by this script's pid, skipping any
    # that is locked.
    DISP_BASE=$(( 2000 + ($$ % 200) * 64 ))
    run_one() {   # tag mode k index
        local tag=$1 mode=$2 k=$3 n=$4 log="$WORK/$1.$2$3.ares.log" want="N64_FLOOR_END" t pid try disp
        [ "$mode" = B ] && want="N64_STAGES_END"
        [ "$mode" = X ] && want="N64_XPROF_END"
        for try in 1 2; do
            disp=$(( DISP_BASE + n * 2 + try - 1 ))
            while [ -e "/tmp/.X$disp-lock" ]; do disp=$(( disp + 128 )); done
            setsid timeout 3600 xvfb-run -n "$disp" ares --system "Nintendo 64" "${SETTINGS[@]}" \
                --no-file-prompt "$WORK/$tag.$mode.z64" > "$log" 2>&1 &
            pid=$!
            echo "$pid" > "$WORK/$tag.$mode$k.pid"
            t=0
            while [ "$t" -lt 3600 ]; do
                grep -q "^$want" "$log" 2>/dev/null && break
                kill -0 "$pid" 2>/dev/null || break
                # booted? a ROM prints its first line within a second or two
                if [ "$t" -ge 60 ] && ! grep -q "^N64 webdoom boot" "$log" 2>/dev/null; then break; fi
                sleep 2; t=$((t + 2))
            done
            kill -TERM -- "-$pid" 2>/dev/null || true
            for _ in 1 2 3 4 5; do kill -0 -- "-$pid" 2>/dev/null || break; sleep 1; done
            kill -KILL -- "-$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            rm -f "$WORK/$tag.$mode$k.pid"
            # An emulator that never booted the ROM is the harness's failure,
            # not the ROM's: retried once, and said so.  One that booted and
            # then stopped short is not retried.
            grep -q "^N64 webdoom boot" "$log" 2>/dev/null && break
            echo "$tag.$mode$k: ares never booted the ROM (display :$disp, attempt $try)" >> "$WORK/retries.log"
        done
    }
    T1=$(date +%s)
    idx=0
    for e in "${DEMOS[@]}"; do
        read -r tag _ <<< "$e"
        for mode in "${MODES[@]}"; do
            for k in "${RUNS[@]}"; do
                [ "$mode" = A ] && [ "$k" != 1 ] && continue
                while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n || true; done
                run_one "$tag" "$mode" "$k" "$idx" &
                idx=$((idx + 1))
            done
        done
    done
    wait || true
    trap - EXIT
    echo "floor-n64: ran $idx ROM(s) under ares (jobs=$JOBS, expansion_pak=$EXPAK, interpreter=$INTERP) in $(( $(date +%s) - T1 )) s"
    if [ -s "$WORK/retries.log" ]; then
        echo "floor-n64: $(wc -l < "$WORK/retries.log") emulator start(s) never booted the ROM and were retried:"
        sed 's/^/  /' "$WORK/retries.log"
    fi

    # ── extract: one FLOOR log per run, after checking what printed it ──────
    xfail=0
    for e in "${DEMOS[@]}"; do
        read -r tag _ name _ <<< "$e"
        for mode in "${MODES[@]}"; do
            for k in "${RUNS[@]}"; do
                [ "$mode" = A ] && [ "$k" != 1 ] && continue
                log="$WORK/$tag.$mode$k.ares.log"
                # B1 and B2; A and X run once and keep a bare name.  (Not a
                # `$([ … ] && echo)` substitution: under set -e its failing
                # status would end the script, silently, on every mode A run.)
                if [ "$mode" = B ]; then dst="$OUT/$tag.B$k.log"; else dst="$OUT/$tag.$mode.log"; fi
                if ! grep -q "^N64 webdoom boot" "$log"; then
                    echo "FAIL floor-n64: $tag.$mode$k: ares never booted the ROM, twice (see $log)"
                    xfail=$((xfail + 1)); continue
                fi
                # the WAD identity compiled into the ROM, before any hash
                if ! grep -q "registry name '$name'" "$log"; then
                    echo "FAIL floor-n64: $tag.$mode$k registered the wrong IWAD: $(grep -o "registry name '[^']*'" "$log" | head -1 || echo '<nothing>')"
                    xfail=$((xfail + 1)); continue
                fi
                info=$(grep -m1 "^N64_FLOOR_INFO name=$tag " "$log" || true)
                if [ -z "$info" ]; then
                    echo "FAIL floor-n64: $tag.$mode$k printed no N64_FLOOR_INFO (see $log)"; tail -3 "$log"
                    xfail=$((xfail + 1)); continue
                fi
                tics=$(sed -n 's/.* tics=\([0-9]*\) .*/\1/p' <<< "$info")
                gtics=$(sed -n 's/.* gametics=\([0-9]*\) .*/\1/p' <<< "$info")
                ovf=$(sed -n 's/.* overflow=\([0-9]*\) .*/\1/p' <<< "$info")
                if [ "$ovf" != 0 ] || [ "$tics" != "$gtics" ]; then
                    echo "FAIL floor-n64: $tag.$mode$k recorded $tics tics, overflowed $ovf, while the demo timed $gtics"
                    xfail=$((xfail + 1)); continue
                fi
                awk '/^N64_FLOOR_BEGIN /{f=1; next} /^N64_FLOOR_END /{f=0} f' "$log" > "$dst"
                if [ "$mode" != A ]; then
                    awk '/^N64_STAGES_BEGIN /{f=1} f; /^N64_STAGES_END /{f=0}' "$log" > "${dst%.log}.stages"
                    grep -h "^N64_FLOOR_INFO " "$log" > "${dst%.log}.info"
                fi
                if [ "$mode" = X ]; then
                    grep -h "^N64_XPROF_DETECT\|^N64_XPROF_CAL" "$log" > "$OUT/$tag.X.cal"
                    grep -h "^N64_COPY_BENCH" "$log" > "$OUT/$tag.X.copy" || true
                    awk '/^N64_XPROF_BEGIN /{f=1} f; /^N64_XPROF_END /{f=0}' "$log" > "$OUT/$tag.X.xprof"
                fi
            done
        done
    done
    [ "$xfail" = 0 ] || { echo "FAIL floor-n64: $xfail run(s) produced no usable log"; exit 1; }
fi

FILTERED=""
[ "${#DEMOS[@]}" -lt 13 ] && FILTERED=" (FILTERED to ${#DEMOS[@]} of 13 demos: $NAMES)"
GARGS=(--demos "$NAMES")
[ -n "$GOLDEN" ] && GARGS+=(--golden-dir "$GOLDEN")

if [ -n "$XPROF" ]; then
    # Profile runs are evidence, not a verdict: the calibration is checked and
    # the profile printed; floor-stats.mjs fails on a calibration that
    # disagrees with COUNT.
    exec node "$ROOT/tools/floor/floor-stats.mjs" --xprof "$OUT"
fi
if [ "$ONCE" = 1 ]; then
    echo "floor-n64: one timing run per demo, no gate$FILTERED"
    exec node "$ROOT/tools/floor/floor-stats.mjs" "$OUT"
fi
if [ "$CORRECTNESS" = 1 ]; then
    echo "floor-n64: grading ${#DEMOS[@]} mode A log(s) for correctness$FILTERED"
    exec node "$ROOT/tools/floor/floor-gate.mjs" --correctness "${GARGS[@]}" "$OUT"/*.A.log
fi
echo "floor-n64: grading A + B + B for ${#DEMOS[@]} demo(s)$FILTERED"
rc=0
node "$ROOT/tools/floor/floor-gate.mjs" "${GARGS[@]}" "$OUT"/*.A.log "$OUT"/*.B[12].log || rc=$?
node "$ROOT/tools/floor/floor-stats.mjs" "$OUT" || rc=1
exit "$rc"
