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

// Peak counters, always declared and updated only in a build compiled with
// the matching flag: -DWEB_PERF_PLANE_STATS (r_plane.c),
// -DWEB_PERF_DRAWSEG_STATS (r_bsp.c), -DWEB_PERF_OPENINGS_STATS (r_plane.c),
// -DWEB_PERF_TELEPORT_STATS (p_telept.c), -DWEB_PERF_SPECHIT_STATS (p_map.c).
extern long web_perf_visplane_peak;  // peak live visplanes in any frame
extern long web_perf_drawseg_peak;   // peak drawsegs used in any frame
extern long web_perf_opening_peak;   // peak openings used in any frame
extern long web_perf_teleport_calls; // successful player teleports
extern long web_perf_spechit_peak;   // peak numspechit in any tic

// Zone high-water and purge counters, defined in z_zone.c only when compiled
// with -DWEB_PERF_ZONE_STATS (the freestanding build prints them).
#ifdef WEB_PERF_ZONE_STATS
extern long web_perf_zone_live_np;      // current non-purgeable live bytes
extern long web_perf_zone_live_p;       // current purgeable live bytes
extern long web_perf_zone_hwm_np;       // HWM non-purgeable
extern long web_perf_zone_hwm_p;        // HWM purgeable
extern long web_perf_zone_hwm_total;    // HWM total (np + p)
extern long web_perf_zone_purge_count;  // Z_Malloc PU_CACHE evictions
extern long web_perf_zone_purged_bytes; // total bytes evicted
#endif

// High-resolution µs timestamp.  Wraps emscripten_get_now() * 1000.
// Defined in perf.c so core files need not include <emscripten.h>.
double web_perf_now (void);

#endif
