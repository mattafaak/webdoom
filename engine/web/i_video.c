// webdoom i_video: the engine composes into screens[0], column-major
// (screens[0][x*SCREENHEIGHT + y] = pixel(x,y)), and JS reads it in place
// through web_framebuffer().  There is no presentation copy: the bytes go up
// as a 200x320 R8 texture and the fragment shader swaps the axes
// (client/js/video.js).
//
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <emscripten.h>
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "v_video.h"
#include "i_video.h"

static byte webpalette[256 * 3];
static int paletteversion; // bumped on every I_SetPalette

void I_InitGraphics (void) {}

void I_ShutdownGraphics (void) {}

void I_SetPalette (byte* palette)
{
    int i;
    /* usegamma comes from .doomrc, which here round-trips through
       IndexedDB, and M_LoadDefaults assigns config values with no range
       check: `usegamma 99` would read 24 KB past gammatable[5][256].  It is
       clamped here, the one unguarded reader, so engine/core stays close to
       id's source (the menu's F11 path wraps it to 0 itself). */
    int g = usegamma;
    if (g < 0 || g >= 5)
        g = 0;
    for (i = 0; i < 256 * 3; i++)
        webpalette[i] = gammatable[g][palette[i]];
    paletteversion++;
}

void I_UpdateNoBlit (void) {}

// nothing to do: the frame is complete in screens[0] when D_DoomFrame returns
void I_FinishUpdate (void) {}

void I_ReadScreen (byte* scr)
{
    // Copy raw column-major bytes; callers (wipe, screenshot) handle layout.
    memcpy (scr, screens[0], SCREENWIDTH * SCREENHEIGHT);
}

// --- JS bridge ---------------------------------------------------------

// screens[0] itself, column-major.  The address is stable for the session:
// V_Init allocates it once with I_AllocLow.  fnv1aRender() in demo-test.mjs
// visits it in row-major order, so the render goldens did not move when the
// untranspose copy went.
EMSCRIPTEN_KEEPALIVE byte* web_framebuffer (void)
{
    return screens[0];
}
EMSCRIPTEN_KEEPALIVE byte* web_palette (void)
{
    return webpalette;
}
EMSCRIPTEN_KEEPALIVE int web_palette_version (void)
{
    return paletteversion;
}
