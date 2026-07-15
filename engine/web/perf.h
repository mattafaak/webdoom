// webdoom: per-stage timing accumulators — defined in engine/web/perf.c.
// Included by both web and core files (both -Iweb and -Icore in CFLAGS).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_PERF_H__
#define __WEB_PERF_H__

// Accumulators (µs, double precision).  Reset by web_perf_reset() between
// demos.  Populated only when the render pass runs (nodrawers == 0).
// sim is accumulated by the G_Ticker wrapper in d_main.c.
extern double web_perf_sim_us;
extern double web_perf_frame_us;   // R_SetupFrame + buffer clears
extern double web_perf_bsp_us;     // R_RenderBSPNode (BSP walk + segs, interleaved)
extern double web_perf_planes_us;  // R_DrawPlanes
extern double web_perf_masked_us;  // R_DrawMasked (sprites + midtextures)
extern long   web_perf_frame_count; // frames rendered (for per-frame averages)
extern long   web_perf_tic_count;   // G_Ticker calls (for per-tic averages)

// High-resolution µs timestamp.  Wraps emscripten_get_now() * 1000.
// Defined in perf.c so core files need not include <emscripten.h>.
double web_perf_now (void);

#endif
