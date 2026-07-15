// webdoom: per-stage timing accumulators + JS-visible getters.
// Timing state lives here so core files need not include <emscripten.h>.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <emscripten.h>
#include "perf.h"

// Accumulators — µs (double precision).
double web_perf_sim_us     = 0;
double web_perf_frame_us   = 0;
double web_perf_bsp_us     = 0;
double web_perf_planes_us  = 0;
double web_perf_masked_us  = 0;
long   web_perf_frame_count = 0;
long   web_perf_tic_count   = 0;

// emscripten_get_now() returns milliseconds; multiply by 1000 for µs.
double web_perf_now (void)
{
    return emscripten_get_now () * 1000.0;
}

// --- JS-visible getters ---
// bench.mjs calls these after each demo to harvest per-stage µs totals,
// then divides by web_perf_frames() to get per-frame averages.
// The fleet runner (task 0.2) will branch on schemaVersion to consume them.

EMSCRIPTEN_KEEPALIVE
double web_perf_sim (void)
{
    return web_perf_sim_us;
}

EMSCRIPTEN_KEEPALIVE
double web_perf_frame (void)
{
    return web_perf_frame_us;
}

EMSCRIPTEN_KEEPALIVE
double web_perf_bsp (void)
{
    return web_perf_bsp_us;
}

EMSCRIPTEN_KEEPALIVE
double web_perf_planes (void)
{
    return web_perf_planes_us;
}

EMSCRIPTEN_KEEPALIVE
double web_perf_masked (void)
{
    return web_perf_masked_us;
}

EMSCRIPTEN_KEEPALIVE
double web_perf_frames (void)
{
    return (double) web_perf_frame_count;
}

// Reset all accumulators.  Call between demos so each demo's numbers are
// independent.
EMSCRIPTEN_KEEPALIVE
void web_perf_reset (void)
{
    web_perf_sim_us      = 0;
    web_perf_frame_us    = 0;
    web_perf_bsp_us      = 0;
    web_perf_planes_us   = 0;
    web_perf_masked_us   = 0;
    web_perf_frame_count = 0;
    web_perf_tic_count   = 0;
}
