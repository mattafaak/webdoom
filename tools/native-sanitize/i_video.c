// native-sanitize i_video.c — headless framebuffer for ASan/UBSan demo runs.
// screens[0] is a malloc'd 320*200 byte palette-indexed buffer.  paletteversion
// is bumped on every I_SetPalette call (same semantics as web/i_video.c).
// nat_render_hash() computes the FNV-1a 32-bit hash used by demo-test.mjs
// --render mode so golden comparison is apples-to-apples.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdlib.h>
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "v_video.h"
#include "i_video.h"
#include "nat_platform.h"

// screens[0] lives here; the renderer reads it via v_video.h extern byte** screens.
static byte screenbuf[SCREENWIDTH * SCREENHEIGHT];

// Palette mirror + version counter (same as web/i_video.c).
static byte webpalette[256 * 3];
static int  paletteversion;

void I_InitGraphics (void)
{
    // Wire the renderer's screens pointer to our static buffer.
    // v_video.c declares: extern byte* screens[5];
    screens[0] = screenbuf;
    memset (screenbuf, 0, sizeof screenbuf);
    paletteversion = 0;
}

void I_ShutdownGraphics (void) {}

void I_SetPalette (byte* palette)
{
    int i;
    for (i = 0; i < 256 * 3; i++)
        webpalette[i] = gammatable[usegamma][palette[i]];
    paletteversion++;
}

void I_UpdateNoBlit (void) {}

void I_FinishUpdate (void)
{
    // Headless: nothing to flush.
}

void I_ReadScreen (byte* scr)
{
    memcpy (scr, screens[0], SCREENWIDTH * SCREENHEIGHT);
}

// ── hash export ──────────────────────────────────────────────────────────────

int nat_palette_version (void)
{
    return paletteversion;
}

// FNV-1a 32-bit: hash screens[0] then fold paletteversion as 4 LE bytes.
// Must produce the same value as fnv1aRender() in tools/demo-test.mjs.
unsigned nat_render_hash (void)
{
    unsigned h = 0x811c9dc5u;
    const byte* fb = screens[0];
    int i;
    int pv = paletteversion;

    for (i = 0; i < SCREENWIDTH * SCREENHEIGHT; i++)
        h = (h ^ (unsigned) fb[i]) * 0x01000193u;

    // Fold palette version as 4 little-endian bytes.
    h = (h ^ (unsigned) ( pv        & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned) ((pv >>  8) & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned) ((pv >> 16) & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned) ((pv >> 24) & 0xff)) * 0x01000193u;

    return h;
}
