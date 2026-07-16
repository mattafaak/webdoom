// native-sanitize perf.h — no-op stub for engine/web/perf.h.
// d_main.c, r_main.c, and r_plane.c include "perf.h" for timing counters.
// The native build has no web perf bridge; all counters are defined here as
// writable globals (same ABI as perf.c) but web_perf_now() returns 0.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_PERF_H__
#define __WEB_PERF_H__

// Perf accumulators: declared but never meaningful in the native build.
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

// Returns 0.0 in the native build (no emscripten_get_now).
double web_perf_now (void);

#endif
