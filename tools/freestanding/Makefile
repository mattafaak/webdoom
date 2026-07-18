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
#   make               build fs-doom
#   make check         run doom.wad demo3 vs golden (requires wads/lib/doom.wad)
#   make check-all     run all available WADs vs goldens
#   make imports       regenerate tools/freestanding/IMPORTS.md
#   make clean

CC      := gcc
CFLAGS  := -m32 -O1 -g \
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

LDFLAGS := -m32 -lm

CORE_DIR := ../../engine/core
OUT      := fs-doom

# engine/core sources: same excludes as native-sanitize (we provide our own).
CORE_EXCLUDE := $(CORE_DIR)/i_main.c \
                $(CORE_DIR)/i_net.c  \
                $(CORE_DIR)/i_sound.c \
                $(CORE_DIR)/i_system.c \
                $(CORE_DIR)/i_video.c \
                $(CORE_DIR)/d_net.c

CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE_DIR)/*.c))

# Freestanding platform files (this directory).
PLAT_SRC := i_main.c i_system.c i_video.c i_sound.c d_net.c files.c perf.c

SRC := $(CORE_SRC) $(PLAT_SRC)
OBJ := $(patsubst $(CORE_DIR)/%.c,obj/core/%.o,$(filter $(CORE_DIR)/%,$(SRC))) \
       $(patsubst %.c,obj/plat/%.o,$(PLAT_SRC))

all: $(OUT)

$(OUT): $(OBJ)
	$(CC) $(LDFLAGS) $^ -o $@
	@echo "built $@"

obj/core/%.o: $(CORE_DIR)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

obj/plat/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

-include $(OBJ:.o=.d)

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
check-all: $(OUT)
	@mkdir -p $(OUT_DIR)
	@bash run-check.sh $(WAD_DIR) $(OUT_DIR)
	@python3 ../native-sanitize/compare.py $(GOLDEN) $(OUT_DIR) sim

# imports: regenerate IMPORTS.md from the built binary.
imports: $(OUT)
	@bash gen-imports.sh

clean:
	rm -rf obj $(OUT) $(OUT_DIR)

# cycles: the same binary as 'all'; instruction counting is activated at
# runtime by setting WD_CYCLES=1 and passing -cycles <out.json>.
# cycle-floor.sh runs all 13 golden demos through the counting build and emits
# tools/golden/cycle-floor.json with per-demo instruction stats.
cycles: $(OUT)
	@echo "Built $(OUT) — run with WD_CYCLES=1 -cycles <out.json> to measure."

cycle-floor: $(OUT)
	@bash cycle-floor.sh

# cycle-attrib: per-subsystem instruction attribution (13.1b).
# Runs all 13 demos twice with -attrib and emits tools/golden/cycle-attribution.json.
cycle-attrib: $(OUT)
	@bash cycle-attrib.sh

.PHONY: all check check-all imports clean cycles cycle-floor cycle-attrib
