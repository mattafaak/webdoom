# webdoom engine — linuxdoom-1.10 core + web platform layer, via emcc.
# `source tools/emsdk-env.sh` first.

BUILD    := ../build
OUT      ?= $(BUILD)/doom.js

# Core game code minus the five platform files we replace (i_*.c, d_net.c).
CORE_EXCLUDE := core/i_main.c core/i_net.c core/i_sound.c core/i_system.c \
                core/i_video.c core/d_net.c
CORE_SRC := $(filter-out $(CORE_EXCLUDE),$(wildcard core/*.c))
WEB_SRC  := $(wildcard web/*.c)
SRC      := $(CORE_SRC) $(WEB_SRC)

# Optional extra compile-time defines for instrumented builds.
# Usage: make EXTRA_CFLAGS="-DWEB_PERF_COL_STATS -DWEB_PERF_PLANE_STATS ..."
#        make EXTRA_CFLAGS="..." BUILD=../build-perf OUT=../build-perf/doom.js
# The unflagged default build is byte-unaffected by these declarations.
EXTRA_CFLAGS ?=

CFLAGS := -O3 -flto -Dalloca=__builtin_alloca -std=gnu89 -DNORMALUNIX -Icore -Iweb \
          -fno-strict-aliasing -Wall -Wno-unused-variable \
          -Wno-unused-but-set-variable -Wno-dangling-else \
          -Wno-parentheses -Wno-missing-braces -Wno-unused-value

# EXPORTED_FUNCTIONS lists ONLY what EMSCRIPTEN_KEEPALIVE cannot provide.
#
# It used to name 64 symbols against 72 KEEPALIVE exports -- a second,
# incomplete copy of the export list, four of whose omissions are on the live
# drop-in path and worked anyway.  Measured before deleting it (round 6): built
# with the full list and with `_main,_malloc,_free`, same tree, same toolchain:
#
#   build/doom.wasm  b16407701c676f52976344f339790556  (both)
#   build/doom.js    592ee0bae80c3ec2e071b86ce534db82  (both)
#
# Byte-identical, so the 61 KEEPALIVE names in it were inert.  _main is the
# entry point and _malloc/_free are emscripten runtime functions with no
# KEEPALIVE of their own -- drop those three and the client loses ccall's
# allocation path.  A symbol needed from JS gets EMSCRIPTEN_KEEPALIVE at its
# definition; it does not get a second mention here.
LDFLAGS := -flto -sMALLOC=emmalloc -sASSERTIONS=0 --closure 1 -sINITIAL_MEMORY=32MB -sSTACK_SIZE=1MB \
           -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDoom \
           -sINVOKE_RUN=0 \
           -sFILESYSTEM=0 -sEXPORTED_RUNTIME_METHODS=callMain,ccall,HEAPU8,HEAP32,HEAPF32 \
           -sEXPORTED_FUNCTIONS=_main,_malloc,_free \
           -sENVIRONMENT=web,worker,node \
           -sALLOW_MEMORY_GROWTH=0

OBJ := $(patsubst %.c,$(BUILD)/obj/%.o,$(SRC))

all: $(OUT)

$(BUILD)/obj/%.o: %.c
	@mkdir -p $(dir $@)
	emcc $(CFLAGS) $(EXTRA_CFLAGS) -MMD -MP -c $< -o $@

-include $(OBJ:.o=.d)

$(OUT): $(OBJ) Makefile
	emcc $(CFLAGS) $(EXTRA_CFLAGS) $(LDFLAGS) $(OBJ) -o $(OUT)
	@ls -la $(BUILD)/doom.js $(BUILD)/doom.wasm

clean:
	rm -rf $(BUILD)

.PHONY: all clean
