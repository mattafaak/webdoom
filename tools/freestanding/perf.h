// tools/freestanding/perf.h — instruction-count shim for engine/web/perf.h.
// d_main.c, r_main.c, and r_plane.c include "perf.h" for timing counters.
// In this build web_perf_now() reads fs_perf_instr_fd (set by i_main.c when
// WD_CYCLES=1) so stage brackets accumulate instruction deltas instead of µs.
// When fs_perf_instr_fd < 0 (no perf fd), web_perf_now() returns 0.0.
// Identical surface to native-sanitize/perf.h (FINDING-6: five-header surface).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_PERF_H__
#define __WEB_PERF_H__

// Perf accumulators.  When fs_perf_instr_fd >= 0, these accumulate
// instruction-count deltas (stage brackets call web_perf_now() which reads
// the perf fd).  Zero when fs_perf_instr_fd < 0 (no measurement active).
extern double web_perf_sim_us;
extern double web_perf_frame_us;
extern double web_perf_bsp_us;
extern double web_perf_planes_us;
extern double web_perf_masked_us;
extern long   web_perf_frame_count;
extern long   web_perf_tic_count;

extern long   web_perf_col_calls;
extern long   web_perf_span_calls;
extern long   web_perf_col_pixels;
extern long   web_perf_span_pixels;

extern long   web_perf_findplane_calls;
extern long   web_perf_findplane_iters;
extern long   web_perf_visplane_peak;
extern long   web_perf_drawseg_peak;    /* task 14.2e: peak drawsegs used in any frame */
extern long   web_perf_opening_peak;   /* task 14.2f: peak openings used in any frame */

// Instruction-counter fd shared between perf.c and i_main.c.
// Set to the perf_event_open fd by i_main.c when WD_CYCLES=1; -1 otherwise.
extern int    fs_perf_instr_fd;

// Returns the current cumulative user-space instruction count from
// fs_perf_instr_fd, or 0.0 if no fd is open.
double web_perf_now(void);

// task 13.2b: render-ON zone HWM + purge-pressure counters.
// Defined in z_zone.c when compiled with -DWEB_PERF_ZONE_STATS.
// i_main.c reads them directly at demo end; no EMSCRIPTEN_KEEPALIVE here.
#ifdef WEB_PERF_ZONE_STATS
extern long web_perf_zone_live_np;
extern long web_perf_zone_live_p;
extern long web_perf_zone_hwm_np;
extern long web_perf_zone_hwm_p;
extern long web_perf_zone_hwm_total;
extern long web_perf_zone_purge_count;
extern long web_perf_zone_purged_bytes;
#endif

#endif
