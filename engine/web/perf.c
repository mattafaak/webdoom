// webdoom: per-stage timing accumulators + JS-visible getters.
// Timing state lives here so core files need not include <emscripten.h>.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <emscripten.h>
#include "perf.h"
#include "web.h"    // ZONESIZE — single authoritative define
#include "z_zone.h" // webdoom: Z_FreeMemory() for zone stats (task 0.5)

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
// bench.mjs calls these after each demo to harvest per-stage µs totals,
// then divides by web_perf_frames() to get per-frame averages.
// The fleet runner (task 0.2) will branch on schemaVersion to consume them.

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

// task 2.2: column/span call-count accumulators.
// Always defined so JS getters are always valid (return 0 in normal builds).
// Incremented only when r_draw.c is compiled with -DWEB_PERF_COL_STATS.
long web_perf_col_calls = 0;
long web_perf_span_calls = 0;
long web_perf_col_pixels = 0;
long web_perf_span_pixels = 0;

EMSCRIPTEN_KEEPALIVE long web_perf_col_calls_get (void)
{
    return web_perf_col_calls;
}

EMSCRIPTEN_KEEPALIVE long web_perf_span_calls_get (void)
{
    return web_perf_span_calls;
}

EMSCRIPTEN_KEEPALIVE long web_perf_col_pixels_get (void)
{
    return web_perf_col_pixels;
}

EMSCRIPTEN_KEEPALIVE long web_perf_span_pixels_get (void)
{
    return web_perf_span_pixels;
}

// task 2.3: R_FindPlane probe-depth counters.
// Always defined so JS getters are always valid (return 0 in normal builds).
// Incremented only when r_plane.c is compiled with -DWEB_PERF_PLANE_STATS.
long web_perf_findplane_calls = 0;
long web_perf_findplane_iters = 0;
long web_perf_visplane_peak = 0;

EMSCRIPTEN_KEEPALIVE long web_perf_findplane_calls_get (void)
{
    return web_perf_findplane_calls;
}

EMSCRIPTEN_KEEPALIVE long web_perf_findplane_iters_get (void)
{
    return web_perf_findplane_iters;
}

EMSCRIPTEN_KEEPALIVE long web_perf_visplane_peak_get (void)
{
    return web_perf_visplane_peak;
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
    web_perf_col_calls = 0;
    web_perf_span_calls = 0;
    web_perf_col_pixels = 0;
    web_perf_span_pixels = 0;
    web_perf_findplane_calls = 0;
    web_perf_findplane_iters = 0;
    web_perf_visplane_peak = 0;
}

// --- webdoom: Z_Zone memory stats (task 0.5 memory audit) ---
// web_zone_sample() snapshots current used bytes and updates the HWM.
// Call once per tic from measurement scripts; O(n) scan over memblock list,
// same cost as Z_FreeMemory().
// web_zone_hwm()/web_zone_size() let JS harvest results.
// web_zone_hwm_reset() clears between IWADs.  Exports are kept permanently —
// they feed the task 2.5 Z_Zone review and task 2.6 knob sweep.

// webdoom: zone HWM (peak used bytes since last reset)
static int zone_hwm = 0;

// webdoom: sample current zone usage; update HWM if higher.
// used = zone_pool_size - free_bytes (Z_FreeMemory walks the block list).
EMSCRIPTEN_KEEPALIVE void web_zone_sample (void)
{
    int used = ZONESIZE - Z_FreeMemory ();
    if (used > zone_hwm)
        zone_hwm = used;
}

// webdoom: return zone high-water mark (bytes) since last reset
EMSCRIPTEN_KEEPALIVE int web_zone_hwm (void)
{
    return zone_hwm;
}

// webdoom: return total zone pool size (bytes); always ZONESIZE
EMSCRIPTEN_KEEPALIVE int web_zone_size (void)
{
    return ZONESIZE;
}

// webdoom: reset zone HWM (call between IWADs)
EMSCRIPTEN_KEEPALIVE void web_zone_hwm_reset (void)
{
    zone_hwm = 0;
}

// webdoom: return wasm linear-memory heap base (address of first dynamic
// allocation = static-data + C-shadow-stack bytes).
// Headroom formula: INITIAL_MEMORY - heap_base - zone_size - peak_wad_malloc.
extern int __heap_base; // provided by the emscripten/wasm linker
EMSCRIPTEN_KEEPALIVE int web_heap_base (void)
{
    return (int) &__heap_base;
}
