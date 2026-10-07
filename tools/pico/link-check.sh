#!/usr/bin/env bash
# tools/pico/link-check.sh — does the full-diet engine fit a Raspberry Pi
# RP2350 or RP2040?  Answered at link time, with pico-sdk's own linker scripts
# for each chip's real memory map: nothing is run, no board is needed.
#
#   bash tools/pico/link-check.sh [BUILD_DIR]
#
# Configures one pico-sdk build tree per chip and optimisation level under
# BUILD_DIR (default tools/pico/build, this checkout's own: a tree another
# checkout configured is refused by cmake, so a shared default broke the
# leg in a second worktree), links every variant
# (tools/pico/CMakeLists.txt) and reads each one's map and ELF
# (tools/pico/mapsum.py):
#   RP2350, Pimoroni Pico Plus 2 (16 MiB flash, 8 MiB PSRAM on the QMI's CS1):
#     sram-sound, sram-nosound     everything writable in the 520 KiB SRAM
#     psram-sound, psram-nosound   the zone and screens[0] in PSRAM
#     psram-zone-sound, -nosound   the zone in PSRAM, screens[0] in SRAM
#     psram-heap-sound, -nosound   the zone, screens[0] and newlib's heap
#                                  (HEAP_KB) in PSRAM; stack, .data, .bss in
#                                  SRAM
# (fs_audio.c's harness buffers are cut to one entry: FS_AUDIO_HARNESS=0)
#   RP2040, Pimoroni Pico LiPo 16MB (16 MiB flash, no PSRAM; a 2 MiB Pico
#   cannot hold the code and one IWAD's const texture tables, ~2.1 MB, let
#   alone the WAD):
#     sram-sound, sram-nosound
# "-sound" is the game with its sound (the OPL synth and the sfx mixer feeding
# a DAC that discards it); "-nosound" stubs the sound stack out.
#
# A variant that does not fit is a RESULT: its link fails with the linker's
# own overflow message ("region `RAM' overflowed by N bytes", or "address A of
# ... section `.heap' is not within region `RAM'"), which is its verdict, and
# its sizes come from a twin linked with a 64 MiB RAM region (mapsum.py checks
# the two agree to the byte).  The script fails only when it could not measure a
# variant: a compile error, a link that failed some other way, a map that does
# not say what it should.  It exits 0 only if it measured every variant.
#
# Environment: ZONE_KB (604), HEAP_KB (295), STACK_KB (6): the full diet's
# measured floor, ARMv8-M heap and stack (tools/golden/floor-ram.json); WAD_OFFSET_KB
# (3072), OPTS ("-O1 -Os": the engine's levels; -O1 is the floor's), CHIPS
# ("rp2350 rp2040"), REQUIRE_FIT (variant labels, comma-separated, as the
# summary prints them, e.g. "RP2350 psram-sound -O1": each must fit, or the
# script fails: the run-tests leg holds the RP2350's verdict this way).
# pico-sdk comes from PICO_SDK_PATH (~/toolchains/env.sh is sourced when it
# is unset).  No network: FetchContent is disconnected, and no
# target needs picotool.
# Copyright (C) 2026, GPL-2.0-or-later.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD="${1:-$HERE/build}"
ZONE_KB="${ZONE_KB:-604}"
HEAP_KB="${HEAP_KB:-295}"
STACK_KB="${STACK_KB:-6}"
WAD_OFFSET_KB="${WAD_OFFSET_KB:-3072}"
OPTS="${OPTS:--O1 -Os}"
CHIPS="${CHIPS:-rp2350 rp2040}"

if [ -z "${PICO_SDK_PATH:-}" ] && [ -f "$HOME/toolchains/env.sh" ]; then
    # shellcheck disable=SC1091
    source "$HOME/toolchains/env.sh"
fi
for need in cmake ninja arm-none-eabi-gcc arm-none-eabi-objdump arm-none-eabi-nm gcc python3; do
    command -v "$need" >/dev/null 2>&1 || {
        echo "FAIL link-check: $need not found: measured nothing"
        exit 1
    }
done
[ -n "${PICO_SDK_PATH:-}" ] && [ -f "$PICO_SDK_PATH/external/pico_sdk_import.cmake" ] || {
    echo "FAIL link-check: no pico-sdk at PICO_SDK_PATH='${PICO_SDK_PATH:-}': measured nothing"
    exit 1
}
sdk_version="$(sed -n 's/^ *set(PICO_SDK_VERSION_\(MAJOR\|MINOR\|REVISION\) \([0-9]*\))/\2/p' \
    "$PICO_SDK_PATH/pico_sdk_version.cmake" | paste -sd.)"

# the IWADs, if this checkout has them, to set against the WAD's room in flash
IWADS=()
for w in doom1.wad doom.wad doom2.wad plutonia.wad tnt.wad; do
    if [ -f "$ROOT/wads/lib/$w" ]; then
        IWADS+=(--iwad "$w=$(stat -L -c %s "$ROOT/wads/lib/$w")")
    fi
done

echo "link-check: link only: nothing ran.  pico-sdk $sdk_version at $PICO_SDK_PATH,"
echo "  $(arm-none-eabi-gcc --version | sed -n 1p);"
echo "  ZONE_KB=$ZONE_KB HEAP_KB=$HEAP_KB STACK_KB=$STACK_KB WAD_OFFSET_KB=$WAD_OFFSET_KB;"
echo "  engine at OPTS='$OPTS', pico-sdk's own code at CMAKE_BUILD_TYPE=Release (-O3);"
echo "  build trees under $BUILD"
mkdir -p "$BUILD"

expected=0
measured=0
over=0
ROWS=()
VERDICTS=()

for chip in $CHIPS; do
    case "$chip" in
        rp2350) board=pimoroni_pico_plus2_rp2350; chipname=RP2350
                variants="sram-sound sram-nosound psram-sound psram-nosound psram-zone-sound psram-zone-nosound psram-heap-sound psram-heap-nosound" ;;
        rp2040) board=pimoroni_picolipo_16mb; chipname=RP2040
                variants="sram-sound sram-nosound" ;;
        *) echo "FAIL link-check: unknown chip '$chip'"; exit 1 ;;
    esac
    for opt in $OPTS; do
        tree="$BUILD/$chip$opt"
        logs="$tree/logs"
        # a tree configured from another source directory (another checkout,
        # a moved one) is one cmake will not reuse: start it again
        if [ -f "$tree/CMakeCache.txt" ] &&
            ! grep -qxF "CMAKE_HOME_DIRECTORY:INTERNAL=$HERE" "$tree/CMakeCache.txt"; then
            echo "  $tree was configured from another source directory: removed"
            rm -rf "$tree"
        fi
        mkdir -p "$logs"
        if ! cmake -G Ninja -S "$HERE" -B "$tree" \
            -DPICO_PLATFORM="$chip" -DPICO_BOARD="$board" \
            -DFETCHCONTENT_FULLY_DISCONNECTED=ON \
            -DZONE_KB="$ZONE_KB" -DHEAP_KB="$HEAP_KB" -DSTACK_KB="$STACK_KB" \
            -DWAD_OFFSET_KB="$WAD_OFFSET_KB" -DOPT="$opt" \
            >"$logs/configure.log" 2>&1; then
            echo "FAIL link-check: configuring $chip $opt failed:"
            tail -n 30 "$logs/configure.log"
            exit 1
        fi
        # the objects first: a compile error is the script's failure, not a fit
        if ! cmake --build "$tree" --target engine_core engine_sound engine_nosound \
            >"$logs/objects.log" 2>&1; then
            echo "FAIL link-check: compiling the engine for $chip $opt failed:"
            tail -n 30 "$logs/objects.log"
            exit 1
        fi
        for v in $variants; do
            expected=$((expected + 1))
            target="$chip-$v"
            zone_region=RAM
            screens_region=RAM
            heap_region=RAM
            case "$v" in
                psram-zone-*) zone_region=PSRAM ;;
                psram-heap-*) zone_region=PSRAM; screens_region=PSRAM; heap_region=PSRAM ;;
                psram-*) zone_region=PSRAM; screens_region=PSRAM ;;
            esac
            # the twin must link: it is what a variant that does not fit is
            # measured from
            if ! cmake --build "$tree" --target "$target-big" \
                >"$logs/$target-big.log" 2>&1; then
                echo "FAIL link-check: the measuring twin $target-big did not link:"
                tail -n 30 "$logs/$target-big.log"
                exit 1
            fi
            # a stale ELF must not stand in for this link's result
            rm -f "$tree/$target.elf"
            if cmake --build "$tree" --target "$target" >"$logs/$target.log" 2>&1; then
                rc=0
            else
                rc=$?
            fi
            if ! out="$(python3 "$HERE/mapsum.py" --dir "$tree" --name "$target" \
                --label "$chipname $v $opt" --rc "$rc" --log "$logs/$target.log" \
                --zone-region "$zone_region" --screens-region "$screens_region" \
                --heap-region "$heap_region" \
                ${IWADS[@]+"${IWADS[@]}"})"; then
                echo "$out"
                echo "FAIL link-check: $chipname $v $opt could not be measured (log: $logs/$target.log)"
                exit 1
            fi
            grep -v '^ROW|' <<<"$out"
            echo
            ROWS+=("$(grep '^ROW|' <<<"$out")")
            VERDICTS+=("$(grep '^VERDICT ' <<<"$out")")
            measured=$((measured + 1))
            [ "$rc" -eq 0 ] || over=$((over + 1))
        done
    done
done

echo "== summary (B; measured from each link's ELF and map; SRAM = RAM + the"
echo "   scratch banks, which hold the ${STACK_KB} KiB stack; the heap is the"
echo "   ${HEAP_KB} KiB reservation, in RAM or, for psram-heap, in PSRAM)"
printf '%-30s %8s %7s %9s %16s %6s %16s %7s %17s %9s\n' \
    variant flash .data .bss "heap (where)" stack "zone (where)" screen0 "SRAM used/cap" PSRAM
for r in "${ROWS[@]}"; do
    IFS='|' read -r _ label flash data bss heap stack zone sram zreg cap psram _ sreg hreg <<<"$r"
    printf '%-30s %8s %7s %9s %16s %6s %16s %7s %17s %9s\n' \
        "$label" "$flash" "$data" "$bss" "$heap ($hreg)" "$stack" "$zone ($zreg)" "$sreg" \
        "$sram/$cap" "$psram"
done
echo
for v in "${VERDICTS[@]}"; do
    echo "${v#VERDICT }"
done
echo
# the variants that must fit (REQUIRE_FIT): each must have been measured and fit
missing_fit=0
IFS=',' read -r -a REQ <<<"${REQUIRE_FIT:-}"
for want in "${REQ[@]}"; do
    want="$(sed 's/^ *//; s/ *$//' <<<"$want")"
    [ -n "$want" ] || continue
    hit=""
    for r in "${ROWS[@]}"; do
        IFS='|' read -r _ label _ _ _ _ _ _ _ _ _ _ fit _ <<<"$r"
        [ "$label" = "$want" ] && hit="$fit"
    done
    if [ "$hit" != "fits" ]; then
        if [ -n "$hit" ]; then why="does not fit"; else why="was not measured"; fi
        echo "FAIL link-check: REQUIRE_FIT names '$want', which $why"
        missing_fit=$((missing_fit + 1))
    fi
done
[ "$missing_fit" -eq 0 ] || exit 1
echo "link-check: measured $measured of $expected variants ($over do not fit)${REQUIRE_FIT:+; required to fit and fit: $REQUIRE_FIT}; link only: nothing ran"
[ "$measured" -eq "$expected" ]
