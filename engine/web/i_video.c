// webdoom i_video: the engine composes into screens[0] (column-major since
// 14.2a: screens[0][x*SCREENHEIGHT + y] = pixel(x,y)) and JS reads it in
// place through web_framebuffer().  There is no presentation copy: the
// column-major bytes go up as a 200x320 R8 texture and the fragment shader
// swaps the axes (client/js/video.js).  Until round 10 I_FinishUpdate
// untransposed 64,000 bytes into a second buffer on every displayed frame.
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
    /* usegamma indexes gammatable[5][256] and arrives UNBOUNDED.  It is a
       plain entry in m_misc.c's defaults table, and M_LoadDefaults assigns
       `*defaults[i].location = parm` with no range check on any entry -- so a
       .doomrc carrying `usegamma 99` reads about 24 KB past the table, here,
       on every palette update.  On this port .doomrc is not a file on the
       user's own disk: it round-trips through IndexedDB (client/js/persist.js),
       which browser-options already treats as hostile input and tests as such.

       spec.md tenet 4: no input from the network, the WAD, or the user may
       corrupt memory.  This is that.

       Clamped HERE rather than in m_misc.c because engine/core is vendored
       close to id's source on purpose, and the platform layer already owns the
       palette.  The menu path self-heals (m_menu.c wraps to 0 on F11), so this
       is the only unguarded reader. */
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
