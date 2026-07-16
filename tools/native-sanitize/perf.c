// native-sanitize perf.c — no-op perf counter definitions.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include "perf.h"

double web_perf_sim_us;
double web_perf_frame_us;
double web_perf_bsp_us;
double web_perf_planes_us;
double web_perf_masked_us;
long   web_perf_frame_count;
long   web_perf_tic_count;

long   web_perf_col_calls;
long   web_perf_span_calls;
long   web_perf_col_pixels;
long   web_perf_span_pixels;

long   web_perf_findplane_calls;
long   web_perf_findplane_iters;
long   web_perf_visplane_peak;

double web_perf_now (void) { return 0.0; }
