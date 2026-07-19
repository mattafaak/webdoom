// webdoom: per-stage timing accumulators — defined in engine/web/perf.c.
// Included by both web and core files (both -Iweb and -Icore in CFLAGS).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_PERF_H__
#define __WEB_PERF_H__

// Accumulators (µs, double precision).  Reset by web_perf_reset() between
// demos.  Populated only when the render pass runs (nodrawers == 0).
// sim is accumulated by the G_Ticker wrapper in d_main.c.
extern double web_perf_sim_us;
extern double web_perf_frame_us; // R_SetupFrame + buffer clears
extern double web_perf_bsp_us; // R_RenderBSPNode (BSP walk + segs, interleaved)
extern double web_perf_planes_us; // R_DrawPlanes
extern double web_perf_masked_us; // R_DrawMasked (sprites + midtextures)
extern long web_perf_frame_count; // frames rendered (for per-frame averages)
extern long web_perf_tic_count;   // G_Ticker calls (for per-tic averages)

// task 2.2 call-count counters — always declared; incremented only when
// r_draw.c is compiled with -DWEB_PERF_COL_STATS.  Exported via
// web_perf_col_calls_get() / web_perf_span_calls_get() so bench scripts can
// harvest them without modifying bench.mjs.
// web_perf_col_pixels / web_perf_span_pixels count total pixels drawn.
extern long web_perf_col_calls;   // R_DrawColumn + variants call count
extern long web_perf_span_calls;  // R_DrawSpan call count
extern long web_perf_col_pixels;  // total pixels drawn by column funcs
extern long web_perf_span_pixels; // total pixels drawn by span func

// task 2.3: R_FindPlane probe-depth counters — always declared; incremented
// only when r_plane.c is compiled with -DWEB_PERF_PLANE_STATS.  Exported via
// web_perf_findplane_*_get() getters so bench scripts can harvest them.
extern long web_perf_findplane_calls; // calls to R_FindPlane (all frames)
extern long web_perf_findplane_iters; // linear-search comparison iterations
extern long web_perf_visplane_peak;   // peak live visplanes seen in any frame
extern long
    web_perf_drawseg_peak; // task 14.2e: peak drawsegs used in any frame
extern long
    web_perf_opening_peak; // task 14.2f: peak openings used in any frame

// task 6.2: teleport counter — always declared; incremented only when
// p_telept.c is compiled with -DWEB_PERF_TELEPORT_STATS.  Byte-unaffected in
// the default build because the variable is zeroed and the getter just returns
// it.
extern long web_perf_teleport_calls; // successful player teleports per demo

// task 6.2: numspechit peak tracker — always declared; updated only when
// p_map.c is compiled with -DWEB_PERF_SPECHIT_STATS.
extern long web_perf_spechit_peak; // peak numspechit observed in any tic

// task 13.2b: render-ON zone HWM + purge-pressure counters.
// Defined in z_zone.c when compiled with -DWEB_PERF_ZONE_STATS; absent
// otherwise so the default build is byte-identical to shipping.
// Getters (EMSCRIPTEN_KEEPALIVE) are defined in perf.c under the same guard.
#ifdef WEB_PERF_ZONE_STATS
extern long web_perf_zone_live_np;      // current non-purgeable live bytes
extern long web_perf_zone_live_p;       // current purgeable live bytes
extern long web_perf_zone_hwm_np;       // HWM non-purgeable
extern long web_perf_zone_hwm_p;        // HWM purgeable
extern long web_perf_zone_hwm_total;    // HWM total (np + p)
extern long web_perf_zone_purge_count;  // Z_Malloc PU_CACHE evictions
extern long web_perf_zone_purged_bytes; // total bytes evicted
long web_perf_zone_hwm_np_get (void);
long web_perf_zone_hwm_p_get (void);
long web_perf_zone_hwm_total_get (void);
long web_perf_zone_purge_count_get (void);
long web_perf_zone_purged_bytes_get (void);
#endif

// High-resolution µs timestamp.  Wraps emscripten_get_now() * 1000.
// Defined in perf.c so core files need not include <emscripten.h>.
double web_perf_now (void);

#endif
