// tools/freestanding/perf.c — instruction-count perf shim (13.1b).
// When fs_perf_instr_fd >= 0, web_perf_now() reads the perf_event_open fd
// and returns the cumulative user-space instruction count.  Stage brackets in
// d_main.c / r_main.c then accumulate instruction deltas into web_perf_*_us
// instead of µs.  When fs_perf_instr_fd < 0 (no fd), returns 0.0 (no-op).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <unistd.h>
#include "perf.h"

// Perf fd set by i_main.c before the demo loop when WD_CYCLES=1.
int    fs_perf_instr_fd = -1;

// Stage accumulators: in attribution mode these accumulate instruction-count
// deltas (units: instructions) rather than wall-clock µs.
double web_perf_sim_us    = 0;
double web_perf_frame_us  = 0;
double web_perf_bsp_us    = 0;
double web_perf_planes_us = 0;
double web_perf_masked_us = 0;
long   web_perf_frame_count = 0;
long   web_perf_tic_count   = 0;

long   web_perf_col_calls   = 0;
long   web_perf_span_calls  = 0;
long   web_perf_col_pixels  = 0;
long   web_perf_span_pixels = 0;

long   web_perf_findplane_calls = 0;
long   web_perf_findplane_iters = 0;
long   web_perf_visplane_peak   = 0;
long   web_perf_drawseg_peak    = 0; /* task 14.2e */
long   web_perf_opening_peak   = 0; /* task 14.2f */

// Read the current cumulative instruction count from the perf fd.
// Returns 0 on failure or when fd is not open.
static long long fs_perf_read_instr(void)
{
    long long v = 0;
    if (fs_perf_instr_fd >= 0)
        read(fs_perf_instr_fd, &v, sizeof(v));
    return v;
}

// Called at every stage bracket entry and exit by d_main.c / r_main.c.
// Returns the current cumulative user-space instruction count (as double,
// exact for counts < 2^53) or 0.0 when no perf fd is active.
double web_perf_now(void)
{
    return (double)fs_perf_read_instr();
}
