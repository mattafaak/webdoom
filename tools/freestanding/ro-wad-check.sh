#!/usr/bin/env bash
# tools/freestanding/ro-wad-check.sh — 13.2c read-only-WAD proof (XIP feasibility).
#
# Runs all 13 demos under WD_RO_WAD=1: the WAD blob is mmap'd then
# mprotect(PROT_READ)'d before D_DoomMain.  Any engine write into the blob
# triggers SIGSEGV → handler prints "WAD-BLOB WRITE" + faulting address → exit 2.
#
# DoD: 13/13 pass bit-identical → WAD blob is read-only over the full corpus
#      → XIP-viable (engine never writes the blob).
#
# A failure prints the faulting address; use addr2line on fs-doom to name the
# writer:
#   addr2line -e tools/freestanding/fs-doom <faulting-address>
#
# Usage: bash ro-wad-check.sh [wad_dir] [out_dir]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== WD_RO_WAD=1: WAD blob read-only proof (13.2c) ==="
echo "WAD blob is mprotect(PROT_READ)'d; any write → SIGSEGV → FAIL with address"
echo ""

export WD_RO_WAD=1
exec bash "$SCRIPT_DIR/run-check.sh" "$@"
