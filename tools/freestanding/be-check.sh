#!/usr/bin/env bash
# tools/freestanding/be-check.sh — build fs-doom-be then run the 13-demo
# golden suite under qemu-ppc-static and compare per-tic state hashes.
#
# Status: RESOLVED for the demo corpus.  BE-NOTES.md §RESOLUTION (2026-07-18)
# root-caused the PPC divergence to `char` signedness — PowerPC's ABI defaults
# char unsigned — and adding `-fsigned-char` gives 13/13 bit-identical.  The
# per-site audit (explicit `signed char` at each dependent use) is still future
# work, so -fsigned-char remains a port requirement rather than a fix.
#
# It still exits non-zero when hashes do not match; that is the point and the
# exit must not be masked.  What is no longer true is "permanently red".
#
# NOT in tools/gates-not-in-suite.json, and must not be re-added: the suite RUNS
# this file.  The `arm-cross` leg invokes arm-check.sh, whose last line is
# `exec bash "$SCRIPT_DIR/be-check.sh"`, and that leg is green at 13/13.  The
# registry carried it for years under the PPC invocation's caveat, describing
# the whole file as out-of-suite; gate-census's registeredButReachable check
# exists to catch exactly that and could not see the $SCRIPT_DIR reference.
#
# TARGET-GENERIC despite the name.  The script was written for the big-endian
# PPC rung (13.3a) and the "be-" prefix is historical; the target, the qemu
# binary, the output binary and the label are all env-overridable, and
# tools/freestanding/arm-check.sh drives it for 32-bit ARM:
#
#   BE_TARGET=arm-linux-musleabihf QEMU_BE=qemu-arm-static \
#   BE_BIN=.../fs-doom-arm CROSS_LABEL=ARM32 bash be-check.sh
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
CROSS_LABEL="${CROSS_LABEL:-BE}"

mkdir -p "$OUT_DIR"

# ─── build ──────────────────────────────────────────────────────────────────
BE_BIN="${BE_BIN:-$SCRIPT_DIR/fs-doom-be}"
echo "be-check.sh: building $BE_BIN ..."
bash "$SCRIPT_DIR/be-build.sh" "$BE_BIN"

# ─── qemu runner ─────────────────────────────────────────────────────────────
QEMU="${QEMU_BE:-${QEMU_PPC:-}}"
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
unpack = lambda t: [int(t[i:i+8], 16) for i in range(0, len(t), 8)] if isinstance(t, str) else t   # hex-string goldens (round 10)
fs = unpack(json.load(open(sys.argv[1]))["trace"])
gd = unpack(json.load(open(sys.argv[2]))["trace"])
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
# Every demo whose WAD is absent `skip`s WITHOUT touching FAILURES, so a
# WAD-less run used to print "PASS: all 0 BE demos bit-identical".  A run that
# compared nothing is not a pass.
EXPECTED_DEMOS=${#DEMOS[@]}
if [[ $PASSES -ne $EXPECTED_DEMOS ]]; then
    echo "FAIL: verified $PASSES of $EXPECTED_DEMOS demos ($CROSS_LABEL) — incomplete run,"
    echo "      WADs missing or demos skipped. A partial run is not a pass."
    exit 1
fi
echo "PASS: all $PASSES $CROSS_LABEL demos bit-identical vs the golden traces"
