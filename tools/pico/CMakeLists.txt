# tools/pico/CMakeLists.txt — the full-diet engine linked for the Raspberry Pi
# RP2350 (Cortex-M33) and RP2040 (Cortex-M0+) with pico-sdk: a link-time
# memory check.  Nothing here is ever run; link-check.sh drives it and reads
# the map files.
#
# The engine is the full memory diet, what `make -C tools/freestanding LEAN=1
# ZERO_COPY=1 LEAN_LEVELS=1` builds for x86 (fs-doom-full), with one IWAD's
# texture tables (TEXTURES_WADS, a port ships its one WAD's), compiled with
# tools/cortexm's ARM flags: engine/core minus the six files
# the platform replaces, tools/freestanding's platform layer and its audio
# (fs_audio.c, sfx_mix.c, fs_mus.c -> engine/web/mus_opl.c, engine/web/opl3.c),
# with
#   WEB_LUMPS_IN_PLACE                     zero copy: lumps read in XIP flash
#   MAXVISPLANES=128 MAXVISSPRITES=128     LEAN
#   TABLES_CONST (+ gen/tables_const.inc)  LEAN: the lookup tables in flash
#   TEXTURES_CONST, COMPOSITES_CONST       LEAN: the texture tables and every
#     (+ gen/textures_const.inc)           composite in flash, TEXTURES_WADS'
#                                          (made by an x86 build of the same
#                                          flags: tools/freestanding's rule)
#   LEAN_SCREENS                           LEAN: screens[1..3] from the zone
#   LEAN_LEVELS                            the level read in place, narrowed
#   FS_ZONE_SIZE_OVERRIDE                  the zone arena, ZONE_KB
#   FS_AUDIO_HARNESS=0                     fs_audio.c's trace and stage
#                                          buffers (the floor harness's,
#                                          933,888 B) cut to one entry each
# The measuring harness (tools/freestanding i_main.c, perf.c, floor_wrap.c,
# tools/floor/floor_log.c) is not linked; pico_main.c supplies what the engine
# needs from it.
#
# One build tree per platform (PICO_PLATFORM, PICO_BOARD); in each, every
# variant is an executable:
#   <p>-sram-sound         everything writable in SRAM, the game with its sound
#   <p>-sram-nosound       the same, the sound stack stubbed out
#                          (pico_nosound.c)
#   <p>-psram-sound        RP2350 only: the zone and screens[0] in PSRAM
#   <p>-psram-nosound      (and fs_audio.c's one-entry harness buffers)
#                          (ld/psram/sections_psram.incl + ld/psram-screens)
#   <p>-psram-zone-sound   RP2350 only: the zone in PSRAM, screens[0] left
#   <p>-psram-zone-nosound in SRAM (+ ld/psram-zone)
#   <p>-psram-heap-sound   RP2350 only: the zone, screens[0] AND newlib's heap
#   <p>-psram-heap-nosound in PSRAM; the stack, .data and .bss in SRAM
#                          (the "psram" files + ld/psram-heap/section_heap.incl
#                          and pico_psram_heap.c's _sbrk)
# and each has a "-big" twin linked with a 64 MiB RAM region, so a variant that
# does not fit still has a complete map to measure (the real link's overflow
# message is the verdict; the twin's map is the size breakdown).
#
# Parameters (-D...):
#   ZONE_KB        the zone arena, KiB (default 604: the full diet's
#                  play-inclusive floor, tools/golden/floor-ram.json)
#   HEAP_KB        newlib's heap, reserved in RAM, or in PSRAM in the
#                  psram-heap variants (default 295: armv8m/full's measured
#                  peak over the play set, 301,496 B, a saved game included,
#                  rounded up; it also holds the qemu board's copy of tnt's
#                  directory, which a doom.wad port has no need of)
#   STACK_KB       core 0's stack (default 6: armv8m/full's measured peak,
#                  5,200 B, rounded up): SCRATCH_X + SCRATCH_Y as one region;
#                  core 1 is not used
#   OPT            the engine's optimisation (default -O1, as the floor
#                  measures); pico-sdk's own code is built CMAKE_BUILD_TYPE
#   WAD_OFFSET_KB  where the WAD sits in XIP flash (default 3072: the code
#                  and doom.wad's const texture tables come to ~2.1 MB)
#   WAD_NAME       the name the WAD is registered under, and the IWAD whose
#                  texture tables are built in (default doom.wad)
# Copyright (C) 2026, GPL-2.0-or-later.
cmake_minimum_required(VERSION 3.13)

# No picotool: nothing here makes a UF2, signs, or calls pico_add_extra_outputs.
set(PICO_NO_PICOTOOL 1)
if (NOT DEFINED ENV{PICO_SDK_PATH})
    message(FATAL_ERROR "PICO_SDK_PATH is not set: source ~/toolchains/env.sh")
endif()
include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)
project(webdoom_pico C CXX ASM)
pico_sdk_init()

set(ZONE_KB 604 CACHE STRING "zone arena, KiB")
set(HEAP_KB 295 CACHE STRING "heap reserved, KiB (in RAM; in PSRAM for psram-heap)")
set(STACK_KB 6 CACHE STRING "core 0 stack, KiB (SCRATCH_X + SCRATCH_Y)")
set(OPT -O1 CACHE STRING "engine optimisation level")
set(WAD_OFFSET_KB 3072 CACHE STRING "the WAD's offset in XIP flash, KiB")
set(WAD_NAME doom.wad CACHE STRING "the name the WAD is registered under")
math(EXPR ZONE_BYTES "${ZONE_KB} * 1024")
math(EXPR HEAP_BYTES "${HEAP_KB} * 1024")
math(EXPR STACK_BYTES "${STACK_KB} * 1024")
math(EXPR WAD_OFFSET "${WAD_OFFSET_KB} * 1024")

get_filename_component(ROOT ${CMAKE_CURRENT_LIST_DIR}/../.. ABSOLUTE)
set(CORE ${ROOT}/engine/core)
set(WEB ${ROOT}/engine/web)
set(FS ${ROOT}/tools/freestanding)
set(FLOOR ${ROOT}/tools/floor)
set(GEN ${CMAKE_CURRENT_BINARY_DIR}/gen)

# The SRAM map pico-sdk's linker scripts give each chip
# (src/<chip>/pico_platform/script_include/default_locations.ld): RAM at
# 0x20000000, then the two 4 KiB scratch banks, which are contiguous.
if (PICO_RP2040)
    set(CHIP rp2040)
    set(SCRATCH_BASE 0x20040000)
else()
    set(CHIP rp2350)
    set(SCRATCH_BASE 0x20080000)
endif()

# ── TABLES_CONST: the const tables, generated on the host ────────────────────
# Exactly tools/freestanding/Makefile's $(OBJDIR)/gen/tables_const.inc rule:
# the engine's own generator, -m32, its checksum included.
find_program(HOST_CC NAMES gcc REQUIRED NO_CMAKE_FIND_ROOT_PATH)
add_custom_command(
    OUTPUT ${GEN}/tables_const.inc
    COMMAND ${CMAKE_COMMAND} -E make_directory ${GEN}
    COMMAND ${HOST_CC} -m32 -O1 -std=gnu89 -I${CORE}
            ${FLOOR}/gen-const-tables.c ${CORE}/tables.c -lm
            -o ${GEN}/gen-const-tables
    COMMAND sh -c "'${GEN}/gen-const-tables' > '${GEN}/tables_const.inc.tmp'"
    COMMAND ${CMAKE_COMMAND} -E rename ${GEN}/tables_const.inc.tmp
            ${GEN}/tables_const.inc
    DEPENDS ${FLOOR}/gen-const-tables.c ${CORE}/tables.c ${CORE}/tables_fix.h
    VERBATIM)
# TEXTURES_CONST, COMPOSITES_CONST: tools/freestanding's own rule, run by an
# x86 build of the full diet in this build tree (its fs-texgen boots the
# engine on WAD_NAME and prints what R_InitData built, twice, poisoned two
# ways); the boot-time check holds the target to them against its WAD.
set(X86_GEN ${CMAKE_CURRENT_BINARY_DIR}/x86gen)
add_custom_command(
    OUTPUT ${GEN}/textures_const.inc
    COMMAND ${CMAKE_COMMAND} -E make_directory ${GEN}
    COMMAND make -s -C ${FS} LEAN=1 ZERO_COPY=1 LEAN_LEVELS=1
            TEXTURES_WADS=${WAD_NAME} OBJDIR=${X86_GEN}
            ${X86_GEN}/gen/textures_const.inc
    COMMAND ${CMAKE_COMMAND} -E copy ${X86_GEN}/gen/textures_const.inc
            ${GEN}/textures_const.inc
    DEPENDS ${CORE}/r_data.c ${FLOOR}/gen-texture-tables.c
    VERBATIM)
add_custom_target(gen_tables DEPENDS ${GEN}/tables_const.inc
    ${GEN}/textures_const.inc)

# ── the engine's flags: tools/cortexm/Makefile's, plus LEAN and zero copy ────
set(ENGINE_OPTIONS ${OPT} -g -std=gnu89
    -fno-strict-aliasing -fsigned-char -fno-short-enums
    -ffunction-sections -fdata-sections
    -Wall -Wno-unused-variable -Wno-unused-but-set-variable
    -Wno-dangling-else -Wno-parentheses -Wno-missing-braces
    -Wno-unused-value -Wno-pointer-sign -Wno-implicit-function-declaration)
set(ENGINE_DEFS NORMALUNIX alloca=__builtin_alloca
    _POSIX_TIMERS=1 _POSIX_MONOTONIC_CLOCK=1
    FS_ZONE_SIZE_OVERRIDE=${ZONE_BYTES}
    WEB_LUMPS_IN_PLACE
    MAXVISPLANES=128 MAXVISSPRITES=128 TABLES_CONST LEAN_SCREENS
    TEXTURES_CONST COMPOSITES_CONST LEAN_LEVELS
    FS_AUDIO_HARNESS=0 FS_GET_TIME=pico_get_time)
set(ENGINE_INCLUDES ${CORE} ${FS} ${FLOOR} ${GEN})

function(engine_objects NAME)
    add_library(${NAME} OBJECT ${ARGN})
    target_compile_options(${NAME} PRIVATE ${ENGINE_OPTIONS})
    target_compile_definitions(${NAME} PRIVATE ${ENGINE_DEFS})
    target_include_directories(${NAME} PRIVATE ${ENGINE_INCLUDES})
endfunction()

# engine/core minus what the platform replaces, and the platform layer
file(GLOB CORE_ALL ${CORE}/*.c)
foreach(f i_main.c i_net.c i_sound.c i_system.c i_video.c d_net.c)
    list(REMOVE_ITEM CORE_ALL ${CORE}/${f})
endforeach()
engine_objects(engine_core ${CORE_ALL}
    ${FS}/i_system.c ${FS}/i_video.c ${FS}/d_net.c ${FS}/files.c)
add_dependencies(engine_core gen_tables)
set_source_files_properties(${CORE}/tables.c PROPERTIES
    OBJECT_DEPENDS ${GEN}/tables_const.inc)
set_source_files_properties(${CORE}/r_data.c PROPERTIES
    OBJECT_DEPENDS ${GEN}/textures_const.inc)

# the game's sound: the platform's I_Sound, the mixer, the OPL sequencer and
# synth.  The synth and what converts its output build without fused
# multiply-add (IEEE double, as synth.wasm) and see the web layer's headers and
# an empty <emscripten.h>: the Makefiles' AUDIO flags, on the same three files.
engine_objects(engine_sound ${FS}/i_sound.c ${FS}/fs_audio.c ${FS}/sfx_mix.c
    ${FS}/fs_mus.c ${WEB}/opl3.c)
set_source_files_properties(${FS}/fs_audio.c ${FS}/fs_mus.c ${WEB}/opl3.c
    PROPERTIES COMPILE_OPTIONS "-ffp-contract=off;-I${FS}/stub;-I${WEB}")

# the sound stack stubbed out entirely
engine_objects(engine_nosound ${CMAKE_CURRENT_LIST_DIR}/pico_nosound.c)

# ── the variants ─────────────────────────────────────────────────────────────
# doom_variant(NAME [SOUND] [PSRAM] [SCREENS] [HEAP] [BIG]); with PSRAM,
# SCREENS puts screens[0] in PSRAM too, and HEAP newlib's heap
function(doom_variant NAME)
    cmake_parse_arguments(V "SOUND;PSRAM;SCREENS;HEAP;BIG" "" "" ${ARGN})
    add_executable(${NAME} ${CMAKE_CURRENT_LIST_DIR}/pico_main.c
        $<TARGET_OBJECTS:engine_core>)
    if (V_SOUND)
        target_sources(${NAME} PRIVATE $<TARGET_OBJECTS:engine_sound>)
    else()
        target_sources(${NAME} PRIVATE $<TARGET_OBJECTS:engine_nosound>)
    endif()
    target_link_libraries(${NAME} pico_stdlib)
    if (V_PSRAM)
        # pico-sdk 2.3.0's own PSRAM support: runtime_init_setup_psram brings
        # the QMI's second chip select up at boot (the board header's
        # PICO_PSRAM_CS_PIN and PICO_PSRAM_SIZE_BYTES)
        target_link_libraries(${NAME} hardware_psram)
        pico_add_linker_script_override_path(${NAME}
            ${CMAKE_CURRENT_LIST_DIR}/ld/psram FILES sections_psram.incl)
        if (V_SCREENS)
            set(SCREENS_DIR ${CMAKE_CURRENT_LIST_DIR}/ld/psram-screens)
        else()
            set(SCREENS_DIR ${CMAKE_CURRENT_LIST_DIR}/ld/psram-zone)
        endif()
        pico_add_linker_script_override_path(${NAME} ${SCREENS_DIR}
            FILES webdoom_psram_screens.incl)
        if (V_HEAP)
            # the heap in PSRAM: the SDK's HEAP_LOC cannot leave RAM (see the
            # override's comment), and its _sbrk is bounded by the end of SRAM
            pico_add_linker_script_override_path(${NAME}
                ${CMAKE_CURRENT_LIST_DIR}/ld/psram-heap FILES section_heap.incl)
            target_sources(${NAME} PRIVATE
                ${CMAKE_CURRENT_LIST_DIR}/pico_psram_heap.c)
        endif()
    elseif (V_SCREENS OR V_HEAP)
        message(FATAL_ERROR "${NAME}: SCREENS and HEAP need PSRAM")
    endif()
    pico_add_linker_script_override_path(${NAME}
        ${CMAKE_CURRENT_LIST_DIR}/ld/all FILES section_extra_post_end.incl)
    target_compile_definitions(${NAME} PRIVATE
        PICO_STACK_SIZE=${STACK_BYTES} PICO_HEAP_SIZE=${HEAP_BYTES}
        PICO_WAD_NAME="${WAD_NAME}")
    set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/pico_main.c
        PROPERTIES COMPILE_DEFINITIONS
        "_POSIX_TIMERS=1;_POSIX_MONOTONIC_CLOCK=1")
    pico_set_linker_script_var(${NAME} PICO_WAD_OFFSET ${WAD_OFFSET})
    # the stack: both scratch banks as one region (SCRATCH_X empty, SCRATCH_Y
    # the 8 KiB from the first bank's start); core 1 is never launched
    if (V_BIG)
        # the measuring twin: RAM made 64 MiB, the scratch banks above it
        math(EXPR BIG_SCRATCH "0x20000000 + 0x4000000" OUTPUT_FORMAT HEXADECIMAL)
        pico_set_linker_script_var(${NAME} RAM_LENGTH 0x4000000)
        pico_set_linker_script_var(${NAME} SCRATCH_X_ORIGIN ${BIG_SCRATCH})
        pico_set_linker_script_var(${NAME} SCRATCH_Y_ORIGIN ${BIG_SCRATCH})
    else()
        pico_set_linker_script_var(${NAME} SCRATCH_X_ORIGIN ${SCRATCH_BASE})
        pico_set_linker_script_var(${NAME} SCRATCH_Y_ORIGIN ${SCRATCH_BASE})
    endif()
    pico_set_linker_script_var(${NAME} SCRATCH_X_LENGTH 0)
    pico_set_linker_script_var(${NAME} SCRATCH_Y_LENGTH ${STACK_BYTES})
    # the engine is built -fno-short-enums against newlib's and pico-sdk's
    # defaults (tools/cortexm/Makefile does the same)
    target_link_options(${NAME} PRIVATE
        -Wl,-Map=${CMAKE_CURRENT_BINARY_DIR}/${NAME}.map
        -Wl,--no-enum-size-warning)
endfunction()

foreach(big "" "-big")
    if (big STREQUAL "")
        set(BIGFLAG "")
    else()
        set(BIGFLAG BIG)
    endif()
    doom_variant(${CHIP}-sram-sound${big} SOUND ${BIGFLAG})
    doom_variant(${CHIP}-sram-nosound${big} ${BIGFLAG})
    if (NOT PICO_RP2040)
        doom_variant(${CHIP}-psram-sound${big} SOUND PSRAM SCREENS ${BIGFLAG})
        doom_variant(${CHIP}-psram-nosound${big} PSRAM SCREENS ${BIGFLAG})
        doom_variant(${CHIP}-psram-zone-sound${big} SOUND PSRAM ${BIGFLAG})
        doom_variant(${CHIP}-psram-zone-nosound${big} PSRAM ${BIGFLAG})
        doom_variant(${CHIP}-psram-heap-sound${big} SOUND PSRAM SCREENS HEAP
            ${BIGFLAG})
        doom_variant(${CHIP}-psram-heap-nosound${big} PSRAM SCREENS HEAP
            ${BIGFLAG})
    endif()
endforeach()
