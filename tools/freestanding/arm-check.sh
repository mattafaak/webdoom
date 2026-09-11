#!/usr/bin/env bash
# tools/freestanding/arm-check.sh — the ARM correctness leg, on alder.
#
# WHY THIS EXISTS
# ---------------
# spec.md's reference fleet lists pi5 (Cortex-A76) as "ARM reference".  What pi5
# actually ran was `node tools/bench.mjs` against the WASM build — a pure
# PERFORMANCE sample.  wasm is architecture-independent by construction, so the
# ARM row never tested ARM code generation, the ARM ABI, or ARM alignment at
# all.  And pi5 has been down since before 2026-09-11, which left the four-host
# perf gate unrunnable as written (finding F4).
#
# Timings cannot be migrated to alder: emulated cycles are not hardware cycles,
# and a number produced that way would be fiction.  CORRECTNESS can, and it is
# the half that was missing.  This builds the freestanding core for 32-bit ARM
# with zig's bundled musl and replays all 13 golden demos under
# qemu-arm-static, asserting per-tic state hashes are bit-identical.
#
# So the ARM row now asserts something stronger than it used to, on a host that
# is actually up.  What it no longer asserts — ARM wall-clock performance — is
# recorded as such in spec.md rather than quietly dropped.
#
# Requirements: zig >= 0.16 (bundled musl cross-compiler), qemu-arm-static.
# Both are SKIPped loudly by the suite when absent.
#
# usage: bash tools/freestanding/arm-check.sh [wad_dir] [out_dir]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Exit NON-ZERO on a missing prerequisite: this is a gate, and a gate that
# exits 0 having built and run nothing is the vacuous-pass shape.  The suite
# decides whether to run it at all, via the zig/qemuarm need tags, and reports
# the skip with its reason in the summary table.
for need in zig qemu-arm-static; do
    command -v "$need" >/dev/null 2>&1 || {
        echo "FAIL arm-check: $need not found — built and verified nothing"
        exit 1
    }
done

BE_TARGET="${ARM_TARGET:-arm-linux-musleabihf}" \
BE_BIN="${ARM_BIN:-$SCRIPT_DIR/fs-doom-arm}" \
QEMU_BE="${QEMU_ARM:-qemu-arm-static}" \
CROSS_LABEL="ARM32" \
    exec bash "$SCRIPT_DIR/be-check.sh" "$@"
