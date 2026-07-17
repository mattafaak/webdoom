// tools/baremetal/perf.h — no-op stub for engine/web/perf.h.
// Identical surface to freestanding/perf.h and native-sanitize/perf.h.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_PERF_H__
#define __WEB_PERF_H__

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

// Returns 0.0 in this build (no emscripten_get_now / hardware counter).
double web_perf_now(void);

#endif
