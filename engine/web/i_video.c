// webdoom i_video: the engine composes into screens[0] (column-major after
// 14.2a); JS reads a row-major untransposed copy via web_framebuffer().
//
// Layout after 14.2a: screens[0][x*SCREENHEIGHT + y] = pixel(x,y).
// I_FinishUpdate untransposes into web_rowmajor_buf[] which JS hashes and
// palettizes; the pointer returned by web_framebuffer() is stable across
// frames (same static buffer address every call).
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

// Row-major presentation buffer: JS reads this.  Populated by I_FinishUpdate.
static byte web_rowmajor_buf[SCREENWIDTH * SCREENHEIGHT];

void I_InitGraphics (void) {}

void I_ShutdownGraphics (void) {}

void I_SetPalette (byte* palette)
{
    int i;
    for (i = 0; i < 256 * 3; i++)
        webpalette[i] = gammatable[usegamma][palette[i]];
    paletteversion++;
}

void I_UpdateNoBlit (void) {}

// Untranspose screens[0] (column-major) → web_rowmajor_buf (row-major).
// JS reads the row-major buffer for palette-indexed rendering and hashing.
void I_FinishUpdate (void)
{
    const byte* src = screens[0];
    int x, y;
    for (x = 0; x < SCREENWIDTH; x++)
    {
        const byte* col = src + x * SCREENHEIGHT;
        for (y = 0; y < SCREENHEIGHT; y++)
            web_rowmajor_buf[y * SCREENWIDTH + x] = col[y];
    }
}

void I_ReadScreen (byte* scr)
{
    // Copy raw column-major bytes; callers (wipe, screenshot) handle layout.
    memcpy (scr, screens[0], SCREENWIDTH * SCREENHEIGHT);
}

// --- JS bridge ---------------------------------------------------------

EMSCRIPTEN_KEEPALIVE byte* web_framebuffer (void)
{
    // Return the stable row-major buffer populated by I_FinishUpdate.
    // fnv1aRender() in demo-test.mjs hashes this buffer linearly (row-major
    // order = visual row-major order) so golden hashes are preserved.
    return web_rowmajor_buf;
}
EMSCRIPTEN_KEEPALIVE byte* web_palette (void)
{
    return webpalette;
}
EMSCRIPTEN_KEEPALIVE int web_palette_version (void)
{
    return paletteversion;
}
