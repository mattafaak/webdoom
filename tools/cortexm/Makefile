# tools/cortexm/Makefile — webdoom's core on qemu's Cortex-M boards.
#
#   make ISA=armv6m    -mcpu=cortex-m0plus code, run on mps2-an385 (an M3
#                      that executes ARMv6-M code unchanged: exact M0+
#                      instruction counts; unaligned accesses trap)
#   make ISA=armv8m    -mcpu=cortex-m33 code, run on mps2-an505
#   OPT=-O1|-O2        default -O1, the level fs-doom (the x86 reference) uses
#   EXTRA_CFLAGS=...   appended to every C compile (experiments; with B=DIR)
#   COUNT=1            also wrap every libgcc helper the objects call with a
#                      counter (helpers.S): exact calls per tic, at ~9 extra
#                      instructions a call, so a counting build is never timed
#
# Products, under build/<isa><opt>[-count]/:
#   cm-doom.elf  cm-doom.map  helpers.txt (the libgcc helpers the objects call)
#   cm-selftest.elf (the instrument's red-proof, selftest.c)
#
# Toolchain: the system arm-none-eabi-gcc with full newlib (not nano: nano is
# built for size, and its memcpy/memset would not be what a port ships).
# engine/core is compiled unmodified; the platform layer is
# tools/freestanding's, with four port hooks passed in as macros:
#   FS_ZONE_SIZE_OVERRIDE  the 4 MiB zone (alone in its own 4 MiB SRAM)
#   FS_PERF_COUNTER        web_perf_now() reads the board timer (perf.c)
#   FS_WAD_READ            lump copies come from semihosting (floor_wrap.c)
#   FS_GET_TIME            I_GetTime reads the board timer (i_system.c)
# Copyright (C) 2026, GPL-2.0-or-later.

ISA   ?= armv6m
OPT   ?= -O1
COUNT ?= 0

CC      := arm-none-eabi-gcc
NM      := arm-none-eabi-nm
SIZE    := arm-none-eabi-size

ifeq ($(ISA),armv6m)
CPU     := -mcpu=cortex-m0plus -mthumb -mfloat-abi=soft
BOARD   := -DBOARD_AN385 -DCM_ARMV6M
LDS     := an385.ld
TARGET  := armv6m-qemu
else ifeq ($(ISA),armv8m)
CPU     := -mcpu=cortex-m33 -mthumb -mfloat-abi=soft
BOARD   := -DBOARD_AN505 -DCM_ARMV8M
LDS     := an505.ld
TARGET  := armv8m-qemu
else
$(error ISA must be armv6m or armv8m, not '$(ISA)')
endif
ifeq ($(filter -O1 -O2,$(OPT)),)
$(error OPT must be -O1 or -O2, not '$(OPT)')
endif

SUFFIX := $(if $(filter 1,$(COUNT)),-count,)
B      := build/$(ISA)$(OPT)$(SUFFIX)
CORE   := ../../engine/core
FS     := ../freestanding

# the same language and warning set as tools/freestanding/Makefile, plus the
# ARM ABI's three landmines: char is unsigned (-fsigned-char), enums are short
# (-fno-short-enums: boolean would be one byte), and nothing here is linked
# against a hosted libc.
CFLAGS := $(CPU) $(OPT) -g -std=gnu89 -DNORMALUNIX -Dalloca=__builtin_alloca \
          -fno-strict-aliasing -fsigned-char -fno-short-enums \
          -ffunction-sections -fdata-sections \
          -D_POSIX_TIMERS=1 -D_POSIX_MONOTONIC_CLOCK=1 \
          '-DFS_ZONE_SIZE_OVERRIDE=(4*1024*1024)' \
          -DFS_PERF_COUNTER=cm_ticks -DFS_WAD_READ=cm_wad_read -DFS_GET_TIME=cm_get_time \
          $(BOARD) -DCM_TARGET='"$(TARGET)"' \
          -DCM_BUILD_DESC='"gcc$(shell $(CC) -dumpversion)$(OPT)-newlib$(SUFFIX)"' \
          $(if $(filter 1,$(COUNT)),-DCM_COUNT_HELPERS,) \
          -Wall -Wno-unused-variable -Wno-unused-but-set-variable \
          -Wno-dangling-else -Wno-parentheses -Wno-missing-braces \
          -Wno-unused-value -Wno-pointer-sign -Wno-implicit-function-declaration \
          -I$(CORE) -I$(FS) -I../floor -I. $(EXTRA_CFLAGS)

CORE_EXCLUDE := $(addprefix $(CORE)/,i_main.c i_net.c i_sound.c i_system.c i_video.c d_net.c)
CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE)/*.c))
FS_SRC   := i_system.c i_video.c i_sound.c d_net.c files.c perf.c floor_wrap.c
CM_SRC   := board.c fault.c semihost.c syscalls.c wad_semi.c cm_main.c

OBJ := $(B)/crt0.o \
       $(patsubst $(CORE)/%.c,$(B)/core/%.o,$(CORE_SRC)) \
       $(patsubst %.c,$(B)/fs/%.o,$(FS_SRC)) \
       $(B)/floor/floor_log.o \
       $(patsubst %.c,$(B)/cm/%.o,$(CM_SRC))
ST_OBJ := $(B)/crt0.o $(addprefix $(B)/cm/,board.o fault.o semihost.o syscalls.o selftest.o) \
          $(B)/loops.o

FLOOR_WRAP := -Wl,--wrap=P_SetupLevel,--wrap=WI_Start,--wrap=F_StartFinale,--wrap=memcpy
LDFLAGS := $(CPU) -nostartfiles -T $(LDS) -Wl,--gc-sections -Wl,--no-enum-size-warning
LIBS    := -Wl,--start-group -lc -lm -lgcc -Wl,--end-group

all: $(B)/cm-doom.elf $(B)/cm-selftest.elf

# Every object depends on the flags it was compiled with: make tracks files,
# not command lines, so without this a changed -D or OPT leaves stale objects
# that link cleanly and measure the old build.
FLAGS_NOW := $(CC) $(CPU) $(CFLAGS)
$(B)/flags.txt: FORCE
	@mkdir -p $(B)
	@echo '$(subst ','\'',$(FLAGS_NOW))' | cmp -s - $@ || echo '$(subst ','\'',$(FLAGS_NOW))' > $@
FORCE:

# The libgcc helpers the compiled objects call: their undefined symbols that
# this multilib's libgcc defines.  A counting build wraps exactly these, so a
# helper cannot be called without being counted.
LIBGCC := $(shell $(CC) $(CPU) -print-libgcc-file-name)
$(B)/helpers.txt: $(OBJ)
	@$(NM) -g --defined-only $(LIBGCC) 2>/dev/null | awk 'NF==3 && $$2 ~ /^[TW]$$/ {print $$3}' | sort -u > $@.libgcc
	@$(NM) -u $(OBJ) | awk 'NF==2 && $$1=="U" {print $$2}' | sort -u > $@.undef
	@comm -12 $@.libgcc $@.undef > $@
	@rm -f $@.libgcc $@.undef
	@echo "$(ISA)$(OPT): $$(wc -l < $@) libgcc helper(s) called: $$(tr '\n' ' ' < $@)"

ifeq ($(COUNT),1)
$(B)/helpers.S: $(B)/helpers.txt gen-helpers.sh
	@bash gen-helpers.sh $< > $@
$(B)/helpers.o: $(B)/helpers.S
	@$(CC) $(CPU) -c $< -o $@
HELPER_OBJ = $(B)/helpers.o
HELPER_WRAP = $(shell sed 's/^/-Wl,--wrap=/' $(B)/helpers.txt 2>/dev/null)
$(B)/cm-doom.elf: $(B)/helpers.o
endif

$(B)/cm-doom.elf: $(OBJ) $(LDS) sections.ld $(B)/helpers.txt
	@$(CC) $(LDFLAGS) $(FLOOR_WRAP) $(HELPER_WRAP) -Wl,-Map=$(B)/cm-doom.map \
	    $(OBJ) $(HELPER_OBJ) $(LIBS) -o $@
	@$(SIZE) $@ | tail -1 | awk '{printf "built %s: text %d data %d bss %d (B)\n", "$@", $$1, $$2, $$3}'

$(B)/cm-selftest.elf: $(ST_OBJ) $(LDS) sections.ld
	@$(CC) $(LDFLAGS) -Wl,-Map=$(B)/cm-selftest.map $(ST_OBJ) $(LIBS) -o $@

$(B)/crt0.o: crt0.S $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CPU) -c $< -o $@
$(B)/loops.o: loops.S $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CPU) -c $< -o $@
$(B)/core/%.o: $(CORE)/%.c $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) -MMD -MP -c $< -o $@
$(B)/fs/%.o: $(FS)/%.c $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) -MMD -MP -c $< -o $@
$(B)/floor/%.o: ../floor/%.c $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) -MMD -MP -c $< -o $@
$(B)/cm/%.o: %.c $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

-include $(OBJ:.o=.d) $(B)/cm/selftest.d

clean:
	rm -rf build

.PHONY: all clean FORCE
