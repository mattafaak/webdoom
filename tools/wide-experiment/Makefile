# wide-experiment/Makefile — Hor+ widescreen ASan build (task 18.2b visual check).
# Builds nat-doom-wide with MAXSCREENWIDTH=854, SCREENWIDTH=854 and setblocks=11.
# Uses the same ASan/UBSan flags as native-sanitize/ but adds -DMAXSCREENWIDTH=854.
# Inherits all platform stubs from ../native-sanitize/ except i_video.c and i_main.c
# which are overridden here to add PPM frame-dump support.

CC      := gcc
NS      := ../native-sanitize

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
            -DMAXSCREENWIDTH=854 \
            -DSCREENWIDTH=854 \
            -I../../engine/core \
            -I$(NS)

LDFLAGS := -m32 -fsanitize=address,undefined \
           -fno-sanitize=alignment,bounds,pointer-overflow,object-size,signed-integer-overflow \
           -lm

CORE_DIR := ../../engine/core
OUT      := nat-doom-wide

CORE_EXCLUDE := $(CORE_DIR)/i_main.c \
                $(CORE_DIR)/i_net.c  \
                $(CORE_DIR)/i_sound.c \
                $(CORE_DIR)/i_system.c \
                $(CORE_DIR)/i_video.c \
                $(CORE_DIR)/d_net.c

CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard $(CORE_DIR)/*.c))

# Platform stubs: inherit most from native-sanitize, override i_video.c + i_main.c.
NS_PLAT := $(NS)/i_system.c $(NS)/i_sound.c $(NS)/d_net.c $(NS)/files.c $(NS)/perf.c
OWN_PLAT := i_main.c i_video.c

SRC := $(CORE_SRC) $(NS_PLAT) $(OWN_PLAT)

OBJ := $(patsubst $(CORE_DIR)/%.c,obj/core/%.o,$(filter $(CORE_DIR)/%,$(SRC))) \
       $(patsubst $(NS)/%.c,obj/ns/%.o,$(filter $(NS)/%,$(SRC))) \
       $(patsubst %.c,obj/own/%.o,$(OWN_PLAT))

all: $(OUT)

$(OUT): $(OBJ)
	$(CC) $(LDFLAGS) $^ -o $@
	@echo "built $@"

obj/core/%.o: $(CORE_DIR)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

obj/ns/%.o: $(NS)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

obj/own/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

-include $(OBJ:.o=.d)

clean:
	rm -rf obj $(OUT)

.PHONY: all clean
