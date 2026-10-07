// tools/n64/i_video_n64.c — N64 software rasterizer shim.
//
// Scope: software rasterizer only; there is no RDP (hardware-accelerated)
// path and no display yet.  The framebuffer lives in RDRAM as a palette-index
// array (screens[0], column-major: pixel (x,y) at [x*SCREENHEIGHT+y]); no
// conversion to RGB is performed.
//
// Two builds:
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
//
// engine/core has no N64-specific changes; the port is tools/n64/.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include "doomdef.h"
#include "v_video.h"
#include "i_video.h"
#include "n64_platform.h"

// Active palette: 256 RGB triplets (768 bytes), kept for a future display path.
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

void I_InitGraphics(void)
{
    memset(n64_pal_rgb, 0, sizeof(n64_pal_rgb));
#ifndef N64_FLOOR
    memset(n64_shadow_fb, 0, sizeof(n64_shadow_fb));
#else
    n64_palette_version = 0;
#endif
    n64_frame_count = 0;
}

void I_ShutdownGraphics(void) {}

void I_SetPalette(byte* palette)
{
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
    // Render mode: nothing to flush.  A display would expand screens[0]
    // through n64_pal_rgb into the VI framebuffer here (CPU or RDP); that cost
    // is not part of any measurement yet.
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
