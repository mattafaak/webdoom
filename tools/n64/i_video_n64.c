// tools/n64/i_video_n64.c — N64 software rasterizer shim.
//
// Scope: software rasterizer only; there is no RDP (hardware-accelerated)
// path.  The engine draws into screens[0], a palette-index array in RDRAM,
// column-major: pixel (x,y) at [x*SCREENHEIGHT+y].
//
// Three builds:
//
//   default (the n64-demos leg, -timedemo -nodraw): I_FinishUpdate copies the
//   frame into a 64,000-byte shadow buffer and I_ReadScreen reads it back.
//   The renderer never runs there, so neither matters; it is left as it was.
//
//   N64_FLOOR (render mode): no shadow buffer.  It was a memcpy stub, and
//   worse than wasted RDRAM once the renderer runs: f_wipe.c's wipe_EndScreen
//   calls I_ReadScreen for the NEW frame, which the shadow copy (last updated
//   by the previous I_FinishUpdate) does not hold yet.  I_ReadScreen copies
//   screens[0] itself, as tools/freestanding/i_video.c does, and
//   n64_render_hash() hashes it the way the render goldens were recorded.
//   Headless: nothing is shown.
//
//   N64_FLOOR + N64_DISPLAY (opt-in): the frame is shown.  Each I_FinishUpdate
//   converts screens[0] through the current palette into a 320x240 32-bit
//   framebuffer that the VI scans out; the 200 rows sit in rows 20..219 and
//   the 20 rows above and below stay opaque black (letterboxed, square
//   pixels).  The conversion runs inside the tic, so the floor's COUNT per
//   tic includes it, and n64_display_count carries its own share.
//
// The display path, and why it is built this way:
//
//   Exact colour.  The VI shows a 32-bit framebuffer as 8:8:8 (+8 bits the VI
//   reads as coverage, unused with AA off).  The RDP could expand an 8-bit
//   texture through a TLUT, but its TLUT entries are 16-bit (libdragon
//   rdpq_mode.h: TLUT_RGBA16, 5:5:5:1, or TLUT_IA16, 8-bit intensity), so
//   an exact 8:8:8 palette is a CPU table: n64_lut[256], one 0xRRGGBBAA word
//   per index, rebuilt only when I_SetPalette runs.  The colour rule is
//   engine/web/i_video.c's: gammatable[usegamma][PLAYPAL byte] per channel,
//   usegamma clamped to 0..4.
//
//   No waiting.  One framebuffer, taken once with display_get() and never
//   handed back with display_show(): the VI scans it out continuously and the
//   CPU overwrites it each tic (it may tear; nothing waits for a vblank, and
//   display_get() would, once a single buffer had been shown).  libdragon
//   still takes the VI interrupt each vblank (its handler rewrites the same
//   origin); that time lands in whatever tic it interrupts.
//
//   The VI: libdragon's display_init(RESOLUTION_320x240, DEPTH_32_BPP, 1,
//   GAMMA_NONE, FILTERS_DISABLED): VI_CTRL type 32-bit, AA and resampling off
//   (pixels replicated, never blended), gamma and gamma dither off.  The
//   registers are read back after init and printed (N64_DISPLAY_VI).
//
//   The stores.  The framebuffer is written through its cached alias, one
//   16-byte D-cache line (4 pixels of a row) at a time: Create Dirty
//   Exclusive (no fill from RDRAM), four 32-bit stores, Hit Writeback
//   Invalidate.  So every line reaches RDRAM once, as one burst, and leaves
//   the 8 KB direct-mapped D-cache at once instead of evicting the engine's
//   data.  Two 64-bit stores would save two stores a line but cost a shift
//   and an OR per pixel pair to build them: the same cycles in ares (674,305
//   COUNT a tic with them, 674,431 without, doom-demo4), and two more
//   instructions a line for the console to issue.  The source is read 4
//   columns at a time, 8 rows per 64-bit load, because screens[0] is
//   column-major and the framebuffer is row-major.
//   Two variants exist to measure that choice, not to ship:
//     N64_DISPLAY=2  uncached stores, no cache ops.  ares does not model the
//                    VR4300's path for them (memory/io.hpp: write cycles 0,
//                    "not implemented until we implement the CPU write
//                    queue"): under ForceInterpreter each costs its
//                    instruction, and the recompiler about 4.8 cycles more,
//                    so this measures ares, not the console.
//     N64_DISPLAY=3  no Create Dirty Exclusive: each line is filled from RDRAM
//                    by its first store (write-allocate), then written back.
//
//   Memory: 307,200 B of framebuffer from libdragon's heap.  On a stock 4 MB
//   console the floor builds have under 200 KB of heap left at the default
//   2,560 KB zone, so display ROMs are built with a smaller zone
//   (tools/floor/run-n64.sh --display); I_InitGraphics refuses by name when
//   the framebuffer does not fit.
//
//   N64_DISPLAY_FAULT (red-proofs of the exactness check only):
//     1  blue + 1 in every LUT entry (one channel off by one)
//     2  index i shows palette entry i+1 (the wrong palette index)
//     3  the LUT is built once and never again (palette changes ignored)
//     4  no Hit Writeback Invalidate: the lines stay dirty in the D-cache,
//        and RDRAM, which the VI and the check read, gets them only when
//        something else evicts them
//
// engine/core has no N64-specific changes; the port is tools/n64/.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include "doomdef.h"
#include "v_video.h"
#include "i_video.h"
#include "n64_platform.h"

#ifdef N64_DISPLAY
#include <stdint.h>
#include <stdlib.h>   /* malloc, free: the heap check */
#include <cop0.h>     /* C0_COUNT */
#include <n64sys.h>   /* CachedAddr, UncachedAddr, PhysicalAddr */
#include <display.h>
#include <surface.h>
#include "i_system.h" /* I_Error */
#endif

// Active palette: 256 RGB triplets (768 bytes) as the engine passed them.
static byte n64_pal_rgb[768];

// Frame counter: incremented by I_FinishUpdate.
static unsigned int n64_frame_count = 0;

#ifndef N64_FLOOR
// Shadow framebuffer in RDRAM (320×200 palette indices = 64,000 bytes).
static byte n64_shadow_fb[320 * 200];
#else
// I_SetPalette calls, folded into the render hash exactly as
// tools/freestanding/i_video.c folds fs_palette_version.
unsigned n64_palette_version;
#endif

#ifdef N64_DISPLAY
#ifndef N64_DISPLAY_FAULT
#define N64_DISPLAY_FAULT 0
#endif
#define FB_W     320
#define FB_H     240
#define FB_PITCH (FB_W * 4)
#define FB_TOP   ((FB_H - SCREENHEIGHT) / 2)   /* 20 black rows above the frame */

static uint32_t  n64_lut[256] __attribute__((aligned(16)));
static uint32_t* n64_fb;          /* uncached (KSEG1): what the VI scans out */
static uint8_t*  n64_fb_cached;   /* the same RDRAM through KSEG0 */
static int       n64_fb_ready;
// COUNT spent in I_SetPalette's LUT build and I_FinishUpdate's conversion;
// n64_floor.c reads and clears it at every tic boundary.
volatile unsigned n64_display_count;
unsigned n64_display_frames;      /* conversions */
unsigned n64_display_lut_builds;  /* LUT builds */

static void n64_build_lut(const byte* palette)
{
    int g = usegamma, i;
    if (g < 0 || g >= 5)          /* engine/web/i_video.c clamps the same way */
        g = 0;
#if N64_DISPLAY_FAULT == 3
    if (n64_display_lut_builds)
        return;
#endif
    for (i = 0; i < 256; i++)
    {
#if N64_DISPLAY_FAULT == 2
        const byte* c = palette + 3 * ((i + 1) & 255);
#else
        const byte* c = palette + 3 * i;
#endif
        uint32_t r = gammatable[g][c[0]], gr = gammatable[g][c[1]], b = gammatable[g][c[2]];
#if N64_DISPLAY_FAULT == 1
        b = (b + 1) & 0xffu;
#endif
        n64_lut[i] = r << 24 | gr << 16 | b << 8 | 0xffu;
    }
}

// The conversion: 4 source columns at a time, so each output row of the
// group is one whole 16-byte D-cache line.  Each column is read 8 rows per
// 64-bit load (a column is 200 B, and screens[0] is 8-aligned: V_Init carves
// it from n64_screenbufs), and each byte is turned straight into its LUT
// offset by a shift and a mask: (w >> (54 - 8k)) & 0x3fc is byte k times 4.
#define CACHE_OP(op, p, off) __asm__ volatile ("cache %0, %2(%1)" :: "i" (op), "r" (p), "i" (off) : "memory")
#define LUT_AT(off)     (*(const uint32_t*) ((const uint8_t*) lut + (off)))
#define OFF(w, k)       ((k) < 7 ? (uint32_t) ((w) >> (54 - 8 * (k))) & 0x3fcu \
                                 : (uint32_t) ((w) << 2) & 0x3fcu)
#if N64_DISPLAY == 1
#define LINE_BEGIN(d, off) CACHE_OP(0x0d, d, off)   /* D-cache Create Dirty Exclusive */
#else
#define LINE_BEGIN(d, off)                          /* 2: uncached; 3: the store fills the line */
#endif
#if N64_DISPLAY == 2 || N64_DISPLAY_FAULT == 4
#define LINE_END(d, off)
#else
#define LINE_END(d, off)   CACHE_OP(0x15, d, off)   /* D-cache Hit Writeback Invalidate */
#endif
#define ROW(k) do { \
        uint32_t p0 = LUT_AT(OFF(w0, k)), p1 = LUT_AT(OFF(w1, k)); \
        uint32_t p2 = LUT_AT(OFF(w2, k)), p3 = LUT_AT(OFF(w3, k)); \
        uint32_t* q = (uint32_t*) (d + (k) * FB_PITCH); \
        LINE_BEGIN(d, (k) * FB_PITCH); \
        q[0] = p0; q[1] = p1; q[2] = p2; q[3] = p3; \
        LINE_END(d, (k) * FB_PITCH); \
    } while (0)
static void n64_display_frame(void)
{
    const uint32_t* lut = n64_lut;
    const uint64_t* col = (const uint64_t*) screens[0];
    int             x, r;
#if N64_DISPLAY == 2
    uint8_t* top = (uint8_t*) n64_fb + FB_TOP * FB_PITCH;
#else
    uint8_t* top = n64_fb_cached + FB_TOP * FB_PITCH;
#endif

    for (x = 0; x < SCREENWIDTH; x += 4, col += 4 * SCREENHEIGHT / 8)
    {
        uint8_t* d = top + x * 4;
        for (r = 0; r < SCREENHEIGHT / 8; r++)
        {
            uint64_t w0 = col[r], w1 = col[r + 25], w2 = col[r + 50], w3 = col[r + 75];
            ROW(0); ROW(1); ROW(2); ROW(3); ROW(4); ROW(5); ROW(6); ROW(7);
            d += 8 * FB_PITCH;
        }
    }
}

// FNV-1a over the framebuffer's 76,800 32-bit words, row-major, read through
// the uncached alias: what RDRAM holds, which is what the VI scans out (a line
// left dirty in the D-cache would not be in it).  Called only between tics.
unsigned n64_display_hash(void)
{
    const volatile uint32_t* p = n64_fb;
    unsigned h = 0x811c9dc5u;
    int      i;
    if (!p)
        return 0;
    for (i = 0; i < FB_W * FB_H; i++)
        h = (h ^ p[i]) * 0x01000193u;
    return h;
}

// The VI registers as they are, not as they were asked for.
void n64_display_vi(unsigned* ctrl, unsigned* origin, unsigned* width,
                    unsigned* xscale, unsigned* yscale, unsigned* fb_phys)
{
    volatile uint32_t* vi = (volatile uint32_t*) 0xA4400000u;
    *ctrl    = vi[0];
    *origin  = vi[1];
    *width   = vi[2];
    *xscale  = vi[12];
    *yscale  = vi[13];
    *fb_phys = n64_fb ? (unsigned) PhysicalAddr(n64_fb) : 0u;
}

static void n64_display_init(void)
{
    surface_t* s;
    void*      probe;
    int        i;
    if (n64_fb_ready)
        return;
    // display_init asserts when its framebuffer does not fit, and an assert
    // here prints nothing the harness waits for; this says why instead.
    probe = malloc(FB_W * FB_H * 4 + 64);
    if (!probe)
        I_Error("N64_DISPLAY: no room for the %d B framebuffer in the heap; "
                "build with a smaller N64_ZONE_KB (tools/floor/run-n64.sh --display)",
                FB_W * FB_H * 4);
    free(probe);
    if (((unsigned long) screens[0] & 7) || SCREENHEIGHT % 8)
        I_Error("N64_DISPLAY: screens[0] is not 8-aligned, or a column is not whole 64-bit words");
    display_init(RESOLUTION_320x240, DEPTH_32_BPP, 1, GAMMA_NONE, FILTERS_DISABLED);
    s = display_get();      /* one buffer: free now, and never shown or waited on */
    n64_fb        = (uint32_t*) UncachedAddr(s->buffer);
    n64_fb_cached = (uint8_t*) CachedAddr(s->buffer);
    for (i = 0; i < FB_W * FB_H; i++)
        n64_fb[i] = 0x000000ffu;    /* opaque black: the letterbox, and the frame until the first update */
    n64_fb_ready = 1;
}
#endif /* N64_DISPLAY */

void I_InitGraphics(void)
{
    memset(n64_pal_rgb, 0, sizeof(n64_pal_rgb));
#ifndef N64_FLOOR
    memset(n64_shadow_fb, 0, sizeof(n64_shadow_fb));
#else
    n64_palette_version = 0;
#endif
    n64_frame_count = 0;
#ifdef N64_DISPLAY
    n64_display_init();
#endif
}

void I_ShutdownGraphics(void) {}

void I_SetPalette(byte* palette)
{
#ifdef N64_DISPLAY
    unsigned c0 = C0_COUNT();
    n64_build_lut(palette);
    n64_display_lut_builds++;
    n64_display_count += C0_COUNT() - c0;
#endif
    memcpy(n64_pal_rgb, palette, 768);
#ifdef N64_FLOOR
    n64_palette_version++;
#endif
}

void I_FinishUpdate(void)
{
#ifndef N64_FLOOR
    extern byte* screens[];
    if (screens[0])
        memcpy(n64_shadow_fb, screens[0], sizeof(n64_shadow_fb));
#endif
#ifdef N64_DISPLAY
    if (n64_fb_ready)
    {
        unsigned c0 = C0_COUNT();
#ifdef N64_XPROF
        n64_xprof_display(1);   /* n64_floor.c: ares's profiler, slot "display" */
#endif
        n64_display_frame();
#ifdef N64_XPROF
        n64_xprof_display(0);
#endif
        n64_display_frames++;
        n64_display_count += C0_COUNT() - c0;
    }
#endif
    // Without N64_DISPLAY, render mode has nothing to flush: the frame is
    // complete in screens[0] and nothing shows it.
    n64_frame_count++;
}

void I_UpdateNoBlit(void) {}

void I_ReadScreen(byte* scr)
{
#ifndef N64_FLOOR
    if (scr)
        memcpy(scr, n64_shadow_fb, sizeof(n64_shadow_fb));
#else
    memcpy(scr, screens[0], SCREENWIDTH * SCREENHEIGHT);
#endif
}

#ifdef N64_FLOOR
// FNV-1a over screens[0] in VISUAL row-major order (y outer, x inner), then
// the palette version as 4 little-endian bytes: fs_render_hash() in
// tools/freestanding/i_video.c, which fnv1aRender() in tools/demo-test.mjs
// recorded the render goldens with.  Called only between tics (mode A).
unsigned n64_render_hash(void)
{
    unsigned    h  = 0x811c9dc5u;
    const byte* fb = screens[0];
    unsigned    pv = n64_palette_version;
    int         x, y;

    for (y = 0; y < SCREENHEIGHT; y++)
        for (x = 0; x < SCREENWIDTH; x++)
            h = (h ^ (unsigned)fb[x * SCREENHEIGHT + y]) * 0x01000193u;

    h = (h ^ (pv         & 0xffu)) * 0x01000193u;
    h = (h ^ ((pv >>  8) & 0xffu)) * 0x01000193u;
    h = (h ^ ((pv >> 16) & 0xffu)) * 0x01000193u;
    h = (h ^ ((pv >> 24) & 0xffu)) * 0x01000193u;
    return h;
}
#endif
