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

LDFLAGS := -flto -sMALLOC=emmalloc -sASSERTIONS=0 --closure 1 -sINITIAL_MEMORY=32MB -sSTACK_SIZE=4MB \
           -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDoom \
           -sINVOKE_RUN=0 \
           -sFILESYSTEM=0 -sEXPORTED_RUNTIME_METHODS=callMain,ccall,HEAPU8,HEAP32,HEAPF32 \
           -sEXPORTED_FUNCTIONS=_main,_web_frame,_web_input_event,_web_framebuffer,_web_palette,_web_palette_version,_web_net_setup,_web_net_set_delay,_web_net_bundle,_web_net_scratch,_web_music_render,_web_music_init,_web_music_debug,_web_gamepad,_web_set_smooth,_web_set_pitch,_web_set_player_name,_web_save_defaults,_web_ui_mode,_web_weapon_state,_malloc,_free,_web_perf_sim,_web_perf_frame,_web_perf_bsp,_web_perf_planes,_web_perf_masked,_web_perf_frames,_web_perf_reset,_web_wipe_skip,_web_zone_sample,_web_zone_hwm,_web_zone_size,_web_zone_hwm_reset,_web_heap_base,_web_perf_col_calls_get,_web_perf_span_calls_get,_web_perf_col_pixels_get,_web_perf_span_pixels_get,_web_perf_findplane_calls_get,_web_perf_findplane_iters_get,_web_perf_visplane_peak_get,_web_perf_teleport_calls_get,_web_perf_spechit_peak_get,_web_set_detail,_web_menu_active,_web_set_opl_mode,_web_perf_drawseg_peak_get,_web_perf_opening_peak_get,_web_set_wide,_web_screenwidth,_web_level_state,_web_state_hash,_web_gametic,_web_ingame_mask,_web_demo_state,_web_demo_start,_web_demo_stop,_web_demo_buf_ptr,_web_demo_playing,_web_play_demo_buf,_web_set_singletics \
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
