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
//   N64_DISPLAY (i_video_n64.c shows each frame): mode A also keeps the
//            hash of the 32-bit framebuffer the VI scans out
//            (n64_display_hash), mode B the COUNT the display path took
//            (n64_display_count: the conversion and any palette LUT build).
// Nothing is printed until the demo has ended.  Then n64_floor_emit() writes
// the FLOOR log (tools/floor/floor_log.h) over libdragon's debug channel
// between N64_FLOOR_BEGIN/N64_FLOOR_END lines, the END line carrying the final
// sim and render hashes in both modes, followed by the stage table (mode B),
// the display records (N64_DISPLAY) and the XPROF profile (N64_XPROF).
// tools/floor/run-n64.sh extracts them.
//
// N64_XPROF (ares emux profiler, developer builds only): ares implements COP0
// function codes 0x28 XPROF and 0x29 XPROFREAD when HomebrewMode is on; real
// silicon would most likely raise a reserved-instruction exception, so every
// use is under this #ifdef and no default build contains one.  Encoding (ares
// n64/cpu/interpreter.cpp): COP0 with the CO bit, function in bits 5..0, rd in
// bits 24..20, rt in bits 19..15, code in bits 14..6:
//     0x42000000 | rd<<20 | rt<<15 | code<<6 | function
// XPROF codes: 1 start, 2 stop (a slot accumulates over start/stop pairs),
// 3 clear one slot, 4 reset all.  XPROFREAD: rd = slot (negative: the global
// counters), rt = metric code in, value out.  The CPU counters (cpuCycles at
// 93.75 MHz, cache hits/misses/writebacks) and the RDRAM bytes per bus device
// are updated when ares synchronises, every instruction under
// ForceInterpreter and at most every 2,048 CPU cycles under the recompiler
// (Accuracy::CPU::JitInterleaving), the same instants COUNT itself advances.
//
// engine/core has no N64-specific changes; the port is tools/n64/.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <string.h>

#include <debug.h>    /* debugf */
#include <n64sys.h>   /* get_ticks */
#include <cop0.h>     /* C0_COUNT */

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
#ifdef N64_DISPLAY
#if N64_FLOOR_MODE == 'A'
static unsigned      fl_dhash[FL_MAX];   /* the 32-bit framebuffer's hash */
#else
static unsigned      fl_disp[FL_MAX];    /* COUNT in the display path */
#endif
#endif
static int                fl_n;
static int                fl_overflow;
static unsigned long long fl_last;     /* COUNT at the end of the last boundary */
static unsigned long long fl_total;    /* sum of elapsed */

#ifdef N64_XPROF
static void xp_tic_end (void);
static void xp_tic_begin (int next);
static void xp_calibrate (void);
#endif

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
#ifdef N64_XPROF
    xp_calibrate ();
#endif
    n64_floor_load = 0;
    n64_cart_bytes = 0;
#ifdef N64_DISPLAY
    n64_display_count = 0;
#endif
#if N64_FLOOR_MODE != 'A'
    fl_snapshot (fl_snap);
#endif
#ifdef N64_XPROF
    xp_tic_begin (0);
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
#ifdef N64_DISPLAY
    unsigned dc    = n64_display_count;
    n64_display_count = 0;
#endif
#ifdef N64_XPROF
    xp_tic_end ();
#endif
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
#ifdef N64_DISPLAY
        // First, before any cached read here: n64_render_hash reads all of
        // screens[0] through the D-cache, which writes back every dirty line
        // it evicts, so a display path that left its lines in the cache
        // would pass if this came after it (measured: a ROM with no
        // writeback at all, N64_DISPLAY_FAULT=4, matched on every tic).
        fl_dhash[fl_n] = n64_display_hash ();
#endif
        fl_sim[fl_n] = (unsigned) n64_state_hash ();
        fl_ren[fl_n] = n64_render_hash ();
#else
#ifdef N64_DISPLAY
        fl_disp[fl_n] = dc;
#endif
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
#ifdef N64_XPROF
    xp_tic_begin (fl_n);
#endif
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

#ifdef N64_XPROF
static void xp_emit (void);
#endif
#ifdef N64_DISPLAY
static void n64_display_emit (const char* name);
#ifndef N64_DISPLAY_FAULT
#define N64_DISPLAY_FAULT 0
#endif
#endif

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
#ifdef N64_DISPLAY
    n64_display_emit (name);
#endif
#ifdef N64_XPROF
    xp_emit ();
#endif
}

#ifdef N64_DISPLAY
// The display records, after the demo: the VI registers read back, then per
// tic the framebuffer hash (mode A, eight to a line) or the display COUNT
// (mode B, one "D <tic> <count>" line each).
static void n64_display_emit (const char* name)
{
    unsigned ctrl, origin, width, xscale, yscale, fb;
    int      i;
    n64_display_vi (&ctrl, &origin, &width, &xscale, &yscale, &fb);
    debugf ("N64_DISPLAY_VI name=%s ctrl=%08x origin=%08x width=%u xscale=%08x "
            "yscale=%08x fb=%08x frames=%u lut_builds=%u variant=%d fault=%d\n",
            name, ctrl, origin, width, xscale, yscale, fb, n64_display_frames,
            n64_display_lut_builds, N64_DISPLAY, N64_DISPLAY_FAULT);
#if N64_FLOOR_MODE == 'A'
    debugf ("N64_FB32_BEGIN %s %d\n", name, fl_n);
    for (i = 0; i < fl_n; i += 8)
    {
        int k, n = fl_n - i < 8 ? fl_n - i : 8;
        char line[96], *p = line;
        p += sprintf (p, "H %d", i);
        for (k = 0; k < n; k++)
            p += sprintf (p, " %08x", fl_dhash[i + k]);
        debugf ("%s\n", line);
    }
    debugf ("N64_FB32_END %s\n", name);
#else
    debugf ("N64_DISPLAY_BEGIN %s %d\n", name, fl_n);
    for (i = 0; i < fl_n; i++)
        debugf ("D %d %u\n", i, fl_disp[i]);
    debugf ("N64_DISPLAY_END %s\n", name);
#endif
}
#endif

// ── XPROF (ares emux) ────────────────────────────────────────────────────────
#ifdef N64_XPROF
#include "r_local.h"  /* r_draw.h: dc_yl, dc_yh, ds_x1, ds_x2 (pixels per drawer call) */

// Fixed registers: the instruction word names them, so the operands are
// pinned with register variables ($8 = rd, $9 = rt).
#define XP_START(slot) do { register unsigned long _r8 asm ("$8") = (slot); \
        asm volatile (".word 0x42800068" :: "r"(_r8) : "memory"); } while (0)
#define XP_STOP(slot)  do { register unsigned long _r8 asm ("$8") = (slot); \
        asm volatile (".word 0x428000a8" :: "r"(_r8) : "memory"); } while (0)
#define XP_CLEAR(slot) do { register unsigned long _r8 asm ("$8") = (slot); \
        asm volatile (".word 0x428000e8" :: "r"(_r8) : "memory"); } while (0)
#define XP_RESET()     do { register unsigned long _r8 asm ("$8") = 0; \
        asm volatile (".word 0x42800128" :: "r"(_r8) : "memory"); } while (0)

static unsigned long long xp_read (int slot, unsigned code)
{
    register long               r8 asm ("$8") = slot;   /* sign-extended */
    register unsigned long long r9 asm ("$9") = code;
    asm volatile (".word 0x42848029" : "+r"(r9) : "r"(r8) : "memory");
    return r9;
}

static unsigned xp_detect (void)
{
    /* XDETECT, code 1: bits 0x20..0x3f of the feature mask.  Left at 0 when
       HomebrewMode is off (ares returns without writing rd). */
    register unsigned long long r8 asm ("$8") = 0;
    asm volatile (".word 0x42800060" : "+r"(r8) :: "memory");
    return (unsigned) r8;
}

// The tics to profile, as floor-log tic indices (from a mode B run).
#ifndef N64_XPROF_TICS
#define N64_XPROF_TICS 0
#endif
static const int xp_tics[] = { N64_XPROF_TICS };
#define XP_NT_MAX 32
#define XP_NT ((int) (sizeof (xp_tics) / sizeof (xp_tics[0])) < XP_NT_MAX ? \
               (int) (sizeof (xp_tics) / sizeof (xp_tics[0])) : XP_NT_MAX)
// Slots: profiled tic j uses 20*j + s; 1000 + s accumulate over every tic of
// the demo; 1020 is the calibration loop.  ares allows slots 0..1023.
//   s 0 whole tic   1 sim     2 frame   3 bsp   4 planes   5 masked
//     (the engine's own brackets: web_perf_now, perf_n64.c)
//   s 6..14 the drawers, by the stage they run in: 6 + 3*(stage-3) + d with
//     d 0 R_DrawColumn, 1 R_DrawSpan, 2 R_DrawFuzzColumn/R_DrawTranslatedColumn
//     (walls are bsp.col, the sky planes.col, flats planes.span, sprites and
//     masked midtextures masked.col/masked.fuzz); 15 a drawer outside the three
//     (none is expected).  Each is nested inside its stage's slot.
//   s 16 R_StoreWallRange (a wall's setup and column loop, its bsp.col calls
//     included): bsp minus this is the BSP walk and clipping
//   s 17 R_RenderMaskedSegRange (masked midtextures, inside masked)
//   s 18 the display conversion (N64_DISPLAY, i_video_n64.c's I_FinishUpdate;
//     outside the five stages: part of "other")
#define XP_AGG 1000
#define XP_CAL 1020
#define XP_SLOTS 19
#define XP_STRIDE 20
#define XP_STAGES 6
#define XP_PRIMS 13   /* slots 6..18 */
static const char* const xp_slot_name[XP_SLOTS] =
    { "whole", "sim", "frame", "bsp", "planes", "masked",
      "bsp.col", "bsp.span", "bsp.fuzz", "planes.col", "planes.span", "planes.fuzz",
      "masked.col", "masked.span", "masked.fuzz", "other.draw",
      "bsp.wall", "masked.seg", "display" };

static int      xp_ok;          /* XPROF detected */
static int      xp_cur = -1;    /* j of the tic being profiled, -1 none */
static int      xp_calls;       /* web_perf_now calls in the current tic */
static int      xp_calls_at[XP_NT_MAX];
static unsigned xp_prim_calls[XP_NT_MAX][XP_PRIMS], xp_prim_px[XP_NT_MAX][XP_PRIMS];
static unsigned long long xp_agg_calls[XP_PRIMS], xp_agg_px[XP_PRIMS];
static int      xp_open_whole, xp_open_stage;   /* slots a longjmp left open */

#define XP_BOTH_START(s) do { XP_START (XP_AGG + (s)); \
        if (xp_cur >= 0) XP_START (XP_STRIDE * xp_cur + (s)); } while (0)
#define XP_BOTH_STOP(s)  do { XP_STOP (XP_AGG + (s)); \
        if (xp_cur >= 0) XP_STOP (XP_STRIDE * xp_cur + (s)); } while (0)

static void xp_tic_begin (int next)
{
    int j;
    xp_calls = 0;
    xp_cur   = -1;
    if (!xp_ok)
        return;
    for (j = 0; j < XP_NT; j++)
        if (xp_tics[j] == next)
            xp_cur = j;
    XP_BOTH_START (0);
    xp_open_whole = 1;
}

static void xp_tic_end (void)
{
    if (!xp_ok)
        return;
    XP_BOTH_STOP (0);
    xp_open_whole = 0;
    if (xp_cur >= 0)
        xp_calls_at[xp_cur] = xp_calls;
}

// Called by web_perf_now() (perf_n64.c) at each stage bracket edge.  Within a
// tic the brackets come in a fixed order: G_Ticker (sim) in D_DoomFrame, then
// R_RenderPlayerView's frame, bsp, planes and masked; a tic that renders no
// view (a load, an intermission) has only the first two.  Call k is the start
// (even k) or the end (odd k) of stage 1 + k/2.  The count per tic is printed,
// so a tic whose brackets did not come in this order is visible.
void n64_xprof_stage_edge (void)
{
    int k = xp_calls++;
    int s = 1 + (k >> 1);
    if (!xp_ok || s >= XP_STAGES)
        return;
    if (k & 1)
    {
        XP_BOTH_STOP (s);
        xp_open_stage = 0;
    }
    else
    {
        XP_BOTH_START (s);
        xp_open_stage = s;
    }
}

// The demo ends by longjmp out of G_Ticker in its last tic, which leaves the
// whole-tic slots and the sim slots started.  A started slot holds minus the
// global count, so it is closed here: the aggregates then include that final
// partial tic, about one tic in the demo's hundreds or thousands.
static void xp_close (void)
{
    if (!xp_ok)
        return;
    if (xp_open_stage)
        XP_BOTH_STOP (xp_open_stage);
    if (xp_open_whole)
        XP_BOTH_STOP (0);
    xp_open_stage = xp_open_whole = 0;
}

// The drawers.  r_main.c and r_things.c reference them across an object
// boundary (colfunc = R_DrawColumn, ...), so the link's --wrap reaches every
// call the renderer makes through those pointers.
void __real_R_DrawColumn (void);
void __real_R_DrawSpan (void);
void __real_R_DrawFuzzColumn (void);
void __real_R_DrawTranslatedColumn (void);
// d: 0 column, 1 span, 2 fuzz/translated; px: the pixels the call draws (a
// call with an empty range draws none: R_DrawColumn returns on count < 0).
static void xp_prim (int d, int px, void (*draw) (void))
{
    int st   = xp_open_stage;
    int slot = (st >= 3 && st <= 5) ? 6 + 3 * (st - 3) + d : 15;
    unsigned upx = px > 0 ? (unsigned) px : 0u;
    xp_agg_calls[slot - 6]++;
    xp_agg_px[slot - 6] += upx;
    if (xp_cur >= 0)
    {
        xp_prim_calls[xp_cur][slot - 6]++;
        xp_prim_px[xp_cur][slot - 6] += upx;
    }
    if (xp_ok)
        XP_BOTH_START (slot);
    draw ();
    if (xp_ok)
        XP_BOTH_STOP (slot);
}
void __wrap_R_DrawColumn (void)           { xp_prim (0, dc_yh - dc_yl + 1, __real_R_DrawColumn); }
void __wrap_R_DrawSpan (void)             { xp_prim (1, ds_x2 - ds_x1 + 1, __real_R_DrawSpan); }
void __wrap_R_DrawFuzzColumn (void)       { xp_prim (2, dc_yh - dc_yl + 1, __real_R_DrawFuzzColumn); }
void __wrap_R_DrawTranslatedColumn (void) { xp_prim (2, dc_yh - dc_yl + 1, __real_R_DrawTranslatedColumn); }

// Two more cross-object calls: r_bsp.c -> R_StoreWallRange and r_things.c ->
// R_RenderMaskedSegRange (both in r_segs.c).  px is the screen columns.
void __real_R_StoreWallRange (int start, int stop);
void __real_R_RenderMaskedSegRange (drawseg_t* ds, int x1, int x2);
static void xp_span_slot (int slot, int cols, int begin)
{
    if (begin)
    {
        xp_agg_calls[slot - 6]++;
        xp_agg_px[slot - 6] += cols > 0 ? (unsigned) cols : 0u;
        if (xp_cur >= 0)
        {
            xp_prim_calls[xp_cur][slot - 6]++;
            xp_prim_px[xp_cur][slot - 6] += cols > 0 ? (unsigned) cols : 0u;
        }
        if (xp_ok)
            XP_BOTH_START (slot);
    }
    else if (xp_ok)
        XP_BOTH_STOP (slot);
}
void __wrap_R_StoreWallRange (int start, int stop)
{
    xp_span_slot (16, stop - start + 1, 1);
    __real_R_StoreWallRange (start, stop);
    xp_span_slot (16, 0, 0);
}
void __wrap_R_RenderMaskedSegRange (drawseg_t* ds, int x1, int x2)
{
    xp_span_slot (17, x2 - x1 + 1, 1);
    __real_R_RenderMaskedSegRange (ds, x1, x2);
    xp_span_slot (17, 0, 0);
}

// The display conversion, one call a frame, 64,000 pixels (i_video_n64.c).
void n64_xprof_display (int begin)
{
    xp_span_slot (18, SCREENWIDTH * SCREENHEIGHT, begin);
}

// One calibration loop: n iterations of a 3-instruction loop (addiu, bnez,
// delay-slot nop) inside an XPROF slot and a COUNT bracket.  `skew` more
// iterations run inside the COUNT bracket only: the red-proof, a profiler that
// missed part of what COUNT saw.
static void xp_cal_loop (unsigned n, unsigned skew)
{
    unsigned c0, c1, it;
    unsigned long long cyc, ihit, imiss, dmiss;
    XP_CLEAR (XP_CAL);
    c0 = C0_COUNT ();
    XP_START (XP_CAL);
    it = n;
    asm volatile (".set push\n.set noreorder\n"
                  "1: addiu %0, %0, -1\n"
                  "   bnez  %0, 1b\n"
                  "   nop\n"
                  ".set pop\n" : "+r"(it));
    XP_STOP (XP_CAL);
    it = skew;
    if (it)
        asm volatile (".set push\n.set noreorder\n"
                      "1: addiu %0, %0, -1\n"
                      "   bnez  %0, 1b\n"
                      "   nop\n"
                      ".set pop\n" : "+r"(it));
    c1 = C0_COUNT ();
    cyc   = xp_read (XP_CAL, 0x0000);
    ihit  = xp_read (XP_CAL, 0x0010);
    imiss = xp_read (XP_CAL, 0x0011);
    dmiss = xp_read (XP_CAL, 0x0021);
    debugf ("N64_XPROF_CAL iters=%u skew=%u count=%u cycles=%llu insns=%u "
            "icache_hits=%llu icache_misses=%llu dcache_misses=%llu\n",
            n, skew, c1 - c0, cyc, 3u * n, ihit, imiss, dmiss);
}

#ifndef N64_XPROF_CAL_SKEW
#define N64_XPROF_CAL_SKEW 0
#endif

// The cost of a WAD copy by each path: 64,000 bytes out of cartridge space
// into screens[3], the wipe's end buffer (wipe_EndScreen overwrites it before
// every use, so nothing reads what this leaves).  Source offsets 0 and 1 from
// a word-aligned lump: the DMA's direct path and its bounce path.
void n64_cart_copy_words (void* dest, const void* src, size_t n);
#if N64_CART_DMA
void n64_cart_copy_dma (void* dest, const void* src, size_t n);
#endif
const byte* n64_wad_base (void);
static void xp_copy_bench (void)
{
    extern byte* screens[5];
    const byte* src = n64_wad_base ();
    int off;
    if (!src || !screens[3])
        return;
    for (off = 0; off < 2; off++)
    {
        unsigned c0 = C0_COUNT (), c1, c2;
        n64_cart_copy_words (screens[3], src + 4096 + off, 64000u);
        c1 = C0_COUNT ();
#if N64_CART_DMA
        n64_cart_copy_dma (screens[3], src + 4096 + off, 64000u);
#endif
        c2 = C0_COUNT ();
        debugf ("N64_COPY_BENCH bytes=64000 src_offset=%d words_count=%u dma_count=%u dma=%d\n",
                off, c1 - c0, c2 - c1, N64_CART_DMA);
    }
}

static void xp_calibrate (void)
{
    unsigned det = xp_detect ();
    xp_ok = (det >> (0x28 - 0x20)) & (det >> (0x29 - 0x20)) & 1u;
    debugf ("N64_XPROF_DETECT mask_hi=%08x xprof=%d\n", det, xp_ok);
    // The loops run even when XPROF is absent: the harness must see the
    // disagreement, not merely the missing feature bit.
    XP_RESET ();
    xp_cal_loop (10000u, 0);
    xp_cal_loop (100000u, 0);
    xp_cal_loop (1000000u, (unsigned) N64_XPROF_CAL_SKEW);
    XP_RESET ();
    xp_copy_bench ();
}

// RDRAM traffic in bytes per bus device.  The 0x300-0x302 totals are not
// read: ares's RDRAM::Profile::total() (n64/rdram/rdram.hpp) sums into an
// uninitialised local, so they come back as garbage plus the true sum; the
// harness adds the devices up itself.
static void xp_line (const char* kind, int j, int s, int calls)
{
    int slot = kind[0] == 'A' ? XP_AGG + s : XP_STRIDE * j + s;
    unsigned long long pc = 0, ppx = 0;
    if (s >= 6)
    {
        pc  = kind[0] == 'A' ? xp_agg_calls[s - 6] : xp_prim_calls[j][s - 6];
        ppx = kind[0] == 'A' ? xp_agg_px[s - 6]    : xp_prim_px[j][s - 6];
    }
    debugf ("%s %d %s calls=%d prim_calls=%llu prim_px=%llu cycles=%llu cycles_exc=%llu "
            "icache_hits=%llu icache_misses=%llu icache_wb=%llu "
            "dcache_hits=%llu dcache_misses=%llu dcache_wb=%llu "
            "rsp_cycles=%llu rsp_halted=%llu "
            "icache_rd=%llu icache_wr=%llu dcache_rd=%llu dcache_wr=%llu "
            "uncached_rd=%llu uncached_wr=%llu spdma_rd=%llu spdma_wr=%llu "
            "pidma_rd=%llu pidma_wr=%llu vidma_rd=%llu dpdraw_rd=%llu dpdraw_wr=%llu\n",
            kind, kind[0] == 'A' ? -1 : xp_tics[j], xp_slot_name[s], calls, pc, ppx,
            xp_read (slot, 0x0000), xp_read (slot, 0x0001),
            xp_read (slot, 0x0010), xp_read (slot, 0x0011), xp_read (slot, 0x0012),
            xp_read (slot, 0x0020), xp_read (slot, 0x0021), xp_read (slot, 0x0022),
            xp_read (slot, 0x0200), xp_read (slot, 0x0201),
            xp_read (slot, 0x0311), xp_read (slot, 0x0312),
            xp_read (slot, 0x0321), xp_read (slot, 0x0322),
            xp_read (slot, 0x0331), xp_read (slot, 0x0332),
            xp_read (slot, 0x0341), xp_read (slot, 0x0342),
            xp_read (slot, 0x0351), xp_read (slot, 0x0352),
            xp_read (slot, 0x0391), xp_read (slot, 0x0371), xp_read (slot, 0x0372));
}

static void xp_emit (void)
{
    int j, s;
    xp_close ();
    debugf ("N64_XPROF_BEGIN %s ok=%d profiled=%d\n", N64_FLOOR_NAME, xp_ok, XP_NT);
    for (j = 0; j < XP_NT; j++)
    {
        int i = xp_tics[j];
        debugf ("XT %d elapsed=%u flags=%u mbytes=%u\n", i,
                i < fl_n ? fl_elapsed[i] : 0u, i < fl_n ? fl_flags[i] : 0u,
                i < fl_n ? fl_mbytes[i] : 0u);
        for (s = 0; s < XP_SLOTS; s++)
            xp_line ("P", j, s, xp_calls_at[j]);
    }
    for (s = 0; s < XP_SLOTS; s++)
        xp_line ("A", 0, s, -1);
    debugf ("N64_XPROF_END %s\n", N64_FLOOR_NAME);
}
#endif /* N64_XPROF */
