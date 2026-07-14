// webdoom i_video: the engine composes into screens[0]; JS reads the
// framebuffer and palette straight out of wasm memory after each
// D_DoomFrame and palettizes on the GPU. Nothing to do here but export
// pointers and a palette-dirty flag.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <emscripten.h>

#include "doomdef.h"
#include "doomstat.h"
#include "v_video.h"
#include "i_video.h"

static byte webpalette[256*3];
static int  paletteversion;     // bumped on every I_SetPalette

void I_InitGraphics (void)
{
}

void I_ShutdownGraphics (void)
{
}

void I_SetPalette (byte* palette)
{
    int i;
    for (i = 0; i < 256*3; i++)
        webpalette[i] = gammatable[usegamma][palette[i]];
    paletteversion++;
}

void I_UpdateNoBlit (void)
{
}

void I_FinishUpdate (void)
{
    // JS blits after D_DoomFrame returns; nothing to flush.
}

void I_ReadScreen (byte* scr)
{
    memcpy (scr, screens[0], SCREENWIDTH*SCREENHEIGHT);
}

// --- JS bridge ---------------------------------------------------------

EMSCRIPTEN_KEEPALIVE byte* web_framebuffer (void) { return screens[0]; }
EMSCRIPTEN_KEEPALIVE byte* web_palette (void)     { return webpalette; }
EMSCRIPTEN_KEEPALIVE int   web_palette_version (void) { return paletteversion; }
