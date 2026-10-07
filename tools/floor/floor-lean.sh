#!/usr/bin/env bash
# tools/floor/floor-lean.sh — the floor's full memory diet, built and checked.
#
# Every RAM lever together: vanilla's renderer limits, the lookup tables,
# texture tables and composites as const data (LEAN=1), the screens borrowed
# from the zone (LEAN_SCREENS, in LEAN), lumps read in place (ZERO_COPY=1) and
# the level read in place and narrowed (LEAN_LEVELS=1).  Each lever has its own
# leg; this one proves they hold together: all 13 demos correct through the
# floor gate at the recorded smallest zone, and not 4 KiB below it.
#
# Measured (tools/floor/zone-min.mjs, 4 KiB steps, audio on): 352 KiB passes,
# 348 fails.  The default build needs 1216.
#
# usage: bash tools/floor/floor-lean.sh [min_kb]
# Copyright (C) 2026, GPL-2.0-or-later.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIN_KB="${1:-352}"
FS="$ROOT/tools/freestanding"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
if ! make -C "$FS" -j8 LEAN=1 ZERO_COPY=1 LEAN_LEVELS=1 OBJDIR=obj-full OUT=fs-doom-full fs-doom-full > "$log" 2>&1; then
    tail -15 "$log"
    echo "FAIL floor-lean: the full-diet build failed"
    exit 1
fi
FS_DOOM="$FS/fs-doom-full" exec node "$ROOT/tools/floor/zone-min.mjs" --check "$MIN_KB"
