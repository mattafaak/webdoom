#!/usr/bin/env bash
# tools/cortexm/fast-check.sh — the floor gate on the port's faster code, and
# the proof that the gate would see it wrong.
#
# usage: bash tools/cortexm/fast-check.sh armv6m|armv8m
#
# 1. run-floor.sh <isa> --fast: the port's drawers (drawers_<isa>.S) and its
#    FixedDiv (cm_fixed.h over fixed_v6m.S or fixed_v8m.S), and on ARMv6-M its
#    FixedMul (cm_fixed.h).  It passes cm-fasttest (the port against the
#    engine, case by case, the counts printed) and then all 13 demos, every
#    tic's sim and render hash, and reports the worst graded tic as DEMAND.
# 2. Red-proofs, each a build with one deliberate defect, built and run side by
#    side (own build and out directories):
#      redcol   R_DrawColumn draws the column at x = 100 one row low
#      redspan  R_DrawSpan draws the span on row 100 one column right
#      redmul   FixedMul is off by one on 1 product in 4,096   (ARMv6-M)
#      reddiv   FixedDiv is off by one on 1 quotient in 256
#    Each must FAIL twice: cm-fasttest must name the input, and the floor gate
#    on doom-demo1 (run without cm-fasttest, --skip-fasttest) must name the
#    demo and the tic whose hash differs.  A red that passes either is a FAIL
#    of this leg.
# Prints one DEMAND line (the verdict of 1) and the red-proof tally; exits 0
# only if 1 passed and every red failed where it must.
# Copyright (C) 2026, GPL-2.0-or-later.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CM="$ROOT/tools/cortexm"
ISA="${1:-}"
case "$ISA" in
    armv6m) BOARD=mps2-an385; REDS="redcol redspan redmul reddiv" ;;
    armv8m) BOARD=mps2-an505; REDS="redcol redspan reddiv" ;;
    *) echo "FAIL fast-check: first argument must be armv6m or armv8m"; exit 2 ;;
esac
[ $# -eq 1 ] || { echo "FAIL fast-check: one argument, the ISA"; exit 2; }
LOGS="$CM/out/fast-check-$ISA"
rm -rf "$LOGS"
mkdir -p "$LOGS"

flag () {   # flag <red> -> its -D
    case "$1" in
        redcol) echo -DCM_REDPROOF_COLUMN ;;
        redspan) echo -DCM_REDPROOF_SPAN ;;
        redmul) echo -DCM_REDPROOF_FIXEDMUL ;;
        reddiv) echo -DCM_REDPROOF_FIXEDDIV ;;
    esac
}
want () {   # want <red> -> the floor gate's failure line, as a regex
    case "$1" in
        redcol|redspan) echo '^FAIL doom-demo1: render hash differs from the golden at tic [0-9]+ ' ;;
        redmul|reddiv) echo '^FAIL doom-demo1: (sim|render) hash differs from the golden at tic [0-9]+ ' ;;
    esac
}
uwant () {  # uwant <red> -> cm-fasttest's failure line, as a regex
    case "$1" in
        redcol) echo '^FAIL fasttest: R_DrawColumn case n=[0-9]+ x=100 ' ;;
        redspan) echo '^FAIL fasttest: R_DrawSpan case n=[0-9]+ y=100 ' ;;
        redmul) echo '^FAIL fasttest: FixedMul a=' ;;
        reddiv) echo '^FAIL fasttest: FixedDiv a=' ;;
    esac
}

# the reds build in the background while the real run goes
for r in $REDS; do
    bash "$CM/run-floor.sh" "$ISA" --fast --variant "$r" --cflags "$(flag "$r")" --skip-fasttest \
        --correctness --demos doom-demo1 --jobs 1 > "$LOGS/$r.log" 2>&1 &
    echo $! > "$LOGS/$r.pid"
done

rc=0
bash "$CM/run-floor.sh" "$ISA" --fast > "$LOGS/fast.log" 2>&1 || rc=$?
grep -E '^  (fasttest|selftest instrument)' "$LOGS/fast.log"
VERDICT="$(grep -E '^(DEMAND|FAIL|PREDICTED|PASS) floor' "$LOGS/fast.log" | tail -1 || true)"
if [ "$rc" -ne 0 ] || ! grep -qE '^DEMAND floor: .*correct: sim and render hashes match on all 13' <<< "$VERDICT"; then
    tail -25 "$LOGS/fast.log"
    for r in $REDS; do wait "$(cat "$LOGS/$r.pid")" 2>/dev/null; done
    echo "FAIL fast-check: the port's build did not pass the floor gate (run-floor exited $rc)"
    exit 1
fi
grep -E '^  worst graded tic' "$LOGS/fast.log"

caught=0
n=0
for r in $REDS; do
    n=$((n + 1))
    wait "$(cat "$LOGS/$r.pid")"
    rrc=$?
    line="$(grep -E "$(want "$r")" "$LOGS/$r.log" | head -1 || true)"
    B="$CM/build/$ISA-O1-fast-$r"
    urc=0
    timeout 1800 qemu-system-arm -M "$BOARD" -display none -monitor none -serial "file:$LOGS/$r.fasttest.uart" \
        -semihosting-config enable=on,target=native,arg=cm-fasttest,arg=1,arg=1 -kernel "$B/cm-fasttest.elf" || urc=$?
    uline="$(grep -aE "$(uwant "$r")" "$LOGS/$r.fasttest.uart" | head -1 || true)"
    if [ "$rrc" -ne 0 ] && [ -n "$line" ] && [ "$urc" -ne 0 ] && [ -n "$uline" ]; then
        caught=$((caught + 1))
        echo "  red-proof $r: floor gate rc=$rrc: ${line%% (*}; cm-fasttest rc=$urc: ${uline:0:110}"
    else
        echo "  red-proof $r NOT CAUGHT: floor gate rc=$rrc '${line}', cm-fasttest rc=$urc '${uline}'"
        tail -5 "$LOGS/$r.log"
    fi
done
if [ "$caught" -ne "$n" ]; then
    echo "FAIL fast-check: $caught of $n wrong ports were caught"
    exit 1
fi
echo "$VERDICT; $caught of $n wrong ports failed both cm-fasttest and the floor gate, each naming its input or its demo and tic"
exit 0
