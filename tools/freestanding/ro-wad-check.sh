#!/usr/bin/env bash
# tools/freestanding/ro-wad-check.sh — read-only-WAD proof (XIP feasibility).
#
# Runs all 13 demos under WD_RO_WAD=1: the WAD blob is mmap'd then
# mprotect(PROT_READ)'d before D_DoomMain.  Any engine write into the blob
# triggers SIGSEGV → handler prints "WAD-BLOB WRITE" + faulting address → exit 2.
#
# 13/13 pass bit-identical → WAD blob is read-only over the full corpus
#      → XIP-viable (engine never writes the blob).
#
# --zero-copy checks fs-doom-zc, the build that reads lumps in place
# (WEB_LUMPS_IN_PLACE, engine/core/w_wad.h): there, a write into any lump the
# engine was handed would be a write into the blob, so the same 13 demos prove
# the engine writes no lump at all.
#
# Before the demos, a probe (WD_LUMP_WRITE_PROBE=1, i_main.c) writes one byte
# back into the PLAYPAL lump W_CacheLumpName returned.  It is the leg's
# red-proof, every run, both ways: with --zero-copy the lump must lie inside
# the blob and the write must fault there (so the build really reads in place
# and a write into a lump is caught); without, the lump is a zone copy and the
# write must land in it without a fault.
#
# A failure prints the faulting address; use addr2line on the binary to name
# the writer:
#   addr2line -e tools/freestanding/fs-doom[-zc] <faulting-address>
#
# Usage: bash ro-wad-check.sh [--zero-copy] [wad_dir] [out_dir]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZC=0
if [[ "${1:-}" == "--zero-copy" ]]; then
    ZC=1
    shift
    export FS_DOOM="${FS_DOOM:-$SCRIPT_DIR/fs-doom-zc}"
fi
BIN="${FS_DOOM:-$SCRIPT_DIR/fs-doom}"
WAD_DIR="${1:-$SCRIPT_DIR/../../wads/lib}"

echo "=== WD_RO_WAD=1: WAD blob read-only proof ($(basename "$BIN")) ==="
echo "WAD blob is mprotect(PROT_READ)'d; any write → SIGSEGV → FAIL with address"
echo ""

[[ -x "$BIN" ]] || { echo "FAIL: $BIN not built (make -C tools/freestanding)"; exit 1; }
[[ -f "$WAD_DIR/doom.wad" ]] || { echo "FAIL: $WAD_DIR/doom.wad absent: the probe cannot run"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ln -s "$(cd "$WAD_DIR" && pwd)/doom.wad" "$TMP/doomu.wad"
rc=0
WD_RO_WAD=1 WD_LUMP_WRITE_PROBE=1 "$BIN" "$TMP/doomu.wad" -timedemo demo1 \
    > /dev/null 2> "$TMP/probe.err" || rc=$?
where="$(grep -o 'PLAYPAL at [^,]*, [a-z]* the WAD blob' "$TMP/probe.err" || true)"
if [[ "$ZC" == 1 ]]; then
    if [[ "$rc" -ne 2 ]] || ! grep -q 'inside the WAD blob' "$TMP/probe.err" ||
       ! grep -q 'write into PROT_READ WAD blob' "$TMP/probe.err"; then
        tail -3 "$TMP/probe.err"
        echo "FAIL: probe exited $rc: a write into a lump read in place was not caught inside the blob (${where:-no probe line})"
        exit 1
    fi
    echo "probe: $where; the write faulted there (exit 2) — lumps are read in place and a write into one is caught"
    export RO_WAD_NOTE="; a write into an in-place lump faults"
else
    if [[ "$rc" -ne 3 ]] || ! grep -q 'outside the WAD blob' "$TMP/probe.err"; then
        tail -3 "$TMP/probe.err"
        echo "FAIL: probe exited $rc: this build was expected to hand out a zone copy of PLAYPAL (${where:-no probe line})"
        exit 1
    fi
    echo "probe: $where; the write landed in the zone copy (exit 3) — this build copies lumps"
fi
echo ""

export WD_RO_WAD=1
exec bash "$SCRIPT_DIR/run-check.sh" "$@"
