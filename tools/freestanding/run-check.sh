#!/usr/bin/env bash
# tools/freestanding/run-check.sh — run fs-doom against all available IWADs.
# Mirrors native-sanitize/run-all.sh but uses the fs-doom interface:
#   ./fs-doom <wad_path> -timedemo <demo> -sim <out.json>
#
# Usage: bash run-check.sh <wad_dir> <out_dir>
set -euo pipefail

WAD_DIR="${1:-../../wads/lib}"
OUT_DIR="${2:-out}"

mkdir -p "$OUT_DIR"

FS_DOOM="$(cd "$(dirname "$0")" && pwd)/fs-doom"

DEMOS=(
    "doom.wad      demo1 doom-demo1"
    "doom.wad      demo2 doom-demo2"
    "doom.wad      demo3 doom-demo3"
    "doom.wad      demo4 doom-demo4"
    "doom2.wad     demo1 doom2-demo1"
    "doom2.wad     demo2 doom2-demo2"
    "doom2.wad     demo3 doom2-demo3"
    "tnt.wad       demo1 tnt-demo1"
    "tnt.wad       demo2 tnt-demo2"
    "tnt.wad       demo3 tnt-demo3"
    "plutonia.wad  demo1 plutonia-demo1"
    "plutonia.wad  demo2 plutonia-demo2"
    "plutonia.wad  demo3 plutonia-demo3"
)

ABS_WAD_DIR="$(cd "$WAD_DIR" && pwd)"
ABS_OUT_DIR="$(cd "$(dirname "$OUT_DIR")" && pwd)/$(basename "$OUT_DIR")"
FAILURES=0

for entry in "${DEMOS[@]}"; do
    read -r wad_file demo out_prefix <<< "$entry"
    wad_path="$ABS_WAD_DIR/$wad_file"

    if [[ ! -f "$wad_path" ]]; then
        echo "skip $out_prefix ($wad_path not found)"
        continue
    fi

    printf "running %s ... " "$out_prefix"
    ret=0
    output=$("$FS_DOOM" "$wad_path" -timedemo "$demo" \
        -sim "$ABS_OUT_DIR/${out_prefix}.json" \
        2>&1 >/dev/null) || ret=$?

    if [[ $ret -ne 0 ]]; then
        echo "FAIL (exit $ret)"
        echo "$output" | head -5
        FAILURES=$(( FAILURES + 1 ))
    else
        echo "$output" | grep "gametics" | tail -1 || echo "ok"
    fi
done

if [[ $FAILURES -ne 0 ]]; then
    echo "$FAILURES demo(s) FAILED"
    exit 1
fi
echo "all demos completed"
