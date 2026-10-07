# tools/freestanding/Makefile — freestanding rung-1 build of webdoom engine.
#
# Goal: engine/core + a minimal platform layer that assumes ONLY:
#   (a) a static memory arena  (I_ZoneBase returns a static byte[])
#   (b) a byte-out primitive   (fs_putc → write(1,...) in rung 1)
#   (c) a preloaded WAD blob   (main() loads once; files.c serves from it)
#
# NO sanitizers, NO SDL.  -m32 to match nat-doom's int/long widths (32-bit),
# ensuring per-tic hash arithmetic is identical and hashes compare apples-to-apples.
#
# Usage:
#   make               build fs-doom and synth-bench (the OPL synth, measured)
#   make check         run doom.wad demo3 vs golden (requires wads/lib/doom.wad)
#   make check-all     run all available WADs vs goldens
#   make imports       regenerate tools/freestanding/IMPORTS.md
#   make clean

CC      := gcc
# Optional extra compile-time defines for instrumented builds.
# Usage: make EXTRA_CFLAGS="-DWEB_PERF_DRAWSEG_STATS"  (drawseg peak)
#        make EXTRA_CFLAGS="-DWEB_PERF_OPENINGS_STATS" (openings peak)
EXTRA_CFLAGS ?=
# OPT, OBJDIR and OUT make side builds that never share objects with fs-doom:
#   make OPT=-O2 OBJDIR=obj-o2 OUT=fs-doom-o2
#   make OBJDIR=obj-fixed OUT=fs-doom-fixed EXTRA_CFLAGS="-include fixed_count.h"
OPT     ?= -O1
OBJDIR  ?= obj
CFLAGS  := -m32 $(OPT) -g \
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
            -I. \
            -I../floor \
            $(EXTRA_CFLAGS)

# LEAN=1: the floor's lean memory build.  Vanilla's renderer limits (128
# visplanes and vissprites; the 13 demos peak at 118 and 123), and the lookup
# tables as const data generated at build time (TABLES_CONST: in flash on a
# microcontroller, 65,540 B of RAM saved).
#   make LEAN=1 OBJDIR=obj-lean OUT=fs-doom-lean
ifeq ($(LEAN),1)
CFLAGS += -DMAXVISPLANES=128 -DMAXVISSPRITES=128 -DTABLES_CONST -I$(OBJDIR)/gen
endif

# The floor gate's tic flags (floor_wrap.c): a level load, intermission or
# finale starting, and the bytes a lump copy takes out of the WAD blob.
FLOOR_WRAP := -Wl,--wrap=P_SetupLevel,--wrap=WI_Start,--wrap=F_StartFinale,--wrap=memcpy
# -no-pie: the synth's objects are position-dependent (SYNTH_NOPIE, below)
LDFLAGS := -m32 -no-pie -lm $(FLOOR_WRAP)

CORE_DIR := ../../engine/core
OUT      ?= fs-doom

# engine/core sources: same excludes as native-sanitize (we provide our own).
CORE_EXCLUDE := $(CORE_DIR)/i_main.c \
                $(CORE_DIR)/i_net.c  \
                $(CORE_DIR)/i_sound.c \
                $(CORE_DIR)/i_system.c \
                $(CORE_DIR)/i_video.c \
                $(CORE_DIR)/d_net.c

CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE_DIR)/*.c))

# Freestanding platform files (this directory).
PLAT_SRC := i_main.c i_system.c i_video.c i_sound.c d_net.c files.c perf.c \
            fs_audio.c sfx_mix.c
# The audio (fs_audio.c): the web build's OPL synth, its sources unchanged
# (fs_mus.c includes engine/web/mus_opl.c; opl3.c is found through vpath), and
# the mixer.  The synth's clock is a double and must round as IEEE double does,
# as synth.wasm's does: SYNTH_FP, and stub/ for <emscripten.h> (synth-bench.c).
WEB_DIR     := ../../engine/web
SYNTH_INC   := -Istub -I$(WEB_DIR)
SYNTH_FP    := -msse2 -mfpmath=sse -ffp-contract=off
AUDIO_SRC   := fs_mus.c opl3.c
PLAT_SRC    += $(AUDIO_SRC)
vpath %.c . $(WEB_DIR)
# `make FLOOR_WRAP=` builds without the hooks (floor-x86 must then refuse)
ifneq ($(FLOOR_WRAP),)
PLAT_SRC += floor_wrap.c
endif

SRC := $(CORE_SRC) $(PLAT_SRC)
OBJ := $(patsubst $(CORE_DIR)/%.c,$(OBJDIR)/core/%.o,$(filter $(CORE_DIR)/%,$(SRC))) \
       $(patsubst %.c,$(OBJDIR)/plat/%.o,$(PLAT_SRC)) \
       $(OBJDIR)/floor/floor_log.o

all: $(OUT) synth-bench synth-exact

$(OUT): $(OBJ)
	$(CC) $(LDFLAGS) $^ -o $@
	@echo "built $@"

$(OBJDIR)/core/%.o: $(CORE_DIR)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

$(OBJDIR)/plat/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

# the synth and the code that converts its output: IEEE double, see above
AUDIO_OBJ := $(patsubst %.c,$(OBJDIR)/plat/%.o,$(AUDIO_SRC) fs_audio.c)
$(AUDIO_OBJ): CFLAGS += $(SYNTH_FP) $(SYNTH_INC)
$(AUDIO_OBJ): Makefile
# The synth itself (opl3.c, and mus_opl.c through fs_mus.c) is built
# position-dependent, as a bare-metal build is: gcc here defaults to PIE, and
# i386 PIC code reaches every table and global through __x86.get_pc_thunk
# (8.8% of the synth's profile in phase 1a).  -fno-pie takes the synth's
# instructions 10.0% lower: 254.01 -> 228.69 M per second of audio, OPL2 -O1
# (tools/floor/synth-savings.py, shipped-O1 against shipped-O1-nopie).  Only
# those two objects: fs_audio.c, sfx_mix.c and the game run in a WD_AUDIO=0
# tic too, and the game-only demand (tools/golden/floor-demand.json) must not
# move.  On the other targets the flag is moot: wasm has no PIC unless asked,
# and zig cc -static and arm-none-eabi-gcc emit position-dependent code by
# default.
SYNTH_NOPIE := -fno-pie
$(patsubst %.c,$(OBJDIR)/plat/%.o,$(AUDIO_SRC)): CFLAGS += $(SYNTH_NOPIE)

# the const tables (LEAN=1): the engine's own generator, run on the host,
# checksum included; tables.o includes the result
$(OBJDIR)/gen/tables_const.inc: ../floor/gen-const-tables.c $(CORE_DIR)/tables.c $(CORE_DIR)/tables_fix.h
	@mkdir -p $(dir $@)
	$(CC) -m32 -O1 -std=gnu89 -I$(CORE_DIR) ../floor/gen-const-tables.c $(CORE_DIR)/tables.c -lm -o $(OBJDIR)/gen/gen-const-tables
	$(OBJDIR)/gen/gen-const-tables > $@.tmp && mv $@.tmp $@
ifeq ($(LEAN),1)
$(OBJDIR)/core/tables.o: $(OBJDIR)/gen/tables_const.inc
endif

$(OBJDIR)/floor/%.o: ../floor/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

-include $(OBJ:.o=.d)

# ── synth-bench: the OPL music synth alone, native, measured ─────────────────
# engine/web/mus_opl.c (through fs_mus.c), opl3.c and synth_main.c, unchanged,
# at fs-doom's flags (-m32 -O1) and again at -O2, both with IEEE double
# arithmetic (SYNTH_FP: the sequencer's clock is a double, and x87's 64-bit
# mantissas move an event by a frame against synth.wasm; synth-bench.c says
# where).  synth-bench-x87 is the -O1 build at gcc's default x87 code, kept for
# that evidence.  stub/ supplies an empty EMSCRIPTEN_KEEPALIVE; --wrap taps the
# register stream; -no-pie keeps the profile's sampled addresses the binary's
# own; -fno-pie is fs-doom's SYNTH_NOPIE (above), for all of synth-bench.
# See synth-bench.c.
SYNTH_SRC   := fs_mus.c $(WEB_DIR)/opl3.c $(WEB_DIR)/synth_main.c synth-bench.c
SYNTH_LD    := -m32 -no-pie -Wl,--wrap=OPL3_WriteRegBuffered -lm
SYNTH_OBJ_1 := $(addprefix obj/synth-O1/,$(notdir $(SYNTH_SRC:.c=.o)))
SYNTH_OBJ_2 := $(addprefix obj/synth-O2/,$(notdir $(SYNTH_SRC:.c=.o)))
SYNTH_OBJ_X := $(addprefix obj/synth-x87/,$(notdir $(SYNTH_SRC:.c=.o)))

synth-bench: synth-bench-O1 synth-bench-O2 synth-bench-x87

synth-bench-O1: $(SYNTH_OBJ_1)
	$(CC) $^ $(SYNTH_LD) -o $@
	@echo "built $@"

synth-bench-O2: $(SYNTH_OBJ_2)
	$(CC) $^ $(SYNTH_LD) -o $@
	@echo "built $@"

synth-bench-x87: $(SYNTH_OBJ_X)
	$(CC) $^ $(SYNTH_LD) -o $@
	@echo "built $@"

obj/synth-O1/%.o: %.c Makefile
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(SYNTH_NOPIE) $(SYNTH_FP) $(SYNTH_INC) -MMD -MP -c $< -o $@

obj/synth-O2/%.o: %.c Makefile
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -O2 $(SYNTH_NOPIE) $(SYNTH_FP) $(SYNTH_INC) -MMD -MP -c $< -o $@

obj/synth-x87/%.o: %.c Makefile
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(SYNTH_NOPIE) $(SYNTH_INC) -MMD -MP -c $< -o $@

-include $(SYNTH_OBJ_1:.o=.d) $(SYNTH_OBJ_2:.o=.d) $(SYNTH_OBJ_X:.o=.d)

# ── synth-exact: the synth against its reference, frame by frame ─────────────
# engine/web/opl3.c beside the reference core (opl3-ref-wrap.c includes
# tools/floor/opl3-ref/opl3.c, Nuked 1.8 before the floor's exact savings,
# with its public functions renamed), mus_opl.c and synth_main.c driving them
# through the shipped chip's five entry points, which --wrap mirrors onto the
# reference.  tools/synth-exact-test.mjs runs it.  SYNTH_EXACT_OPL3,
# SYNTH_EXACT_OBJ and SYNTH_EXACT_OUT build it from another opl3.c (the test's
# red-proof variants), in objects of its own.
SYNTH_EXACT_OPL3 ?= $(WEB_DIR)/opl3.c
SYNTH_EXACT_OBJ  ?= obj/synth-exact
SYNTH_EXACT_OUT  ?= synth-exact
SYNTH_EXACT_WRAP := --wrap=OPL3_Reset,--wrap=OPL3_WriteReg,--wrap=OPL3_WriteRegBuffered,--wrap=OPL3_Generate,--wrap=OPL3_GenerateResampled
SYNTH_EXACT_OBJS := $(addprefix $(SYNTH_EXACT_OBJ)/,fs_mus.o opl3.o synth_main.o synth-exact.o opl3-ref-wrap.o)

$(SYNTH_EXACT_OUT): $(SYNTH_EXACT_OBJS)
	$(CC) $^ -m32 -no-pie -Wl,$(SYNTH_EXACT_WRAP) -lm -o $@
	@echo "built $@"

$(SYNTH_EXACT_OBJ)/opl3.o: $(SYNTH_EXACT_OPL3) Makefile
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -O2 $(SYNTH_NOPIE) $(SYNTH_FP) $(SYNTH_INC) -MMD -MP -c $< -o $@

$(SYNTH_EXACT_OBJ)/%.o: %.c Makefile
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -O2 $(SYNTH_NOPIE) $(SYNTH_FP) $(SYNTH_INC) -MMD -MP -c $< -o $@

-include $(SYNTH_EXACT_OBJS:.o=.d)

# ── golden comparison ─────────────────────────────────────────────────────────
WAD_DIR := ../../wads/lib
GOLDEN  := ../../tools/golden
OUT_DIR := out

# check: run doom.wad demo3 (the standard regression demo) and compare vs golden.
# Captures stdout (the fs_putc byte-out JSON stream) into out/doom-demo3.json.
check: $(OUT)
	@mkdir -p $(OUT_DIR)
	@printf "running doom-demo3 ... "
	@$(OUT_DIR)/../fs-doom $(WAD_DIR)/doom.wad -timedemo demo3 \
	    -sim $(OUT_DIR)/doom-demo3.json \
	    > /dev/null 2>$(OUT_DIR)/doom-demo3.log || \
	    (cat $(OUT_DIR)/doom-demo3.log; exit 1)
	@cat $(OUT_DIR)/doom-demo3.log
	@python3 ../native-sanitize/compare.py $(GOLDEN) $(OUT_DIR) sim

# check-all: run all available WADs and compare vs goldens.
check-all: $(OUT) synth-bench
	@mkdir -p $(OUT_DIR)
	@bash run-check.sh $(WAD_DIR) $(OUT_DIR)
	@python3 ../native-sanitize/compare.py $(GOLDEN) $(OUT_DIR) sim

# imports: regenerate IMPORTS.md from the built binary.
imports: $(OUT)
	@bash gen-imports.sh

clean:
	rm -rf obj obj-* fs-doom fs-doom-o2 fs-doom-fixed $(OUT_DIR) synth-bench-O1 synth-bench-O2 synth-bench-x87 synth-exact

# ro-wad-check: read-only-WAD proof (XIP feasibility).
# Runs all 13 demos with WD_RO_WAD=1: WAD blob mprotect(PROT_READ) after load.
# Any engine write into the blob → SIGSEGV → FAIL with faulting address.
# 13/13 pass → WAD blob is read-only → XIP-viable.
ro-wad-check: $(OUT)
	@bash ro-wad-check.sh

# check-stack-1m: prove 1 MiB process stack is sufficient for all 13 demos.
# Enforces ulimit -s 1024 (1 MiB) in the SAME shell as run-check.sh so every child
# process (fs-doom + python3 comparator) inherits the limit.
# Measured peak (demo3): fs-doom alone ≈14 KiB; python3 comparator ≈128 KiB.
# 1 MiB provides ≥8× margin over the Python floor, ≥70× over the engine peak.
# Gate: all 13 demos must pass; any SIGSEGV (exit 139) = stack overflow = FAIL.
STACK_LIMIT_KB ?= 1024
check-stack-1m: $(OUT)
	@echo "stack gate: ulimit -s $(STACK_LIMIT_KB) KiB active"
	@bash -c 'ulimit -s $(STACK_LIMIT_KB) && echo "ulimit -s active = $$(ulimit -s) KiB" && bash run-check.sh $(WAD_DIR) $(OUT_DIR)'

.PHONY: all check check-all imports clean ro-wad-check check-stack-1m synth-bench
