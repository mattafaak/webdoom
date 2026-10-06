// webdoom: per-stage timing accumulators, peak counters and zone usage, with
// JS-visible getters.  Timing state lives here so core files need not
// include <emscripten.h>.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <emscripten.h>
#include "perf.h"
#include "web.h"    // ZONESIZE — single authoritative define
#include "z_zone.h" // Z_FreeMemory, for web_zone_sample

// Accumulators — µs (double precision).
double web_perf_sim_us = 0;
double web_perf_frame_us = 0;
double web_perf_bsp_us = 0;
double web_perf_planes_us = 0;
double web_perf_masked_us = 0;
long web_perf_frame_count = 0;
long web_perf_tic_count = 0;

// emscripten_get_now() returns milliseconds; multiply by 1000 for µs.
double web_perf_now (void)
{
    return emscripten_get_now () * 1000.0;
}

// --- JS-visible getters ---
// bench.mjs reads the per-stage µs totals after each demo and divides by
// web_perf_frames() for per-frame averages; demo-test reads the frame count.

EMSCRIPTEN_KEEPALIVE double web_perf_sim (void)
{
    return web_perf_sim_us;
}

EMSCRIPTEN_KEEPALIVE double web_perf_frame (void)
{
    return web_perf_frame_us;
}

EMSCRIPTEN_KEEPALIVE double web_perf_bsp (void)
{
    return web_perf_bsp_us;
}

EMSCRIPTEN_KEEPALIVE double web_perf_planes (void)
{
    return web_perf_planes_us;
}

EMSCRIPTEN_KEEPALIVE double web_perf_masked (void)
{
    return web_perf_masked_us;
}

EMSCRIPTEN_KEEPALIVE double web_perf_frames (void)
{
    return (double) web_perf_frame_count;
}

// Peak counters (perf.h): zero unless the build sets the matching flag, so
// the getters are always valid.
long web_perf_visplane_peak = 0;
long web_perf_drawseg_peak = 0;
long web_perf_opening_peak = 0;

EMSCRIPTEN_KEEPALIVE long web_perf_visplane_peak_get (void)
{
    return web_perf_visplane_peak;
}

long web_perf_teleport_calls = 0;
long web_perf_spechit_peak = 0;

EMSCRIPTEN_KEEPALIVE long web_perf_teleport_calls_get (void)
{
    return web_perf_teleport_calls;
}

EMSCRIPTEN_KEEPALIVE long web_perf_spechit_peak_get (void)
{
    return web_perf_spechit_peak;
}

// Reset all accumulators.  Call between demos so each demo's numbers are
// independent.
EMSCRIPTEN_KEEPALIVE void web_perf_reset (void)
{
    web_perf_sim_us = 0;
    web_perf_frame_us = 0;
    web_perf_bsp_us = 0;
    web_perf_planes_us = 0;
    web_perf_masked_us = 0;
    web_perf_frame_count = 0;
    web_perf_tic_count = 0;
    web_perf_visplane_peak = 0;
    web_perf_drawseg_peak = 0;
    web_perf_opening_peak = 0;
    web_perf_teleport_calls = 0;
    web_perf_spechit_peak = 0;
}

// --- zone usage ---
// web_zone_sample() records the zone's used bytes (ZONESIZE minus what
// Z_FreeMemory finds free, an O(blocks) walk) and keeps the high-water mark;
// demo-seek-test and demo-verify-test sample once per tic and read it with
// web_zone_hwm(), resetting between demos.
static int zone_hwm = 0;

EMSCRIPTEN_KEEPALIVE void web_zone_sample (void)
{
    int used = ZONESIZE - Z_FreeMemory ();
    if (used > zone_hwm)
        zone_hwm = used;
}

EMSCRIPTEN_KEEPALIVE int web_zone_hwm (void)
{
    return zone_hwm;
}

EMSCRIPTEN_KEEPALIVE void web_zone_hwm_reset (void)
{
    zone_hwm = 0;
}
