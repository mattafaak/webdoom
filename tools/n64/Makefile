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
#   make boot-log         run ares headless, capture UART to ares-boot.log
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

# Compile n64tool from source if binary not present.
$(N64TOOL):
	@echo "=== Building n64tool ==="
	gcc -O2 -o $(N64TOOL) $(LIBDRAGON)/tools/n64tool.c
	@echo "n64tool built"

N64_ZONE_KB ?= 512

# Common flags for both engine/core and N64 shim.
# ABI landmine mitigations (docs/n64/MIPS-ABI-LANDMINES.md):
#   -fno-strict-aliasing — class 4 landmine mitigation
#   -fsigned-char        — class 3 landmine mitigation (char signedness)
#   -Wno-int-to-pointer-cast — class 5 landmine mitigation (lumpinfo handle)
#   -Wno-pointer-to-int-cast — class 5 landmine mitigation
COMMON_FLAGS := -mabi=o64 -march=vr4300 -mtune=vr4300 \
                -O2 \
                -DNORMALUNIX \
                -DMAXSCREENWIDTH=320 \
                -DN64_ZONE_KB=$(N64_ZONE_KB) \
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

$(OUT_ROM): $(OUT_ELF) | $(N64TOOL)
	$(STRIP) -s -o $(OUT_ELF).stripped $(OUT_ELF)
	$(N64TOOL) --title "webdoom-n64" --output $@ --align 256 $(OUT_ELF).stripped
	@echo "built $@"
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

# Boot-log target: run ares headless and capture ISViewer UART to ares-boot.log.
# xvfb-run is used in headless CI environments (no display server).
# Timeout: 15 s is sufficient for D_DoomMain banner to appear.
ARES        ?= ares
ARES_TIMEOUT ?= 15

boot-log: $(OUT_ROM)
	@echo "=== Running ares (timeout $(ARES_TIMEOUT)s) ==="
	@rm -f ares-boot.log ares-uart.tmp
	@if command -v xvfb-run >/dev/null 2>&1; then \
	    timeout $(ARES_TIMEOUT) xvfb-run -a \
	        $(ARES) --system "Nintendo 64" --no-file-prompt $(OUT_ROM) \
	        >ares-uart.tmp 2>&1 || true; \
	else \
	    timeout $(ARES_TIMEOUT) \
	        $(ARES) --system "Nintendo 64" --no-file-prompt $(OUT_ROM) \
	        >ares-uart.tmp 2>&1 || true; \
	fi
	@# ares writes ISViewer output to stdout; filter for DOOM banner lines.
	@cp ares-uart.tmp ares-boot.log
	@echo "--- ares UART output ---"
	@cat ares-boot.log
	@echo "--- end of ares output ---"
	@if grep -q "DOOM\|Startup\|Public DOOM\|W_Init\|V_Init\|Z_Init" ares-boot.log 2>/dev/null; then \
	    echo "BOOT LOG: D_DoomMain banner detected in ares UART output"; \
	else \
	    echo "BOOT LOG: D_DoomMain banner not detected (see ares-boot.log)"; \
	fi

clean:
	rm -rf $(OBJ_DIR) $(OUT_ELF) $(OUT_ELF).stripped $(OUT_ROM) \
	       ares-uart.tmp ares-boot.log

.PHONY: all size boot-log clean
