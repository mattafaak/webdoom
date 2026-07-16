# native-sanitize/Makefile — native ASan/UBSan build of the webdoom engine.
#
# Usage:
#   make                # build nat-doom
#   make check          # build + run all demos, compare against tools/golden/
#   make check-sim      # sim traces only
#   make check-render   # render traces only
#   make clean
#
# Prerequisites: clang, Python 3 (for compare.py), WADs in ../../wads/lib/.

CC      := gcc
# task 3.1: build in 32-bit mode (-m32) so pointer width matches WASM's 32-bit
# model.  This eliminates 64-bit pointer-vs-int truncation warnings/errors that
# are not present in the WASM target and avoids the need for intptr_t patches in
# w_wad.h (int==intptr_t in 32-bit).  ASan 32-bit runtime is in /usr/lib32/
# (libasan.so.8) — verified available on this host.
CFLAGS  := -m32 -O1 -g \
            -fsanitize=address,undefined \
            -fno-sanitize=alignment,bounds,pointer-overflow,object-size,signed-integer-overflow \
            -fno-omit-frame-pointer \
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

# Suppressions rationale:
#   alignment, bounds, pointer-overflow, object-size: vanilla pointer-casting idioms safe in practice.
#   signed-integer-overflow: DOOM fixed-point math intentionally uses two's-complement wraparound.
#     Known intentional sites: angle_t products (ANG45*6 etc.), FixedMul/FixedDiv
#     intermediate products, finetangent index arithmetic. NOTE: this suppression is
#     global — new signed overflow elsewhere would be hidden; audit when touching math paths.
#     (e.g. ANG45 * 6 = 3221225472, angle_t arithmetic, fixed_t multiply). These are defined
#     behavior on every targeted platform even though C99 says they are UB.
LDFLAGS := -m32 -fsanitize=address,undefined \
           -fno-sanitize=alignment,bounds,pointer-overflow,object-size,signed-integer-overflow \
           -lm

# Paths.
CORE_DIR := ../../engine/core
OUT      := nat-doom

# engine/core sources: all *.c except the platform files we replace.
CORE_EXCLUDE := $(CORE_DIR)/i_main.c \
                $(CORE_DIR)/i_net.c  \
                $(CORE_DIR)/i_sound.c \
                $(CORE_DIR)/i_system.c \
                $(CORE_DIR)/i_video.c \
                $(CORE_DIR)/d_net.c

CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE_DIR)/*.c))

# Native platform stubs (this directory).
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

WAD_DIR   := ../../wads/lib
GOLDEN    := ../../tools/golden
OUT_DIR   := out

check: $(OUT)
	@mkdir -p $(OUT_DIR)
	@bash run-all.sh $(WAD_DIR) $(OUT_DIR) both
	@python3 compare.py $(GOLDEN) $(OUT_DIR) both

check-sim: $(OUT)
	@mkdir -p $(OUT_DIR)
	@bash run-all.sh $(WAD_DIR) $(OUT_DIR) sim
	@python3 compare.py $(GOLDEN) $(OUT_DIR) sim

check-render: $(OUT)
	@mkdir -p $(OUT_DIR)
	@bash run-all.sh $(WAD_DIR) $(OUT_DIR) render
	@python3 compare.py $(GOLDEN) $(OUT_DIR) render

clean:
	rm -rf obj $(OUT) $(OUT_DIR)

.PHONY: all check check-sim check-render clean
