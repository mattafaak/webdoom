#!/usr/bin/env bash
# tools/cortexm/run-floor.sh — the floor gate on a Cortex-M build under qemu.
#
# usage: bash tools/cortexm/run-floor.sh armv6m|armv8m [--opt -O1|-O2]
#            [--count] [--out DIR] [--jobs N]
#            [--golden-dir DIR]              grade against other goldens
#            [--cflags "..." --variant NAME] an extra-flags build, in its own
#                                            build dir (red-proofs)
#
#   armv6m  -mcpu=cortex-m0plus code on mps2-an385 (exact M0+ instruction
#           counts; unaligned accesses trap as on an M0+)
#   armv8m  -mcpu=cortex-m33 code on mps2-an505
#
# 1. builds (tools/cortexm/Makefile);
# 2. proves the instrument and the traps on the board (selftest.c), every run:
#    instrument  1e6 and 2e6 known instructions read back within one step;
#    wrongloop   the same check fed a 1,499,999-instruction loop must FAIL;
#    unaligned   armv6m must fault UNALIGNED, armv8m must not;
#    window      a load from the WAD window must BusFault at that address;
#    stack       the painted-stack peak reads known frames to within 256 B;
#    semihost    a SYS_SEEK+SYS_READ costs the guest the same for 1 B and
#                64 KiB (the WAD's bytes cost no guest instructions);
#    memcpy      newlib memcpy's instructions per byte (the price of M bytes);
# 3. runs all 13 demos, a correctness run (mode A: every tic's sim and render
#    hash) and a timing run (mode B: instructions per tic), one qemu per run,
#    with -icount shift=0;
# 4. checks the floor hooks fired (a load tic in every demo, WAD bytes copied);
# 5. grades the logs with tools/floor/floor-gate.mjs: DEMAND, with the
#    correctness verdict on all 13 demos, or FAIL.
#
# --count builds with every libgcc helper wrapped by a counter and runs mode B
# only: its tics are slower by the wrappers, so its logs are for helper counts
# (the stats files), never graded as timing.  It needs the measured build's run
# first, and FAILs unless every engine object has the measured build's machine
# code and every demo ends in the measured mode-A run's state.
# Copyright (C) 2026, GPL-2.0-or-later.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CM="$ROOT/tools/cortexm"
ISA="${1:-}"
shift || true
OPT=-O1
COUNT=0
OUT=""
JOBS="$(nproc)"
GOLDEN=()
XCFLAGS=""
VARIANT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --opt) OPT="$2"; shift 2 ;;
        --count) COUNT=1; shift ;;
        --out) OUT="$2"; shift 2 ;;
        --jobs) JOBS="$2"; shift 2 ;;
        --golden-dir) GOLDEN=(--golden-dir "$2"); shift 2 ;;
        --cflags) XCFLAGS="$2"; shift 2 ;;
        --variant) VARIANT="$2"; shift 2 ;;
        *) echo "FAIL run-floor: unknown argument '$1'"; exit 2 ;;
    esac
done
case "$ISA" in
    armv6m) BOARD=mps2-an385; TARGET=armv6m-qemu ;;
    armv8m) BOARD=mps2-an505; TARGET=armv8m-qemu ;;
    *) echo "FAIL run-floor: first argument must be armv6m or armv8m"; exit 2 ;;
esac
# a gate that ran nothing must not exit 0: missing tools are a FAIL here, and
# the suite's qemucm need tag reports them as a SKIP before calling this
for need in qemu-system-arm arm-none-eabi-gcc node; do
    command -v "$need" >/dev/null 2>&1 || { echo "FAIL run-floor: $need not found — built and verified nothing"; exit 1; }
done

SUF=""
[ "$COUNT" = 1 ] && SUF=-count
if [ -n "$XCFLAGS" ]; then
    [ -n "$VARIANT" ] || { echo "FAIL run-floor: --cflags needs --variant NAME (its own build dir)"; exit 2; }
fi
[ -n "$VARIANT" ] && SUF="$SUF-$VARIANT"
B="$CM/build/$ISA$OPT$SUF"
OUT="${OUT:-$CM/out/$ISA$OPT$SUF}"
WADS="$ROOT/wads/lib"

echo "run-floor: building $ISA $OPT${SUF:+ ($SUF)}"
BLOG="$B.log"
mkdir -p "$CM/build"
make -s -C "$CM" ISA="$ISA" OPT="$OPT" COUNT="$COUNT" B="$B" EXTRA_CFLAGS="$XCFLAGS" > "$BLOG" 2>&1 ||
    { tail -20 "$BLOG"; echo "FAIL run-floor: build failed"; exit 1; }
grep -E '^(built|armv)' "$BLOG" || true
ELF="$B/cm-doom.elf"
[ -f "$ELF" ] || { echo "FAIL run-floor: $ELF not built"; exit 1; }

GITSHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ -n "$(git -C "$ROOT" status --porcelain -- engine tools/freestanding tools/floor tools/cortexm 2>/dev/null)" ] && GITSHA="$GITSHA+dirty"
BUILD="$GITSHA$OPT$SUF"

rm -rf "$OUT"
mkdir -p "$OUT"

# qemu's -semihosting-config splits on commas: a path with one cannot pass
for p in "$OUT" "$WADS"; do
    case "$p" in *,*|*\ *) echo "FAIL run-floor: '$p' contains a comma or space"; exit 1 ;; esac
done

qemu () {   # qemu <elf> <uartfile> <semihosting args...>
    local elf="$1" uart="$2"; shift 2
    local a="enable=on,target=native" x
    for x in "$@"; do a="$a,arg=$x"; done
    timeout 1800 qemu-system-arm -M "$BOARD" -icount shift=0 -display none -monitor none \
        -serial "file:$uart" -semihosting-config "$a" -kernel "$elf"
}

# ── 2. the instrument and the traps ─────────────────────────────────────────
st () {   # st <mode> <expected rc> <pattern the UART must show> [arg]
    local mode="$1" want="$2" pat="$3" rc=0
    qemu "$B/cm-selftest.elf" "$OUT/selftest-$mode.uart" cm-selftest "$mode" ${4:+"$4"} || rc=$?
    local line; line="$(grep -E 'PASS|FAIL|FAULT|UNALIGNED' "$OUT/selftest-$mode.uart" | tail -1 || true)"
    if [ "$rc" -ne "$want" ] || ! grep -qE "$pat" <<< "$line"; then
        echo "FAIL run-floor: selftest $mode exited $rc (want $want): $line"
        exit 1
    fi
    echo "  selftest $mode: rc=$rc as required: $line"
}
# selftest.c grades "within one timer step" itself; the phase of the timer
# against the loop moves with the code around it (-O2 reads 1,000,050)
st instrument 0 '^PASS instrument: loop_1m=(999|1000)[0-9]{3} loop_2m=(1999|2000)[0-9]{3} '
st wrongloop 1 '^FAIL instrument: loop_1m=1(499|500)[0-9]{3} '
if [ "$ISA" = armv6m ]; then
    st unaligned 3 '^FAULT UsageFault .*cause=UNALIGNED,'
else
    st unaligned 0 '^UNALIGNED read completed, no fault'
fi
st window 3 '^FAULT BusFault .*addr=0x60001234 '
st stack 0 '^PASS stack: '
st semihost 0 '^PASS semihost: ' "$WADS/doom.wad"
st memcpy 0 '^PASS memcpy: '

# ── 3. the demos ─────────────────────────────────────────────────────────────
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
MODES="A B"
[ "$COUNT" = 1 ] && MODES="B"

run_demo () {   # run_demo <wad> <present-as> <demo> <name> <mode>
    local wad="$1" as="$2" demo="$3" name="$4" mode="$5" rc=0
    qemu "$ELF" "$OUT/$name.$mode.uart" cm-doom -wad "$WADS/$wad" -as "$as" -timedemo "$demo" \
        -floor "$OUT/$name.$mode.log" -mode "$mode" -name "$name" -build "$BUILD" \
        -stats "$OUT/$name.$mode.stats" || rc=$?
    echo "$rc" > "$OUT/$name.$mode.rc"
}

t0=$(date +%s)
runs=0
for entry in "${DEMOS[@]}"; do
    read -r wad as demo name <<< "$entry"
    [ -f "$WADS/$wad" ] || { echo "FAIL run-floor: $WADS/$wad absent (tools/fetch-wads.sh)"; exit 1; }
    for mode in $MODES; do
        while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 0.2; done
        run_demo "$wad" "$as" "$demo" "$name" "$mode" &
        runs=$((runs + 1))
    done
done
wait
bad=0
for f in "$OUT"/*.rc; do
    if [ "$(cat "$f")" != 0 ]; then
        bad=$((bad + 1))
        u="${f%.rc}.uart"
        echo "  $(basename "${f%.rc}") exited $(cat "$f"): $(grep -aE 'FAULT|FAIL|I_Error|KILLED' "$u" | tail -1)"
    fi
done
nrc=$(ls "$OUT"/*.rc | wc -l)
[ "$nrc" -eq "$runs" ] || { echo "FAIL run-floor: $nrc of $runs runs reported an exit code"; exit 1; }
[ "$bad" -eq 0 ] || { echo "FAIL run-floor: $bad of $runs qemu runs exited non-zero (see $OUT/*.uart)"; exit 1; }
echo "run-floor: $runs runs of $TARGET ($BUILD) on $BOARD in $(( $(date +%s) - t0 )) s"

# ── 4. the floor hooks fired ────────────────────────────────────────────────
node -e '
const fs = require("fs"), dir = process.argv[1];
const logs = fs.readdirSync(dir).filter(f => f.endsWith(".log") && /\.[AB]\.log$/.test(f));
const noLoad = logs.filter(f => !/^T \d+ \d+ \d+ \S*L/m.test(fs.readFileSync(dir + "/" + f, "utf8")));
const anyMiss = logs.some(f => /^T .* (\S*,)?M:\d+/m.test(fs.readFileSync(dir + "/" + f, "utf8")));
if (noLoad.length) { console.log(`FAIL run-floor: ${noLoad.length} of ${logs.length} logs have no load tic: the --wrap hooks did not fire (${noLoad[0]})`); process.exit(1); }
if (!anyMiss) { console.log("FAIL run-floor: no tic copied a byte out of the WAD: the memcpy hook did not fire"); process.exit(1); }
' "$OUT"

# the peak stack, over every run (crt0.S paints the region at reset)
awk '/^STACK/ { split($2,a,"="); split($3,b,"="); f=FILENAME; sub(/.*\//,"",f);
       if (a[2] > mi) { mi = a[2]; fi = f } if (b[2] > md) { md = b[2]; fd = f } }
     END { printf "  peak stack: init %d B (%s), demo loop %d B (%s)\n", mi, fi, md, fd }' "$OUT"/*.stats

if [ "$COUNT" = 1 ]; then
    # A counting run is never graded as timing.  Its helper counts describe
    # the measured build only if it IS that build with counters around the
    # helpers: the same engine machine code, the same run to the same end.
    MB="$CM/build/$ISA$OPT"
    MO="$CM/out/$ISA$OPT"
    [ -n "$VARIANT" ] && { MB="$MB-$VARIANT"; MO="$MO-$VARIANT"; }
    [ -d "$MB" ] && [ -d "$MO" ] || { echo "FAIL run-floor: --count needs the measured build's run first ($MO)"; exit 1; }
    differ=0; nobj=0
    for o in "$MB"/core/*.o "$MB"/fs/*.o "$MB"/floor/*.o; do
        c="$B/${o#"$MB"/}"
        nobj=$((nobj + 1))
        cmp -s <(arm-none-eabi-objdump -d --no-show-raw-insn "$o" | tail -n +3) \
               <(arm-none-eabi-objdump -d --no-show-raw-insn "$c" | tail -n +3) || { differ=$((differ + 1)); echo "  code differs: ${o#"$MB"/}"; }
    done
    [ "$nobj" -gt 0 ] && [ "$differ" -eq 0 ] || { echo "FAIL run-floor: $differ of $nobj engine objects differ from the measured build's code"; exit 1; }
    same=0
    for entry in "${DEMOS[@]}"; do
        read -r _ _ _ name <<< "$entry"
        a="$(grep '^END' "$MO/$name.A.log" 2>/dev/null || true)"
        b="$(grep '^END' "$OUT/$name.B.log")"
        if [ -n "$a" ] && [ "$a" = "$b" ]; then same=$((same + 1)); else echo "  $name: counting run ended '$b', measured mode A '$a'"; fi
    done
    [ "$same" -eq "${#DEMOS[@]}" ] || { echo "FAIL run-floor: $same of ${#DEMOS[@]} counting runs end in the measured run's state"; exit 1; }
    echo "PASS run-floor: helper-counting build of $TARGET: $nobj of $nobj engine objects are the measured build's code, $same of ${#DEMOS[@]} demos end in its mode-A state (stats in $OUT/*.B.stats; not graded as timing)"
    exit 0
fi
# ── 5. the verdict ───────────────────────────────────────────────────────────
exec node "$ROOT/tools/floor/floor-gate.mjs" "${GOLDEN[@]}" "$OUT"/*.log
