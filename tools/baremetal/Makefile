# tools/baremetal/Makefile — bare-metal ARM rung-2 build of webdoom engine.
#
# Target: qemu-system-arm -M virt -cpu cortex-a7 -m 32M -nographic -kernel bm-doom.elf
# Toolchain: arm-none-eabi-gcc + newlib (-nostartfiles -lc -lm -lgcc)
# Entry: crt0.S → bm_main() in i_main.c
#
# WAD is baked into the ELF via objcopy so no filesystem is needed at runtime.
# The 12.4 MiB WAD lands in .data; the 6 MiB arena is in .bss; total ~20 MiB
# comfortably fits in the 32 MiB QEMU virt RAM.
#
# Usage:
#   make                build bm-doom.elf
#   make run            boot under QEMU (streams UART to stdout, ^C to stop)
#   make check          boot + capture + compare per-tic hashes to golden
#   make clean

CC      := arm-none-eabi-gcc
OBJCOPY := arm-none-eabi-objcopy

ARCH_FLAGS := -march=armv7-a -marm -mfloat-abi=soft

CFLAGS  := $(ARCH_FLAGS) \
            -O1 -g \
            -std=gnu89 -DNORMALUNIX \
            -Dalloca=__builtin_alloca \
            -fno-strict-aliasing \
            -Wall \
            -Wno-unused-variable \
            -Wno-unused-but-set-variable \
            -Wno-dangling-else \
            -Wno-parentheses \
            -Wno-missing-braces \
            -Wno-unused-value \
            -Wno-pointer-sign \
            -I../../engine/core \
            -I.

LDFLAGS_PRE  := $(ARCH_FLAGS) -nostartfiles -T doom.ld -Wl,--gc-sections
# Libraries come AFTER objects; --start-group handles circular deps (libc↔libm).
LDFLAGS_POST := -Wl,--start-group -lc -lm -lgcc -Wl,--end-group

CORE_DIR := ../../engine/core
OUT      := bm-doom.elf
REPO_ROOT := ../..
WAD_SRC  := $(REPO_ROOT)/wads/lib/doom.wad

# engine/core sources (same excludes as freestanding — we provide our own).
CORE_EXCLUDE := $(CORE_DIR)/i_main.c \
                $(CORE_DIR)/i_net.c  \
                $(CORE_DIR)/i_sound.c \
                $(CORE_DIR)/i_system.c \
                $(CORE_DIR)/i_video.c \
                $(CORE_DIR)/d_net.c

CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE_DIR)/*.c))

# Bare-metal platform files (this directory).
PLAT_SRC := i_main.c i_system.c i_video.c i_sound.c d_net.c files.c perf.c \
            syscalls.c

OBJ := obj/crt0.o \
       $(patsubst $(CORE_DIR)/%.c,obj/core/%.o,$(filter $(CORE_DIR)/%,$(CORE_SRC))) \
       $(patsubst %.c,obj/plat/%.o,$(PLAT_SRC)) \
       obj/wad.o

all: $(OUT)

# ── baked WAD (objcopy from repo root for clean symbol names) ─────────────────
# Symbol: _binary_wads_lib_doom_wad_start / _end
obj/wad.o: $(WAD_SRC)
	@mkdir -p obj
	cd $(REPO_ROOT) && $(OBJCOPY) \
	    -I binary -O elf32-littlearm -B arm \
	    wads/lib/doom.wad $(abspath obj/wad.o)

# ── startup ───────────────────────────────────────────────────────────────────
obj/crt0.o: crt0.S
	@mkdir -p obj
	$(CC) $(ARCH_FLAGS) -c $< -o $@

# ── engine/core objects ───────────────────────────────────────────────────────
obj/core/%.o: $(CORE_DIR)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

# ── platform objects ──────────────────────────────────────────────────────────
obj/plat/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

# ── link ──────────────────────────────────────────────────────────────────────
$(OUT): $(OBJ)
	$(CC) $(LDFLAGS_PRE) $^ $(LDFLAGS_POST) -o $@
	@echo "built $@ ($(shell arm-none-eabi-size $@ | tail -1 | awk '{print $$1+$$2}') bytes text+data)"

-include $(OBJ:.o=.d)

# ── run: boot under QEMU ─────────────────────────────────────────────────────
run: $(OUT)
	qemu-system-arm -M virt -cpu cortex-a7 -m 32M -nographic -kernel $(OUT)

# ── check: compare to golden ─────────────────────────────────────────────────
check: $(OUT)
	bash run-check.sh

clean:
	rm -rf obj $(OUT) out

.PHONY: all run check clean
