#!/usr/bin/env bash
# tools/freestanding/be-check.sh — build fs-doom-be then run the 13-demo
# golden suite under qemu-ppc-static and compare per-tic state hashes.
#
# PowerPC's ABI makes `char` unsigned, and the core depends on it being signed
# in places, so the build passes -fsigned-char: with it the corpus is 13/13
# bit-identical.  An audit of each dependent use is still undone, so the flag is
# a port requirement rather than a fix.
#
# The `be-cross` leg runs this in its PPC default; `arm-cross` runs it through
# arm-check.sh with the target overridden to 32-bit ARM.
#
# TARGET-GENERIC despite the name.  The script was written for the big-endian
# PPC rung and the "be-" prefix is historical; the target, the qemu
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
# CROSS_GOLDEN_DIR grades against other goldens (red-proofs); default the real ones
GOLDEN_DIR="${CROSS_GOLDEN_DIR:-$REPO_ROOT/tools/golden}"
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
    # audio off for the sim goldens: under qemu the music synth costs ~9x the
    # game (doom-demo4: 0.6 s without, 5.2 s with), and the audio is checked
    # once, below, against the x86 reference
    WD_AUDIO=0 "$QEMU" "$BE_BIN" "$wad_path" -timedemo "$demo" \
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
unpack = lambda t: [int(t[i:i+8], 16) for i in range(0, len(t), 8)] if isinstance(t, str) else t   # hex-string goldens
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
# The audio, on this target: one demo with music and sound effects, whose
# AUDIO line (tools/freestanding/fs_audio.c) must be the x86 reference's to the
# hash -- the synth's samples (synthhash) and the mixer's (mixhash).  On the
# big-endian target this is the check that GENMIDI is read right (fs_mus.c).
AUDIO_DEMO=doom-demo4
AUDIO_REF="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' \
             "$SCRIPT_DIR/../floor/audio-ref.json" "$AUDIO_DEMO")"
wad_dir="$TMPROOT/$AUDIO_DEMO-audio"
mkdir -p "$wad_dir"
ln -sf "$ABS_WAD_DIR/doom.wad" "$wad_dir/doomu.wad"
printf "running %-16s ... " "$AUDIO_DEMO+audio"
ret=0
WD_FLOOR_NAME="$AUDIO_DEMO" "$QEMU" "$BE_BIN" "$wad_dir/doomu.wad" -timedemo demo4 \
    -floor "$ABS_OUT_DIR/$AUDIO_DEMO.audio.log" >/dev/null 2>&1 || ret=$?
AUDIO_GOT="$(sed -n 's/^AUDIO //p' "$ABS_OUT_DIR/$AUDIO_DEMO.audio.log" 2>/dev/null || true)"
if [[ $ret -ne 0 || "$AUDIO_GOT" != "$AUDIO_REF" ]]; then
    echo "FAIL (exit $ret)"
    echo "  got:       ${AUDIO_GOT:-(no AUDIO line)}"
    echo "  reference: $AUDIO_REF (tools/floor/audio-ref.json)"
    echo "FAIL: $CROSS_LABEL audio differs from the x86 reference ($PASSES of $EXPECTED_DEMOS sim demos matched)"
    exit 1
fi
echo "OK AUDIO == x86 reference"
echo "PASS: all $PASSES $CROSS_LABEL demos bit-identical vs the golden traces; $AUDIO_DEMO's audio == the x86 reference (synthhash, mixhash)"
