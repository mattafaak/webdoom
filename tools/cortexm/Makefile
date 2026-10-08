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
#   ZC=1               the zero-copy build: lumps are read in place
#                      (WEB_LUMPS_IN_PLACE, engine/core/w_wad.h) out of a WAD
#                      put in PSRAM at boot (wad_semi.c's cm_wad_load), with
#                      the screens, per-tic arrays and heap moved to CODE
#                      (an385-zc.ld, an505-zc.ld)
#   ZONE_KB=N          the zone arena, KiB: 4096 by default, 2048 with ZC=1,
#                      which leaves the rest of the ZONE SSRAM to .wadtail
#                      (the part of a WAD longer than 16 MiB)
#   DRAWERS=1          the port's R_DrawColumn and R_DrawSpan (drawers_v6m.S,
#                      drawers_v8m.S) in place of r_draw.c's, through
#                      --wrap: engine/core is compiled unmodified, and every
#                      case they do not take goes to the engine's own
#   FIXED=1            the port's FixedMul and FixedDiv (cm_fixed.h, through
#                      m_fixed.h's WEB_FIXED_PORT; on ARMv6-M MULS pieces and
#                      fixed_v6m.S's divide instead of libgcc's 64-bit helpers,
#                      on ARMv8-M SMULL as m_fixed.h has it and fixed_v8m.S's
#                      UDIV-based divide instead of libgcc's 64-bit divide)
#   FAST=1             both
#   LEAN=1             the lean memory build, tools/freestanding's LEAN=1:
#                      vanilla's renderer limits, the lookup tables, texture
#                      tables and composites as const data (TABLES_CONST,
#                      TEXTURES_CONST, COMPOSITES_CONST: generated on the host
#                      by the engine's own recipes, tools/freestanding's
#                      rules, and checked at boot), LEAN_SCREENS
#   LEAN_LEVELS=1      with LEAN=1: the level read in place and narrowed
#                      (engine/core/r_defs.h); LEAN=1 ZC=1 LEAN_LEVELS=1 is
#                      the full diet (tools/floor/ram-floor.mjs measures it)
#   TEXTURES_WADS=W    with LEAN=1, required: the one IWAD whose texture
#                      tables and composites are built in (the four IWADs'
#                      come to 6.2 MB, past the boards' 4 MiB CODE; a port
#                      ships its one WAD's), e.g. TEXTURES_WADS=tnt.wad.  A
#                      LEAN build also cuts fs_audio.c's harness buffers to
#                      one entry (FS_AUDIO_HARNESS=0, 933,888 B of .bss)
#
# Products, under build/<isa><opt>[-count][-lean-<wad>][-lv][-zc][-dr|-fx|-fast]/
# (run-floor.sh passes B):
#   cm-doom.elf  cm-doom.map  helpers.txt (the libgcc helpers the objects call)
#   cm-selftest.elf (the instrument's red-proof, selftest.c)
#   cm-fasttest.elf (with DRAWERS or FIXED: the port's drawers and fixed-point
#   against the engine's on random and boundary inputs, fasttest.c)
#
# Toolchain: the system arm-none-eabi-gcc with full newlib (not nano: nano is
# built for size, and its memcpy/memset would not be what a port ships).
# engine/core is compiled unmodified; the platform layer is
# tools/freestanding's, with four port hooks passed in as macros:
#   FS_ZONE_SIZE_OVERRIDE  the zone arena, ZONE_KB (in its own 4 MiB SRAM)
#   FS_PERF_COUNTER        web_perf_now() reads the board timer (perf.c)
#   FS_WAD_READ            lump copies come from semihosting (floor_wrap.c);
#                          not in a ZC=1 build, which copies no lump
#   FS_GET_TIME            I_GetTime reads the board timer (i_system.c)
# Copyright (C) 2026, GPL-2.0-or-later.

ISA   ?= armv6m
OPT   ?= -O1
COUNT ?= 0
ZC    ?= 0
ifeq ($(ZC),1)
ZONE_KB ?= 2048
else
ZONE_KB ?= 4096
endif

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

ifeq ($(filter 0 1,$(ZC)),)
$(error ZC must be 0 or 1, not '$(ZC)')
endif
FAST    ?= 0
ifeq ($(FAST),1)
DRAWERS := 1
FIXED   := 1
endif
DRAWERS ?= 0
FIXED   ?= 0
ifeq ($(filter 0 1,$(DRAWERS))$(filter 0 1,$(FIXED)),)
$(error DRAWERS and FIXED must be 0 or 1)
endif
ISA_S := $(if $(filter armv6m,$(ISA)),v6m,v8m)
PORT_OBJ :=
PORT_WRAP :=
ifeq ($(DRAWERS),1)
PORT_OBJ  += drawers_$(ISA_S).o
PORT_WRAP += -Wl,--wrap=R_DrawColumn,--wrap=R_DrawSpan
endif
ifeq ($(FIXED),1)
PORT_CFLAGS := '-DWEB_FIXED_PORT="cm_fixed.h"'
PORT_OBJ += fixed_$(ISA_S).o
else
PORT_CFLAGS :=
endif
PORT_SUF := $(if $(filter 11,$(DRAWERS)$(FIXED)),-fast,$(if $(filter 1,$(DRAWERS)),-dr,$(if $(filter 1,$(FIXED)),-fx,)))
ifeq ($(ZC),1)
LDS    := $(LDS:.ld=-zc.ld)
ZC_FLAGS := -DWEB_LUMPS_IN_PLACE -DCM_ZERO_COPY
WAD_READ :=
# the heap holds lumpinfo, lumpcache and a long WAD's directory copy: the
# stats file's heap_peak says how much of this it used
ZC_LD  := -Wl,--defsym=CM_HEAP_SIZE=524288
else
ZC_FLAGS :=
WAD_READ := -DFS_WAD_READ=cm_wad_read
ZC_LD  :=
endif

LEAN ?= 0
LEAN_LEVELS ?= 0
ifeq ($(filter 0 1,$(LEAN))$(filter 0 1,$(LEAN_LEVELS)),)
$(error LEAN and LEAN_LEVELS must be 0 or 1)
endif
ifeq ($(LEAN_LEVELS)$(LEAN),10)
$(error LEAN_LEVELS=1 needs LEAN=1)
endif
TEXTURES_WADS ?=
ifeq ($(LEAN),1)
ifneq ($(words $(TEXTURES_WADS)),1)
$(error LEAN=1 needs TEXTURES_WADS=<one IWAD>: the four IWADs' const texture tables do not fit the boards' 4 MiB CODE)
endif
endif
SUFFIX := $(if $(filter 1,$(COUNT)),-count,)$(if $(filter 1,$(LEAN)),-lean-$(basename $(TEXTURES_WADS)),)$(if $(filter 1,$(LEAN_LEVELS)),-lv,)$(if $(filter 1,$(ZC)),-zc,)$(PORT_SUF)
B      := build/$(ISA)$(OPT)$(SUFFIX)
ifeq ($(LEAN),1)
LEAN_FLAGS := -DMAXVISPLANES=128 -DMAXVISSPRITES=128 -DTABLES_CONST \
              -DTEXTURES_CONST -DCOMPOSITES_CONST -DLEAN_SCREENS \
              $(if $(filter 1,$(LEAN_LEVELS)),-DLEAN_LEVELS,) -DFS_AUDIO_HARNESS=0 \
              -I$(B)/gen
endif
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
          '-DFS_ZONE_SIZE_OVERRIDE=($(ZONE_KB)*1024)' $(ZC_FLAGS) \
          -DFS_PERF_COUNTER=cm_ticks $(WAD_READ) -DFS_GET_TIME=cm_get_time \
          $(BOARD) -DCM_TARGET='"$(TARGET)"' \
          -DCM_BUILD_DESC='"gcc$(shell $(CC) -dumpversion)$(OPT)-newlib$(SUFFIX)"' \
          $(if $(filter 1,$(COUNT)),-DCM_COUNT_HELPERS,) \
          -Wall -Wno-unused-variable -Wno-unused-but-set-variable \
          -Wno-dangling-else -Wno-parentheses -Wno-missing-braces \
          -Wno-unused-value -Wno-pointer-sign -Wno-implicit-function-declaration \
          -DFS_AUDIO_DEFAULT=0 $(PORT_CFLAGS) $(LEAN_FLAGS) \
          -I$(CORE) -I$(FS) -I../floor -I. $(EXTRA_CFLAGS)

# The audio (tools/freestanding/fs_audio.c): built, and off unless WD_AUDIO
# says otherwise (there is no environment here, so off).  Under qemu the OPL
# synth costs more than the game, so the 13-demo legs run without it.  Its
# sources need the web layer's headers and an empty <emscripten.h>, and no
# fused multiply-add (the synth's reference is IEEE double, as in synth.wasm).
WEB := ../../engine/web
AUDIO_CFLAGS := -ffp-contract=off -I$(FS)/stub -I$(WEB)

CORE_EXCLUDE := $(addprefix $(CORE)/,i_main.c i_net.c i_sound.c i_system.c i_video.c d_net.c)
CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE)/*.c))
FS_SRC   := i_system.c i_video.c i_sound.c d_net.c files.c perf.c floor_wrap.c \
            fs_audio.c sfx_mix.c fs_mus.c
CM_SRC   := board.c fault.c semihost.c syscalls.c wad_semi.c cm_main.c

OBJ := $(B)/crt0.o \
       $(patsubst $(CORE)/%.c,$(B)/core/%.o,$(CORE_SRC)) \
       $(patsubst %.c,$(B)/fs/%.o,$(FS_SRC)) \
       $(B)/floor/floor_log.o $(B)/web/opl3.o \
       $(patsubst %.c,$(B)/cm/%.o,$(CM_SRC)) \
       $(addprefix $(B)/cm/,$(PORT_OBJ))
ST_OBJ := $(B)/crt0.o $(addprefix $(B)/cm/,board.o fault.o semihost.o syscalls.o selftest.o) \
          $(B)/loops.o

FLOOR_WRAP := -Wl,--wrap=P_SetupLevel,--wrap=WI_Start,--wrap=F_StartFinale,--wrap=memcpy
LDFLAGS := $(CPU) -nostartfiles -T $(LDS) -Wl,--gc-sections -Wl,--no-enum-size-warning $(ZC_LD)
LIBS    := -Wl,--start-group -lc -lm -lgcc -Wl,--end-group

FT_OBJ := $(B)/crt0.o $(addprefix $(B)/cm/,board.o fault.o semihost.o syscalls.o fasttest.o fasttest_ref.o) \
          $(B)/core/r_draw.o $(addprefix $(B)/cm/,$(PORT_OBJ))
# the test calls the port's drawers by their own names and stands between them
# and the engine's (__real_*), counting the cases the port hands back
FT_LD := -Wl,--defsym=__real_R_DrawColumn=ft_real_column,--defsym=__real_R_DrawSpan=ft_real_span

all: $(B)/cm-doom.elf $(B)/cm-selftest.elf $(if $(PORT_OBJ)$(PORT_CFLAGS),$(B)/cm-fasttest.elf,)

# Every object depends on the flags it was compiled with: make tracks files,
# not command lines, so without this a changed -D or OPT leaves stale objects
# that link cleanly and measure the old build.
FLAGS_NOW := $(CC) $(CPU) $(CFLAGS) $(LDS) $(ZC_LD) $(PORT_OBJ) $(PORT_WRAP)
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

$(B)/cm-doom.elf: $(OBJ) $(LDS) sections.ld $(B)/helpers.txt $(B)/flags.txt
	@$(CC) $(LDFLAGS) $(FLOOR_WRAP) $(HELPER_WRAP) $(PORT_WRAP) -Wl,-Map=$(B)/cm-doom.map \
	    $(OBJ) $(HELPER_OBJ) $(LIBS) -o $@
	@$(SIZE) $@ | tail -1 | awk '{printf "built %s: text %d data %d bss %d (B)\n", "$@", $$1, $$2, $$3}'

$(B)/cm-selftest.elf: $(ST_OBJ) $(LDS) sections.ld $(B)/flags.txt
	@$(CC) $(LDFLAGS) -Wl,-Map=$(B)/cm-selftest.map $(ST_OBJ) $(LIBS) -o $@

$(B)/cm-fasttest.elf: $(FT_OBJ) $(LDS) sections.ld $(B)/flags.txt
	@$(CC) $(LDFLAGS) $(FT_LD) -Wl,-Map=$(B)/cm-fasttest.map $(FT_OBJ) $(LIBS) -o $@
$(B)/cm/fasttest.o: CFLAGS += -DCM_FT_DRAWERS=$(DRAWERS)
# fasttest_ref.c compiles m_fixed.h's own FixedMul and FixedDiv: the reference
$(B)/cm/fasttest_ref.o: fasttest_ref.c $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(filter-out $(PORT_CFLAGS),$(CFLAGS)) -MMD -MP -c $< -o $@
$(B)/cm/%.o: %.S $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CPU) $(EXTRA_CFLAGS) -c $< -o $@

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
AUDIO_OBJ := $(addprefix $(B)/fs/,fs_audio.o fs_mus.o) $(B)/web/opl3.o
$(AUDIO_OBJ): CFLAGS += $(AUDIO_CFLAGS)
$(B)/web/%.o: $(WEB)/%.c $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) -MMD -MP -c $< -o $@
$(B)/cm/%.o: %.c $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

# the const tables (LEAN=1): tools/freestanding's rules.  The lookup tables'
# generator runs on the host (its tables are integers, the same on every host:
# the boot-time checksum in tables.c holds the target to them again).  The
# texture tables and composites are the engine's own R_InitData output as C
# initializers (tools/floor/gen-texture-tables.c), made by an x86 build of the
# same LEAN, ZC and LEAN_LEVELS in an object directory under this one, and
# checked against the WAD at boot as on the host.
$(B)/gen/tables_const.inc: ../floor/gen-const-tables.c $(CORE)/tables.c $(CORE)/tables_fix.h
	@mkdir -p $(dir $@)
	@gcc -m32 -O1 -std=gnu89 -I$(CORE) ../floor/gen-const-tables.c $(CORE)/tables.c -lm -o $(B)/gen/gen-const-tables
	@$(B)/gen/gen-const-tables > $@.tmp && mv $@.tmp $@
X86_GEN := $(abspath $(B))/x86gen
$(B)/gen/textures_const.inc: $(CORE)/r_data.c ../floor/gen-texture-tables.c $(B)/flags.txt
	@mkdir -p $(dir $@)
	@$(MAKE) -s -C $(FS) LEAN=1 ZERO_COPY=$(ZC) LEAN_LEVELS=$(LEAN_LEVELS) TEXTURES_WADS=$(TEXTURES_WADS) \
	    OBJDIR=$(X86_GEN) $(X86_GEN)/gen/textures_const.inc > $(B)/gen/texgen.log 2>&1 || { tail -5 $(B)/gen/texgen.log; exit 1; }
	@cp $(X86_GEN)/gen/textures_const.inc $@
ifeq ($(LEAN),1)
$(B)/core/tables.o: $(B)/gen/tables_const.inc
$(B)/core/r_data.o: $(B)/gen/textures_const.inc
endif

-include $(OBJ:.o=.d) $(B)/cm/selftest.d $(B)/cm/fasttest.d $(B)/cm/fasttest_ref.d

clean:
	rm -rf build

.PHONY: all clean FORCE
