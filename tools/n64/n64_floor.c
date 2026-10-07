// tools/n64/n64_floor.c — the floor gate on the N64 (built with N64_FLOOR=A|B).
//
// During the demo each tic boundary reads COUNT and stores, into RDRAM arrays:
//   elapsed  COP0 COUNT ticks since the previous boundary (46,875,000 a
//            second, half the CPU clock), the harness's own work excluded;
//   flags    L when P_SetupLevel, WI_Start or F_StartFinale ran in the tic
//            (the --wrap hooks below), and the bytes memcpy took out of
//            cartridge space (cart_read_n64.c, M:<bytes>);
//   mode A   the sim hash (n64_state_hash) and the render hash
//            (n64_render_hash), the same algorithms as tools/freestanding;
//   mode B   no hashing at all: the engine's own stage timers instead (sim,
//            frame, bsp, planes, masked, in COUNT ticks; perf_n64.c).
// Nothing is printed until the demo has ended.  Then n64_floor_emit() writes
// the FLOOR log (tools/floor/floor_log.h) over libdragon's debug channel
// between N64_FLOOR_BEGIN/N64_FLOOR_END lines, the END line carrying the final
// sim and render hashes in both modes, followed by the stage table (mode B).
// tools/floor/run-n64.sh extracts them.
//
// engine/core has no N64-specific changes; the port is tools/n64/.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <string.h>

#include <debug.h>    /* debugf */
#include <n64sys.h>   /* get_ticks */

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"   /* wbstartstruct_t, which wi_stuff.h needs first */
#include "wi_stuff.h"
#include "perf.h"
#include "floor_log.h"
#include "n64_platform.h"

#ifndef N64_FLOOR_MODE
#error "n64_floor.c is built only with N64_FLOOR=A|B (the Makefile sets N64_FLOOR_MODE)"
#endif
#ifndef N64_FLOOR_NAME
#define N64_FLOOR_NAME "unknown-demo"
#endif
#ifndef N64_BUILD
#define N64_BUILD "unknown"
#endif

extern int detailLevel;    /* m_menu.c */
extern int screenblocks;   /* m_menu.c */

// ── the tic flags: --wrap hooks (Makefile: N64_FLOOR) ────────────────────────
// P_SetupLevel, WI_Start and F_StartFinale are each called only from g_game.c,
// across an object boundary, so --wrap sees every call (as
// tools/freestanding/floor_wrap.c does on the host).  The memcpy hook already
// exists here: cart_read_n64.c counts n64_cart_bytes.
volatile unsigned n64_floor_load;

void __real_P_SetupLevel (int episode, int map, int playermask, skill_t skill);
void __wrap_P_SetupLevel (int episode, int map, int playermask, skill_t skill)
{
    n64_floor_load = 1;
    __real_P_SetupLevel (episode, map, playermask, skill);
}

void __real_WI_Start (wbstartstruct_t* wbstartstruct);
void __wrap_WI_Start (wbstartstruct_t* wbstartstruct)
{
    n64_floor_load = 1;
    __real_WI_Start (wbstartstruct);
}

void __real_F_StartFinale (void);
void __wrap_F_StartFinale (void)
{
    n64_floor_load = 1;
    __real_F_StartFinale ();
}

// ── per-tic records ──────────────────────────────────────────────────────────
// 8,192 tics covers the longest graded demo (plutonia-demo1, 7,403 tics).  A
// longer run is not truncated in silence: the overflow is counted, the log
// says tics=<recorded> while the INFO line reports the overflow, and the
// runner fails it.
#define FL_MAX 8192

static unsigned      fl_elapsed[FL_MAX];
static unsigned      fl_mbytes[FL_MAX];
static int           fl_gametic[FL_MAX];
static unsigned char fl_flags[FL_MAX];
#if N64_FLOOR_MODE == 'A'
static unsigned      fl_sim[FL_MAX];
static unsigned      fl_ren[FL_MAX];
#else
#define FL_STAGES 5   /* sim frame bsp planes masked */
static unsigned      fl_stage[FL_MAX][FL_STAGES];
static double        fl_snap[FL_STAGES];
#endif
static int                fl_n;
static int                fl_overflow;
static unsigned long long fl_last;     /* COUNT at the end of the last boundary */
static unsigned long long fl_total;    /* sum of elapsed */


#if N64_FLOOR_MODE != 'A'
static void fl_snapshot (double* s)
{
    s[0] = web_perf_sim_us;
    s[1] = web_perf_frame_us;
    s[2] = web_perf_bsp_us;
    s[3] = web_perf_planes_us;
    s[4] = web_perf_masked_us;
}
#endif

void n64_floor_begin (void)
{
    n64_floor_load = 0;
    n64_cart_bytes = 0;
#if N64_FLOOR_MODE != 'A'
    fl_snapshot (fl_snap);
#endif
    fl_last = n64_count64 ();
}

void n64_floor_tic (void)
{
    // COUNT first, so everything below (hashing, bookkeeping) is charged to
    // no tic: fl_last is re-read once it is done.
    unsigned long long now = n64_count64 ();
    unsigned long long d   = now - fl_last;
    unsigned flags = n64_floor_load ? FLOOR_TIC_LOAD : 0;
    unsigned mb    = n64_cart_bytes;
    n64_floor_load = 0;
    n64_cart_bytes = 0;
    fl_total += d;
    if (fl_n < FL_MAX)
    {
        fl_elapsed[fl_n] = d > 0xffffffffull ? 0xffffffffu : (unsigned) d;
        fl_mbytes[fl_n]  = mb;
        fl_gametic[fl_n] = gametic;
        fl_flags[fl_n]   = (unsigned char) flags;
#if N64_FLOOR_MODE == 'A'
        fl_sim[fl_n] = (unsigned) n64_state_hash ();
        fl_ren[fl_n] = n64_render_hash ();
#else
        {
            double s[FL_STAGES];
            int k;
            fl_snapshot (s);
            for (k = 0; k < FL_STAGES; k++)
                fl_stage[fl_n][k] = (unsigned) (s[k] - fl_snap[k]);
        }
#endif
        fl_n++;
    }
    else
        fl_overflow++;
#if N64_FLOOR_MODE != 'A'
    fl_snapshot (fl_snap);
#endif
    // Keep libdragon's 64-bit tick base current.  get_ticks() extends COUNT
    // lazily, so a gap of more than 91.6 s between two calls loses 2^32 ticks;
    // in a rendered timedemo nothing else calls it between the start and the
    // end (I_GetTime), and the engine's realtics would come out short.
    (void) get_ticks ();
    fl_last = n64_count64 ();
}

// ── output ───────────────────────────────────────────────────────────────────
// floor_log.c emits a byte at a time; a line is assembled here and written
// with one fwrite, so one debug-channel write carries one whole line.
static char fl_line[256];
static int  fl_line_n;

static void fl_putc (int c)
{
    fl_line[fl_line_n++] = (char) c;
    if (c == '\n' || fl_line_n == (int) sizeof (fl_line))
    {
        fwrite (fl_line, 1, (size_t) fl_line_n, stderr);
        fl_line_n = 0;
    }
}


void n64_floor_emit (void)
{
    floor_header_t h;
    floor_audio_t  a;
    const char*    name = N64_FLOOR_NAME;
    unsigned       final_sim = (unsigned) n64_state_hash ();
    unsigned       final_ren = n64_render_hash ();
    int            i;

    memset (&h, 0, sizeof (h));
    h.target   = "n64-ares";
    h.source   = "emulator";
    h.unit     = "count";
    h.unit_hz  = 46875000ull;       /* COP0 COUNT: half of 93.75 MHz */
    h.build    = N64_BUILD;
    h.view     = screenblocks;
    h.detail   = detailLevel;
    h.zone     = (unsigned) N64_ZONE_SIZE;
    h.precache = 0;
    h.mode     = (char) N64_FLOOR_MODE;

    debugf ("N64_FLOOR_BEGIN %s %c %d\n", name, (char) N64_FLOOR_MODE, fl_n);
    floor_log_init (fl_putc);
    floor_header (&h);
    floor_demo_begin (name, (unsigned) fl_n);
    for (i = 0; i < fl_n; i++)
#if N64_FLOOR_MODE == 'A'
        floor_tic ((unsigned) i, (unsigned) fl_gametic[i], fl_elapsed[i],
                   fl_flags[i], fl_mbytes[i], 1, fl_sim[i], fl_ren[i]);
#else
        floor_tic ((unsigned) i, (unsigned) fl_gametic[i], fl_elapsed[i],
                   fl_flags[i], fl_mbytes[i], 0, 0, 0);
#endif
    memset (&a, 0, sizeof (a));     /* no audio on the N64 yet */
    floor_audio (&a);
    floor_demo_end (name, final_sim, final_ren);
    if (fl_line_n)
        fl_putc ('\n');
    debugf ("N64_FLOOR_END %s\n", name);

    // Beside the log, not in it: the engine's own wall time for the demo, so
    // the per-tic COUNT sum can be checked against an independent clock.
    debugf ("N64_FLOOR_INFO name=%s mode=%c tics=%d overflow=%d gametics=%d "
            "realtics=%d count_total=%llu frames=%ld view=%d detail=%d\n",
            name, (char) N64_FLOOR_MODE, fl_n, fl_overflow,
            (int) n64_timedemo_gametics, (int) n64_timedemo_realtics,
            fl_total, web_perf_frame_count, screenblocks, detailLevel);

#if N64_FLOOR_MODE != 'A'
    // The stage table: COUNT ticks per stage per tic, from the engine's own
    // brackets.  other = elapsed - the five.
    debugf ("N64_STAGES_BEGIN %s %d sim frame bsp planes masked\n", name, fl_n);
    for (i = 0; i < fl_n; i++)
        debugf ("S %d %u %u %u %u %u\n", i, fl_stage[i][0], fl_stage[i][1],
                fl_stage[i][2], fl_stage[i][3], fl_stage[i][4]);
    debugf ("N64_STAGES_END %s\n", name);
#endif
}
