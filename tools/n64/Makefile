# tools/n64/Makefile — N64 libdragon footprint + ROM build for webdoom.
#
# PURPOSE: cross-compile engine/core + N64 shim against libdragon,
# produce a .z64 ROM, run in ares emulator, and capture the D_DoomMain
# UART banner from the ares ISViewer channel.
#
# REQUIREMENTS:
#   N64_INST    — libdragon toolchain root (e.g. ~/toolchains/n64)
#   LIBDRAGON   — libdragon source root (e.g. ~/toolchains/libdragon)
#   mips64-elf-gcc, mips64-elf-size, mips64-elf-strip (in N64_INST/bin)
#   n64tool (compiled from $(LIBDRAGON)/tools/n64tool.c)
#   ares        — emulator on PATH
#
# Usage:
#   make                  build n64-doom.elf + n64-doom.z64
#   make size             print mips64-elf-size summary
#   make boot-log         run ares headless, capture UART to ares-boot-raw.log
#   make clean
#
# Override zone size (default 512 KB):
#   make N64_ZONE_KB=2048
#
# engine/core: 0-diff.  Only tools/n64/ and docs/n64/ are new.

N64_INST    ?= $(HOME)/toolchains/n64
LIBDRAGON   ?= $(HOME)/toolchains/libdragon

CC      := $(N64_INST)/bin/mips64-elf-gcc
SIZE    := $(N64_INST)/bin/mips64-elf-size
STRIP   := $(N64_INST)/bin/mips64-elf-strip
N64TOOL := $(LIBDRAGON)/tools/n64tool

# `all` must be the default goal: Make picks the FIRST target in the file, and
# the $(N64TOOL) rule below would otherwise win — a bare `make` then reports
# success having built only the ROM packer, never the ROM.
.DEFAULT_GOAL := all

# Compile n64tool from source if binary not present.
$(N64TOOL):
	@echo "=== Building n64tool ==="
	gcc -O2 -o $(N64TOOL) $(LIBDRAGON)/tools/n64tool.c
	@echo "n64tool built"

N64_ZONE_KB ?= 512

# ── WAD embedding ────────────────────────────────────────────────────────────
# The IWAD is appended into the ROM at N64_WAD_OFFSET and read IN PLACE from
# cartridge address space.  It cannot be copied to RDRAM: doom.wad is
# 12,408,292 B while the N64 has 4 MB (8 MB with Expansion Pak), of which the
# engine already uses ~990 KB.
#
# The offset must clear the ELF payload (~360 KB); 2 MiB leaves generous room.
# Cartridge domain 1 is physical 0x10000000, addressed by the CPU through
# KSEG1 (uncached) at 0xB0000000 — so the WAD's virtual address is
# 0xB0000000 + N64_WAD_OFFSET.  Uncached is required: the CPU must not cache
# reads of cartridge space that it never wrote.
#
# Set N64_WAD= to build a footprint-only ROM with no WAD (the previous default).
N64_WAD        ?= ../../wads/lib/doom.wad
N64_WAD_OFFSET ?= 2097152
# Engine-visible name. IdentifyVersion() probes doom2f/doom2/plutonia/tnt/
# doomu/doom/doom1 in that order (d_main.c:592-630); this project's doom.wad is
# Ultimate DOOM, which the wasm build likewise presents as doomu.wad.
N64_WAD_NAME   ?= doomu.wad
# Length is measured from the file at configure time and compiled in: the shim
# has no filesystem to ask at runtime. 0 when no WAD is embedded.
N64_WAD_LEN    := $(if $(strip $(N64_WAD)),$(shell wc -c < $(N64_WAD) 2>/dev/null || echo 0),0)

# Common flags for both engine/core and N64 shim.
# ABI landmine mitigations (docs/n64/MIPS-ABI-LANDMINES.md):
#   -fno-strict-aliasing — class 4 landmine mitigation
#   -fsigned-char        — class 3 landmine mitigation (char signedness)
#   -Wno-int-to-pointer-cast — class 5 landmine mitigation (lumpinfo handle)
#   -Wno-pointer-to-int-cast — class 5 landmine mitigation
COMMON_FLAGS := -mabi=o64 -march=vr4300 -mtune=vr4300 \
                -O2 \
                -D__BIG_ENDIAN__ \
                -DNORMALUNIX \
                -DMAXSCREENWIDTH=320 \
                -DN64_ZONE_KB=$(N64_ZONE_KB) \
                -DN64_WAD_OFFSET=$(N64_WAD_OFFSET) \
                -DN64_WAD_LEN=$(N64_WAD_LEN) \
                -DN64_WAD_NAME=\"$(N64_WAD_NAME)\" \
                -Dalloca=__builtin_alloca \
                -fno-strict-aliasing \
                -fsigned-char \
                -ffunction-sections -fdata-sections \
                -Wno-unused-variable \
                -Wno-unused-but-set-variable \
                -Wno-dangling-else \
                -Wno-parentheses \
                -Wno-missing-braces \
                -Wno-unused-value \
                -Wno-pointer-sign \
                -Wno-int-to-pointer-cast \
                -Wno-pointer-to-int-cast \
                -I../../engine/core \
                -I../../tools/freestanding \
                -I$(N64_INST)/mips64-elf/include \
                -I.

# engine/core: C89 (DOOM source uses implicit-int, pre-C99 declarations).
CORE_CFLAGS := $(COMMON_FLAGS) -std=gnu89

# N64 shim: C11 (needed for libdragon headers; their 'inline' semantics
# require C99+ to avoid multiple-definition of non-static inline functions).
PLAT_CFLAGS := $(COMMON_FLAGS) -std=gnu11

# Linker: use libdragon's n64.ld (provides _start + memory map).
# -ldragon: libdragon runtime (debug, timer, interrupts, etc.)
# -ldragonsys: libdragon C runtime entry point
# -lm: math (trig tables T_GenerateTables)
# -lc: newlib C library
# --gc-sections: strip unreferenced sections
LDSCRIPT := $(LIBDRAGON)/n64.ld
LDFLAGS  := -mabi=o64 -march=vr4300 -mtune=vr4300 \
             -L$(N64_INST)/mips64-elf/lib \
             -Wl,--gc-sections \
             -Wl,-T$(LDSCRIPT)
LDLIBS   := -ldragon -lm -ldragonsys -lc

CORE_DIR := ../../engine/core
OUT_ELF  := n64-doom.elf
OUT_ROM  := n64-doom.z64
OBJ_DIR  := obj

# engine/core sources: same excludes as freestanding build (we provide shims).
CORE_EXCLUDE := $(CORE_DIR)/i_main.c \
                $(CORE_DIR)/i_net.c  \
                $(CORE_DIR)/i_sound.c \
                $(CORE_DIR)/i_system.c \
                $(CORE_DIR)/i_video.c \
                $(CORE_DIR)/d_net.c

CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE_DIR)/*.c))

# N64 shim files (this directory).
PLAT_SRC := n64_main.c \
            i_system_n64.c \
            i_video_n64.c \
            i_sound_n64.c \
            d_net_n64.c \
            files_n64.c \
            perf_n64.c

SRC := $(CORE_SRC) $(PLAT_SRC)
OBJ := $(patsubst $(CORE_DIR)/%.c,$(OBJ_DIR)/core/%.o,$(filter $(CORE_DIR)/%,$(SRC))) \
       $(patsubst %.c,$(OBJ_DIR)/plat/%.o,$(PLAT_SRC))

all: $(OUT_ELF) $(OUT_ROM) size

$(OUT_ELF): $(OBJ) | $(N64TOOL)
	$(CC) $(LDFLAGS) $^ $(LDLIBS) -o $@
	@echo "built $@"

# The WAD length is compiled in, so the ROM depends on the WAD file itself.
$(OUT_ROM): $(OUT_ELF) $(N64_WAD) | $(N64TOOL)
	$(STRIP) -s -o $(OUT_ELF).stripped $(OUT_ELF)
ifeq ($(strip $(N64_WAD)),)
	$(N64TOOL) --title "webdoom-n64" --output $@ --align 256 $(OUT_ELF).stripped
	@echo "built $@ (footprint-only: no WAD embedded)"
else
	$(N64TOOL) --title "webdoom-n64" --output $@ --align 256 $(OUT_ELF).stripped \
	           --offset $(N64_WAD_OFFSET) $(N64_WAD)
	@echo "built $@ with $(N64_WAD) at offset $(N64_WAD_OFFSET)"
	@# Prove the WAD really landed in the image rather than trusting the tool.
	@if grep -qa "IWAD\|PWAD" $@; then \
	    echo "WAD magic present in ROM"; \
	else \
	    echo "ERROR: no IWAD/PWAD magic in $@ — WAD was not embedded" >&2; exit 1; \
	fi
endif
	@echo "ROM size: $$(wc -c < $@) bytes"

$(OBJ_DIR)/core/%.o: $(CORE_DIR)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CORE_CFLAGS) -c $< -o $@

$(OBJ_DIR)/plat/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(PLAT_CFLAGS) -c $< -o $@

size: $(OUT_ELF)
	@echo "=== mips64-elf-size $(OUT_ELF) ==="
	@$(SIZE) $(OUT_ELF)
	@echo ""
	@echo "=== N64 RDRAM budget vs actual ==="
	@$(SIZE) $(OUT_ELF) | awk 'NR==2 { \
	    rdram_used=$$2+$$3; \
	    rdram_4mb=4194304; rdram_8mb=8388608; \
	    printf "  RDRAM in-use (.data+.bss):  %7d B  (%6.1f KB)\n", rdram_used, rdram_used/1024.0; \
	    printf "  4 MB RDRAM headroom:        %7d B  (%6.1f KB)\n", rdram_4mb-rdram_used, (rdram_4mb-rdram_used)/1024.0; \
	    printf "  8 MB RDRAM headroom:        %7d B  (%6.1f KB)\n", rdram_8mb-rdram_used, (rdram_8mb-rdram_used)/1024.0; \
	    printf "  Zone arena (N64_ZONE_KB):   %7d KB\n", $(N64_ZONE_KB); \
	}'
	@echo ""
	@echo "=== Top BSS contributors (RDRAM static) ==="
	@$(N64_INST)/bin/mips64-elf-nm --size-sort --print-size $(OUT_ELF) 2>/dev/null | \
	    grep " [bB] " | sort -k2 -rn | head -10 || true

# Boot-log target: run ares headless and capture ISViewer UART to
# ares-boot-raw.log (untracked). ares-boot.log is curated, committed evidence.
# xvfb-run is used in headless CI environments (no display server).
# Timeout: 15 s is sufficient for D_DoomMain banner to appear.
ARES        ?= ares
ARES_TIMEOUT ?= 15

boot-log: $(OUT_ROM)
	@echo "=== Running ares (timeout $(ARES_TIMEOUT)s) ==="
	@rm -f ares-boot-raw.log ares-uart.tmp
	@if command -v xvfb-run >/dev/null 2>&1; then \
	    timeout $(ARES_TIMEOUT) xvfb-run -a \
	        $(ARES) --system "Nintendo 64" --no-file-prompt $(OUT_ROM) \
	        >ares-uart.tmp 2>&1 || true; \
	else \
	    timeout $(ARES_TIMEOUT) \
	        $(ARES) --system "Nintendo 64" --no-file-prompt $(OUT_ROM) \
	        >ares-uart.tmp 2>&1 || true; \
	fi
	@# ares writes ISViewer output to stdout. Raw capture goes to
	@# ares-boot-raw.log; ares-boot.log is CURATED evidence (committed) and is
	@# deliberately not clobbered by a run.
	@cp ares-uart.tmp ares-boot-raw.log
	@echo "--- ares UART output ---"
	@cat ares-boot-raw.log
	@echo "--- end of ares output ---"
	@if grep -q "DOOM\|Startup\|Public DOOM\|W_Init\|V_Init\|Z_Init" ares-boot-raw.log 2>/dev/null; then \
	    echo "BOOT LOG: D_DoomMain banner detected in ares UART output"; \
	else \
	    echo "BOOT LOG: D_DoomMain banner not detected (see ares-boot-raw.log)"; \
	fi

# NOTE: ares-boot.log is committed evidence required by the 20.4b DoD, so it is
# deliberately NOT removed here — `make clean` used to delete it, which silently
# destroyed a tracked file. Only build outputs and scratch files go.
clean:
	rm -rf $(OBJ_DIR) $(OUT_ELF) $(OUT_ELF).stripped $(OUT_ROM) \
	       ares-uart.tmp

.PHONY: all size boot-log clean
