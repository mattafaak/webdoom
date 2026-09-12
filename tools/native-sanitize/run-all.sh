#!/usr/bin/env bash
# native-sanitize/run-all.sh — run nat-doom once per IWAD demo.
# Each invocation is a fresh process so D_DoomMain global state is always clean.
# Each run gets its own temp WAD directory containing only the one IWAD it
# needs (via symlink), so IdentifyVersion() picks exactly that WAD.
# ASan errors abort the process; this script reports them and continues.
#
# Usage: bash run-all.sh <wad_dir> <out_dir> <sim|render|both>
set -euo pipefail

# Defaults resolve against THIS SCRIPT, not the caller's cwd.  They were
# `../../wads/lib` and `out`, which are only correct when invoked from
# tools/native-sanitize/ -- so the bare `bash tools/native-sanitize/run-all.sh`
# that README implies died on `cd: ../../wads/lib: No such file or directory`.
# The suite passes both paths explicitly and never saw it.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WAD_DIR="${1:-$SCRIPT_DIR/../../wads/lib}"
OUT_DIR="${2:-$SCRIPT_DIR/out}"
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
PASSES=0
SKIPS=0
SKIPPED_WADS=""
# The matrix declares the whole corpus.  The verdict below used to be the bare
# string "all demos passed ASan/UBSan run", printed with no count, from a loop
# whose missing-WAD branch `continue`d without incrementing anything.  With no
# WADs present all 13 iterations skipped and it announced that all demos passed,
# exit 0, having run none of them.  README advertises this tool by name.
EXPECTED=${#DEMOS[@]}
ABS_WAD_DIR="$(cd "$WAD_DIR" && pwd)"
ABS_OUT_DIR="$(cd "$(dirname "$OUT_DIR")" && pwd)/$(basename "$OUT_DIR")"

for entry in "${DEMOS[@]}"; do
    read -r wad_file demo out_prefix <<< "$entry"
    wad_path="$ABS_WAD_DIR/$wad_file"

    if [[ ! -f "$wad_path" ]]; then
        echo "skip $out_prefix ($wad_path not found)"
        SKIPS=$(( SKIPS + 1 ))
        case "$SKIPPED_WADS" in *"$wad_file"*) ;; *) SKIPPED_WADS="$SKIPPED_WADS $wad_file" ;; esac
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
        PASSES=$(( PASSES + 1 ))
        # Print the last stderr line (gametic count from nat-doom).
        #
        # This used to end `|| echo "ok"`, so a run that produced NO gametics
        # line printed the literal word "ok" in place of the number -- a guess
        # standing where an observation belongs, and under `set -euo pipefail`
        # the only thing keeping the script alive on that path.  Say what
        # actually happened instead.
        if ! echo "$output" | grep "gametics" | tail -1; then
            echo "  (completed, but printed no gametics line — nothing to report about tic count)"
        fi
    fi
done

if [[ $FAILURES -ne 0 ]]; then
    echo "FAIL: $FAILURES of $EXPECTED demo(s) FAILED (ASan/UBSan abort or write error)"
    exit 1
fi
if [[ $PASSES -ne $EXPECTED ]]; then
    echo "INCOMPLETE: $PASSES/$EXPECTED demos ran under ASan/UBSan, $SKIPS skipped —" \
         "this run is not evidence about the other $(( EXPECTED - PASSES ))"
    echo "  missing WADs:${SKIPPED_WADS:- (none — the matrix and the loop disagree)}"
    echo "  run tools/fetch-wads.sh"
    exit 2
fi
echo "PASS: all $PASSES/$EXPECTED demos passed ASan/UBSan run"
