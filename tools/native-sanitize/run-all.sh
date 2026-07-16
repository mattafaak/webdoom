#!/usr/bin/env bash
# native-sanitize/run-all.sh — run nat-doom once per IWAD demo.
# Each invocation is a fresh process so D_DoomMain global state is always clean.
# Each run gets its own temp WAD directory containing only the one IWAD it
# needs (via symlink), so IdentifyVersion() picks exactly that WAD.
# ASan errors abort the process; this script reports them and continues.
#
# Usage: bash run-all.sh <wad_dir> <out_dir> <sim|render|both>
set -euo pipefail

WAD_DIR="${1:-../../wads/lib}"
OUT_DIR="${2:-out}"
MODE="${3:-both}"

mkdir -p "$OUT_DIR"

# Resolve nat-doom to an absolute path (we cd to temp dirs mid-flight).
NAT_DOOM="$(cd "$(dirname "$0")" && pwd)/nat-doom"

# MATRIX: wad_file  demo  out_prefix
# wad_file is the actual filename in WAD_DIR.
# IdentifyVersion probes filenames in priority order; we isolate each run
# so only the target WAD is visible.
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

FAILURES=0
ABS_WAD_DIR="$(cd "$WAD_DIR" && pwd)"
ABS_OUT_DIR="$(cd "$(dirname "$OUT_DIR")" && pwd)/$(basename "$OUT_DIR")"

for entry in "${DEMOS[@]}"; do
    read -r wad_file demo out_prefix <<< "$entry"
    wad_path="$ABS_WAD_DIR/$wad_file"

    if [[ ! -f "$wad_path" ]]; then
        echo "skip $out_prefix ($wad_path not found)"
        continue
    fi

    # Create a temp dir containing only this WAD so IdentifyVersion finds
    # exactly this one and no other IWAD.
    TMPWAD="$(mktemp -d)"
    ln -s "$wad_path" "$TMPWAD/$wad_file"
    # doom.wad retail also ships as doomu.wad in the JS build; IdentifyVersion
    # checks doomu.wad before doom.wad, so provide both links.
    if [[ "$wad_file" == "doom.wad" ]]; then
        ln -s "$wad_path" "$TMPWAD/doomu.wad"
    fi

    ARGS=(
        -waddir "$TMPWAD"
        -timedemo "$demo"
    )

    case "$MODE" in
        sim)
            ARGS+=(-sim    "$ABS_OUT_DIR/${out_prefix}.json")
            ;;
        render)
            ARGS+=(-render "$ABS_OUT_DIR/${out_prefix}-render.json")
            ;;
        both)
            ARGS+=(-sim    "$ABS_OUT_DIR/${out_prefix}.json"
                   -render "$ABS_OUT_DIR/${out_prefix}-render.json")
            ;;
    esac

    printf "running %s ... " "$out_prefix"
    ret=0
    output=$(ASAN_OPTIONS=halt_on_error=1:print_stats=0 \
             UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
             "$NAT_DOOM" "${ARGS[@]}" 2>&1) || ret=$?

    rm -rf "$TMPWAD"

    if [[ $ret -ne 0 ]]; then
        echo "FAIL (exit $ret)"
        echo "$output" | grep -E "ERROR:|runtime error:|undefined behavior:|FAIL" | head -5
        FAILURES=$(( FAILURES + 1 ))
    else
        # Print the last stderr line (gametic count from nat-doom)
        echo "$output" | grep "gametics" | tail -1 || echo "ok"
    fi
done

if [[ $FAILURES -ne 0 ]]; then
    echo "$FAILURES demo(s) FAILED (ASan/UBSan abort or write error)"
    exit 1
fi
echo "all demos passed ASan/UBSan run"
