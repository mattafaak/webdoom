#!/usr/bin/env bash
# tools/freestanding/be-build.sh — cross-build fs-doom for a big-endian target.
#
# Ladder choice (task 13.3a):
#   (1) m68k-linux-musl — skipped: zig 0.16 LLVM backend for m68k is
#       EXPERIMENTAL; no qemu-m68k-static confirmed on this host.
#   (2) powerpc-linux-musleabi — SELECTED: BE, 32-bit, integer unaligned
#       loads OK (rung A), solid LLVM backend, qemu-ppc-static present.
#   (3) mips-linux-musl — not tried yet (strict alignment = rung B variable).
#
# Usage:
#   bash tools/freestanding/be-build.sh [outfile]
#   outfile defaults to tools/freestanding/fs-doom-be
#
# Requirements:
#   zig >= 0.16  (provides bundled musl + powerpc cross-compiler)
#   qemu-ppc-static (for run-time testing, not needed for compilation)
#
# Notes:
#   - No -m32 flag: powerpc-linux-musleabi is natively 32-bit.
#   - -static: required so the binary runs under qemu-user-static without
#     a matching chroot.
#   - perf_event_open headers (linux/perf_event.h, sys/syscall.h) compile
#     cleanly for powerpc-linux-musleabi; the WD_CYCLES=1 runtime path is
#     x86-only but the code compiles on any Linux target.
#   - Warnings suppressed at the same level as the native Makefile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORE_DIR="$REPO_ROOT/engine/core"

OUT="${1:-$SCRIPT_DIR/fs-doom-be}"

BE_TARGET="powerpc-linux-musleabi"
ZIG_CC="zig cc -target $BE_TARGET"

CFLAGS=(
    -fsigned-char
    -static
    -O1
    -g
    -std=gnu89
    -DNORMALUNIX
    "-Dalloca=__builtin_alloca"
    -fno-strict-aliasing
    -Wall
    -Wno-unused-variable
    -Wno-unused-but-set-variable
    -Wno-dangling-else
    -Wno-parentheses
    -Wno-missing-braces
    -Wno-unused-value
    -Wno-pointer-sign
    -Wno-implicit-int
    "-I$CORE_DIR"
    "-I$SCRIPT_DIR"
)

# engine/core sources: same exclusions as native Makefile.
CORE_EXCLUDE=(
    "$CORE_DIR/i_main.c"
    "$CORE_DIR/i_net.c"
    "$CORE_DIR/i_sound.c"
    "$CORE_DIR/i_system.c"
    "$CORE_DIR/i_video.c"
    "$CORE_DIR/d_net.c"
)
mapfile -t ALL_CORE < <(ls "$CORE_DIR"/*.c)
CORE_SRC=()
for f in "${ALL_CORE[@]}"; do
    skip=0
    for ex in "${CORE_EXCLUDE[@]}"; do
        [[ "$f" == "$ex" ]] && skip=1 && break
    done
    [[ $skip -eq 0 ]] && CORE_SRC+=("$f")
done

PLAT_SRC=(
    "$SCRIPT_DIR/i_main.c"
    "$SCRIPT_DIR/i_system.c"
    "$SCRIPT_DIR/i_video.c"
    "$SCRIPT_DIR/i_sound.c"
    "$SCRIPT_DIR/d_net.c"
    "$SCRIPT_DIR/files.c"
    "$SCRIPT_DIR/perf.c"
)

echo "be-build.sh: target=$BE_TARGET out=$OUT"
$ZIG_CC "${CFLAGS[@]}" "${CORE_SRC[@]}" "${PLAT_SRC[@]}" -lm -o "$OUT"
echo "be-build.sh: built $OUT ($(file "$OUT" | grep -o 'ELF.*'))"
