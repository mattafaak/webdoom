// tools/rp2040/perf_rp2040.c — RP2040 perf shim.
//
// engine/core's d_main.c and r_main.c unconditionally include "perf.h" and
// call web_perf_now().  This file provides the RP2040 implementation:
// all counters are zero-initialized globals (no instruction counting on M0+).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include "perf.h"

int fs_perf_instr_fd = -1;

double web_perf_sim_us    = 0.0;
double web_perf_bsp_us    = 0.0;
double web_perf_planes_us = 0.0;
double web_perf_masked_us = 0.0;
double web_perf_frame_us  = 0.0;

long web_perf_frame_count      = 0;
long web_perf_tic_count        = 0;
long web_perf_col_calls        = 0;
long web_perf_span_calls       = 0;
long web_perf_col_pixels       = 0;
long web_perf_span_pixels      = 0;
long web_perf_findplane_calls  = 0;
long web_perf_findplane_iters  = 0;
long web_perf_visplane_peak    = 0;
long web_perf_drawseg_peak     = 0;
long web_perf_opening_peak     = 0;

long web_perf_zone_hwm_total    = 0;
long web_perf_zone_hwm_np       = 0;
long web_perf_zone_hwm_p        = 0;
long web_perf_zone_purge_count  = 0;
long web_perf_zone_purged_bytes = 0;

// web_perf_now: on RP2040 there is no hardware performance counter accessible
// without pico-sdk.  Return 0.0 — stage attribution won't work, but the
// engine compiles and runs (without per-stage stats).
double web_perf_now(void)
{
    return 0.0;
}
