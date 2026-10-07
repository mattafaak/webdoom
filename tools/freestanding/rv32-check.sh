#!/usr/bin/env bash
# tools/freestanding/rv32-check.sh — the RISC-V (RV32) correctness leg.
#
# The freestanding core cross-built with zig's bundled musl and replayed under
# qemu-riscv32-static, all 13 golden demos, per-tic sim hashes bit-identical.
# be-check.sh does the work (arm-check.sh's pattern); this runs it twice:
#
#   RV32IMAC  -mcpu=generic_rv32+m+a+c, soft-float ABI: no FPU, the ISA of
#             the RISC-V cores on the floor's candidate boards (RP2350's
#             Hazard3 is RV32IMAC plus bit-manipulation extensions).  The
#             core's libm calls at init (tables.c's sin/tan/atan) then run in
#             software, which a hard-float build would never test.
#   RV32GC    zig's riscv32-linux-musl default (rv32imafdc, double-float ABI).
#
# RISC-V makes `char` unsigned, so be-build.sh's -fsigned-char matters here as
# on ARM and PowerPC.  Correctness only: emulated instructions are not time.
#
# usage: bash tools/freestanding/rv32-check.sh [wad_dir]
# Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# a gate that built and ran nothing must not exit 0
for need in zig qemu-riscv32-static; do
    command -v "$need" >/dev/null 2>&1 || {
        echo "FAIL rv32-check: $need not found — built and verified nothing"
        exit 1
    }
done

WAD_DIR="${1:-$SCRIPT_DIR/../../wads/lib}"
ok=0
for v in "RV32IMAC riscv32-linux-musl -mcpu=generic_rv32+m+a+c rv32imac" \
         "RV32GC riscv32-linux-musl rv32gc"; do
    read -r -a f <<< "$v"
    label="${f[0]}" tag="${f[-1]}"
    target="${f[*]:1:${#f[@]}-2}"
    echo "── $label ($target)"
    BE_TARGET="$target" BE_BIN="$SCRIPT_DIR/fs-doom-$tag" QEMU_BE=qemu-riscv32-static \
    CROSS_LABEL="$label" bash "$SCRIPT_DIR/be-check.sh" "$WAD_DIR" "$SCRIPT_DIR/out-$tag"
    ok=$((ok + 1))
done
# be-check.sh exits non-zero on any divergence or any demo not verified, and
# set -e stops here on it: reaching this line means both ran 13 of 13
[ "$ok" -eq 2 ] || { echo "FAIL rv32-check: $ok of 2 builds verified"; exit 1; }
echo "PASS rv32-cross: 13 demos bit-identical on RV32IMAC (soft-float) and 13 demos on RV32GC"
