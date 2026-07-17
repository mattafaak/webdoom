// tools/baremetal/i_video.c — headless static framebuffer (rung 2, bare-metal).
// Identical to freestanding/i_video.c: no display hardware, screens[0] is a
// static 320*200 palette-indexed buffer.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "v_video.h"
#include "i_video.h"
#include "fs_platform.h"

static byte bm_screenbuf[SCREENWIDTH * SCREENHEIGHT];
static byte bm_palette[256 * 3];
static int  bm_palette_version;

void I_InitGraphics(void)
{
    screens[0] = bm_screenbuf;
    memset(bm_screenbuf, 0, sizeof(bm_screenbuf));
    bm_palette_version = 0;
}

void I_ShutdownGraphics(void) {}

void I_SetPalette(byte* palette)
{
    int i;
    for (i = 0; i < 256 * 3; i++)
        bm_palette[i] = gammatable[usegamma][palette[i]];
    bm_palette_version++;
}

void I_UpdateNoBlit(void) {}

void I_FinishUpdate(void) {}

void I_ReadScreen(byte* scr)
{
    memcpy(scr, screens[0], SCREENWIDTH * SCREENHEIGHT);
}

int fs_palette_version_get(void)
{
    return bm_palette_version;
}

unsigned fs_render_hash(void)
{
    unsigned   h   = 0x811c9dc5u;
    const byte* fb = screens[0];
    int        i;
    int        pv  = bm_palette_version;

    for (i = 0; i < SCREENWIDTH * SCREENHEIGHT; i++)
        h = (h ^ (unsigned)fb[i]) * 0x01000193u;

    h = (h ^ (unsigned)(pv        & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned)((pv >>  8) & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned)((pv >> 16) & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned)((pv >> 24) & 0xff)) * 0x01000193u;

    return h;
}
