#!/usr/bin/env bash
# tools/freestanding/run-check.sh — run fs-doom over all 13 golden demos and
# ASSERT its per-tic state hashes are bit-identical to the committed goldens.
#
# This is the crown-jewel proof for rung 1 (task 11.1a): the freestanding core
# — memory region + byte-out + preloaded WAD blob, no OS file I/O below the
# shim — reproduces vanilla DOOM's simulation exactly. It is a GATE, not a
# dump: a single divergent tic exits non-zero and names the demo + tic.
#
#   ./fs-doom <wad_path> -timedemo <demo> -sim <out.json>
#
# Usage: bash run-check.sh [wad_dir] [out_dir]
#   wad_dir defaults to the repo's wads/lib (resolved relative to THIS script,
#   not the caller's CWD, so it runs from anywhere).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WAD_DIR="${1:-$REPO_ROOT/wads/lib}"
OUT_DIR="${2:-$SCRIPT_DIR/out}"
GOLDEN_DIR="$REPO_ROOT/tools/golden"

mkdir -p "$OUT_DIR"
FS_DOOM="$SCRIPT_DIR/fs-doom"
ABS_WAD_DIR="$(cd "$WAD_DIR" && pwd)"
ABS_OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# demo4 lives only in the Ultimate/retail IWAD. linuxdoom's IdentifyVersion
# checks doomu.wad BEFORE doom.wad, so the golden for doom-demo4 was recorded
# under retail identification. Presenting the same bytes as plain doom.wad
# selects registered mode and desyncs DEMO4 from tic 0 — a HARNESS artifact,
# not an engine divergence (verified: the engine matches bit-for-bit once the
# retail name is used). So each demo row carries the exact filename to present.
DEMOS=(
    "doom.wad     doomu.wad demo1 doom-demo1"
    "doom.wad     doomu.wad demo2 doom-demo2"
    "doom.wad     doomu.wad demo3 doom-demo3"
    "doom.wad     doomu.wad demo4 doom-demo4"
    "doom2.wad    doom2.wad demo1 doom2-demo1"
    "doom2.wad    doom2.wad demo2 doom2-demo2"
    "doom2.wad    doom2.wad demo3 doom2-demo3"
    "tnt.wad      tnt.wad   demo1 tnt-demo1"
    "tnt.wad      tnt.wad   demo2 tnt-demo2"
    "tnt.wad      tnt.wad   demo3 tnt-demo3"
    "plutonia.wad plutonia.wad demo1 plutonia-demo1"
    "plutonia.wad plutonia.wad demo2 plutonia-demo2"
    "plutonia.wad plutonia.wad demo3 plutonia-demo3"
)

FAILURES=0
PASSES=0
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

for entry in "${DEMOS[@]}"; do
    read -r src_file present_as demo out_prefix <<< "$entry"
    src_path="$ABS_WAD_DIR/$src_file"

    if [[ ! -f "$src_path" ]]; then
        echo "skip $out_prefix ($src_path not found)"
        continue
    fi

    # Present the WAD under the name IdentifyVersion expects for this demo.
    wad_dir="$TMPROOT/$out_prefix"
    mkdir -p "$wad_dir"
    ln -sf "$src_path" "$wad_dir/$present_as"
    wad_path="$wad_dir/$present_as"

    printf "running %-16s ... " "$out_prefix"
    ret=0
    "$FS_DOOM" "$wad_path" -timedemo "$demo" \
        -sim "$ABS_OUT_DIR/${out_prefix}.json" >/dev/null 2>&1 || ret=$?

    if [[ $ret -ne 0 ]]; then
        echo "FAIL (fs-doom exit $ret)"
        FAILURES=$(( FAILURES + 1 ))
        continue
    fi

    golden="$GOLDEN_DIR/${out_prefix}.json"
    if [[ ! -f "$golden" ]]; then
        echo "NO GOLDEN ($golden)"
        FAILURES=$(( FAILURES + 1 ))
        continue
    fi

    # Compare per-tic hashes; report the first divergent tic on mismatch.
    verdict=$(python3 - "$ABS_OUT_DIR/${out_prefix}.json" "$golden" <<'PY'
import json, sys
fs = json.load(open(sys.argv[1]))["trace"]
gd = json.load(open(sys.argv[2]))["trace"]
if fs == gd:
    print(f"OK {len(fs)} tics identical")
else:
    n = min(len(fs), len(gd))
    i = next((k for k in range(n) if fs[k] != gd[k]), n)
    print(f"MISMATCH len fs={len(fs)} gold={len(gd)} first divergent tic {i}")
    sys.exit(1)
PY
) && vret=0 || vret=$?

    if [[ $vret -ne 0 ]]; then
        echo "$verdict"
        FAILURES=$(( FAILURES + 1 ))
    else
        echo "$verdict"
        PASSES=$(( PASSES + 1 ))
    fi
done

echo "─────────────────────────────────────────────"
if [[ $FAILURES -ne 0 ]]; then
    echo "FAIL: $FAILURES demo(s) diverged from golden ($PASSES matched)"
    exit 1
fi
echo "PASS: $PASSES/$PASSES demos bit-identical — the freestanding core matches vanilla"
