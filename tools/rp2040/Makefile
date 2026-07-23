# tools/rp2040/Makefile — RP2040 (Cortex-M0+) footprint build for webdoom.
#
# PURPOSE: cross-compile engine/core + RP2040 shim to measure .text/.data/.bss,
# prove the shim pattern works, and produce an ELF for arm-none-eabi-size.
# This is NOT a pico-sdk build — it produces a hosted ELF (not a UF2 image).
#
# Goal: answer "does engine/core fit in RP2040?" with measured numbers, not
# estimates.  Boot-to-D_DoomMain is BLOCKED on pico-sdk (see docs/rp2040/BRING-UP.md).
#
# Requirements:
#   arm-none-eabi-gcc (Arch: arm-none-eabi-gcc; Ubuntu: gcc-arm-none-eabi)
#   arm-none-eabi-size (same package)
#
# Usage:
#   make                 build rp2040-doom.elf and print size report
#   make size            print arm-none-eabi-size summary only
#   make clean
#
# Override zone size (default 256 KB token for footprint build):
#   make RP2040_ZONE_KB=512
#
# engine/core: 0-diff.  Only tools/rp2040/ and docs/rp2040/ are new.

CC      := arm-none-eabi-gcc
SIZE    := arm-none-eabi-size

# Zone size (in KB): default 256 KB lets the shim link.
# This is NOT enough to run DOOM; see docs/rp2040/BRING-UP.md for zone analysis.
RP2040_ZONE_KB ?= 256

CFLAGS  := -mcpu=cortex-m0plus -mthumb -mfloat-abi=soft \
            -O1 -std=gnu89 \
            -DNORMALUNIX \
            -DMAXSCREENWIDTH=320 \
            -DRP2040_ZONE_KB=$(RP2040_ZONE_KB) \
            -Dalloca=__builtin_alloca \
            -fno-strict-aliasing \
            -Wno-unused-variable \
            -Wno-unused-but-set-variable \
            -Wno-dangling-else \
            -Wno-parentheses \
            -Wno-missing-braces \
            -Wno-unused-value \
            -Wno-pointer-sign \
            -I../../engine/core \
            -I../../tools/freestanding \
            -I.

# Link with newlib nosys stubs (no OS): _write/_sbrk etc. from i_system_rp2040.c.
# -lm must come AFTER object files so the linker resolves math symbols correctly.
LDFLAGS  := -mcpu=cortex-m0plus -mthumb -mfloat-abi=soft -specs=nosys.specs
LDLIBS   := -lm

CORE_DIR := ../../engine/core
OUT      := rp2040-doom.elf
OBJ_DIR  := obj

# engine/core sources: same excludes as freestanding build (we provide shims).
CORE_EXCLUDE := $(CORE_DIR)/i_main.c \
                $(CORE_DIR)/i_net.c  \
                $(CORE_DIR)/i_sound.c \
                $(CORE_DIR)/i_system.c \
                $(CORE_DIR)/i_video.c \
                $(CORE_DIR)/d_net.c

CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE_DIR)/*.c))

# RP2040 shim files (this directory).
PLAT_SRC := rp2040_main.c \
            i_system_rp2040.c \
            i_video_rp2040.c \
            i_sound_rp2040.c \
            d_net_rp2040.c \
            files_rp2040.c \
            perf_rp2040.c

SRC := $(CORE_SRC) $(PLAT_SRC)
OBJ := $(patsubst $(CORE_DIR)/%.c,$(OBJ_DIR)/core/%.o,$(filter $(CORE_DIR)/%,$(SRC))) \
       $(patsubst %.c,$(OBJ_DIR)/plat/%.o,$(PLAT_SRC))

all: $(OUT) size

$(OUT): $(OBJ)
	$(CC) $(LDFLAGS) $^ $(LDLIBS) -o $@
	@echo "built $@"

$(OBJ_DIR)/core/%.o: $(CORE_DIR)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(OBJ_DIR)/plat/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

size: $(OUT)
	@echo "=== arm-none-eabi-size $(OUT) ==="
	@$(SIZE) $(OUT)
	@echo ""
	@echo "=== Top BSS contributors ==="
	@arm-none-eabi-nm --size-sort --print-size $(OUT) 2>/dev/null | \
	    grep " [bB] " | sort -k2 -rn | head -20 || true
	@echo ""
	@echo "=== RP2040 budget vs actual ==="
	@$(SIZE) $(OUT) | awk 'NR==2 { \
	    flash=$$1+$$2; sram=$$2+$$3; \
	    flash_cap=2097152; sram_cap=270336; \
	    printf "  Flash (.text+.data init): %7d B  / %7d B  (%+d B)\n", flash, flash_cap, flash_cap-flash; \
	    printf "  SRAM  (.data+.bss):       %7d B  / %7d B  (%+d B)\n", sram, sram_cap, sram_cap-sram; \
	}'

clean:
	rm -rf $(OBJ_DIR) $(OUT)

.PHONY: all size clean
