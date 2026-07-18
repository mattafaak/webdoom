#!/usr/bin/env bash
# tools/freestanding/be-check.sh — build fs-doom-be then run the 13-demo
# golden suite under qemu-ppc-static and compare per-tic state hashes.
#
# Status as of task 13.3a WIP capture: BUILD OK, QEMU RUNS, hashes DIVERGE.
# This script is intentionally written to fail (non-zero exit) when hashes
# don't match — do not mask the exit.  See BE-NOTES.md for divergence table.
#
# Usage:
#   bash tools/freestanding/be-check.sh [wad_dir] [out_dir]
#   wad_dir  defaults to repo-root/wads/lib
#   out_dir  defaults to tools/freestanding/out-be
#
# Requirements:
#   zig >= 0.16       (cross compiler)
#   qemu-ppc-static   (or qemu-ppc; set QEMU_PPC env var to override)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WAD_DIR="${1:-$REPO_ROOT/wads/lib}"
OUT_DIR="${2:-$SCRIPT_DIR/out-be}"
GOLDEN_DIR="$REPO_ROOT/tools/golden"

mkdir -p "$OUT_DIR"

# ─── build ──────────────────────────────────────────────────────────────────
BE_BIN="$SCRIPT_DIR/fs-doom-be"
echo "be-check.sh: building $BE_BIN ..."
bash "$SCRIPT_DIR/be-build.sh" "$BE_BIN"

# ─── qemu runner ─────────────────────────────────────────────────────────────
QEMU="${QEMU_PPC:-}"
if [[ -z "$QEMU" ]]; then
    for candidate in qemu-ppc-static qemu-ppc; do
        if command -v "$candidate" >/dev/null 2>&1; then
            QEMU="$candidate"
            break
        fi
    done
fi
if [[ -z "$QEMU" ]]; then
    echo "be-check.sh: ERROR: qemu-ppc-static not found; set QEMU_PPC= to override"
    exit 1
fi
echo "be-check.sh: qemu=$QEMU"

# See run-check.sh for the doomu.wad / IdentifyVersion rationale.
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

ABS_WAD_DIR="$(cd "$WAD_DIR" && pwd)"
ABS_OUT_DIR="$(cd "$OUT_DIR" && pwd)"

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

    wad_dir="$TMPROOT/$out_prefix"
    mkdir -p "$wad_dir"
    ln -sf "$src_path" "$wad_dir/$present_as"
    wad_path="$wad_dir/$present_as"

    printf "running %-16s ... " "$out_prefix"
    ret=0
    "$QEMU" "$BE_BIN" "$wad_path" -timedemo "$demo" \
        -sim "$ABS_OUT_DIR/${out_prefix}.json" >/dev/null 2>&1 || ret=$?

    if [[ $ret -ne 0 ]]; then
        echo "FAIL (exit $ret)"
        FAILURES=$(( FAILURES + 1 ))
        continue
    fi

    golden="$GOLDEN_DIR/${out_prefix}.json"
    if [[ ! -f "$golden" ]]; then
        echo "NO GOLDEN ($golden)"
        FAILURES=$(( FAILURES + 1 ))
        continue
    fi

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
echo "PASS: all $PASSES BE demos bit-identical — big-endian port complete"
