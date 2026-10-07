// tools/n64/perf_n64.c — N64 perf shim: the engine's stage timers in COUNT.
//
// engine/core's d_main.c and r_main.c bracket each stage with web_perf_now()
// and accumulate the difference into web_perf_*_us:
//     sim     G_Ticker                      (d_main.c)
//     frame   R_SetupFrame + buffer clears  (r_main.c, R_RenderPlayerView)
//     bsp     R_RenderBSPNode (walls)
//     planes  R_DrawPlanes    (floors, ceilings, sky)
//     masked  R_DrawMasked    (sprites, masked midtextures, the weapon)
// Here web_perf_now() returns C0_COUNT extended to 64 bits, so those
// accumulators count COP0 COUNT ticks (half the 93.75 MHz CPU clock:
// 46,875,000 a second), and the "_us" in their names is historical.
//
// Under N64_XPROF the same calls also drive ares's emux profiler, so each
// stage gets cycles and cache counts as well (n64_floor.c owns the slots).
//
// engine/core has no N64-specific changes; the port is tools/n64/.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <cop0.h>   /* C0_COUNT */
#include "perf.h"
#include "n64_platform.h"

int fs_perf_instr_fd = -1;

double web_perf_sim_us    = 0.0;
double web_perf_bsp_us    = 0.0;
double web_perf_planes_us = 0.0;
double web_perf_masked_us = 0.0;
double web_perf_frame_us  = 0.0;

long web_perf_frame_count      = 0;
long web_perf_tic_count        = 0;
long web_perf_visplane_peak    = 0;
long web_perf_drawseg_peak     = 0;
long web_perf_opening_peak     = 0;

long web_perf_zone_hwm_total    = 0;
long web_perf_zone_hwm_np       = 0;
long web_perf_zone_hwm_p        = 0;
long web_perf_zone_purge_count  = 0;
long web_perf_zone_purged_bytes = 0;

// COUNT is 32 bits and wraps every 2^32 / 46,875,000 = 91.6 s, well inside one
// demo.  Each read adds the (modular) distance since the previous read, so the
// sum is exact as long as two reads are never 91.6 s apart; every tic reads it
// at least twice.  Not reentrant: nothing calls it from an interrupt.
static unsigned long long count64_base;
static unsigned           count64_last;

unsigned long long n64_count64(void)
{
    unsigned now = C0_COUNT();
    count64_base += (unsigned)(now - count64_last);
    count64_last = now;
    return count64_base;
}

#ifdef N64_XPROF
void n64_xprof_stage_edge(void);   /* n64_floor.c */
#endif

double web_perf_now(void)
{
#ifdef N64_XPROF
    n64_xprof_stage_edge();
#endif
    return (double)n64_count64();
}
