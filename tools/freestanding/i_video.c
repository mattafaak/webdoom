// tools/freestanding/i_video.c — headless static framebuffer.
//
// screens[0] is a static 320*200 byte palette-indexed buffer.
// I_InitGraphics overrides screens[0] (which V_Init set from I_AllocLow)
// with this static buffer — same pattern as native-sanitize/i_video.c.
// nat_render_hash() is exported for i_main.c to compute per-tic render hashes
// identical to fnv1aRender() in demo-test.mjs and native-sanitize.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "v_video.h"
#include "i_video.h"
#include "fs_platform.h"

// Static screen-0 buffer (palette indices, row-major 320*200 = 64,000 bytes).
// In a freestanding port this lives in a chosen memory region (SRAM, PSRAM).
/* 4-byte alignment: screens[0] may be cast to short* / int* by render code. */
static byte fs_screenbuf[SCREENWIDTH * SCREENHEIGHT] __attribute__((aligned(4)));

// Gamma-corrected RGB palette mirror (same layout as web/i_video.c webpalette).
static byte fs_palette[256 * 3];
static int  fs_palette_version;

void I_InitGraphics(void)
{
    // Override screens[0] set by V_Init/I_AllocLow.  I_InitGraphics is called
    // after V_Init so this write wins.
    screens[0] = fs_screenbuf;
    memset(fs_screenbuf, 0, sizeof(fs_screenbuf));
    fs_palette_version = 0;
}

void I_ShutdownGraphics(void) {}

void I_SetPalette(byte* palette)
{
    int i;
    for (i = 0; i < 256 * 3; i++)
        fs_palette[i] = gammatable[usegamma][palette[i]];
    fs_palette_version++;
}

void I_UpdateNoBlit(void) {}

void I_FinishUpdate(void)
{
    // Headless: nothing to flush.  In a real port: blit screens[0] to display.
}

void I_ReadScreen(byte* scr)
{
    memcpy(scr, screens[0], SCREENWIDTH * SCREENHEIGHT);
}

// ── Render hash export ────────────────────────────────────────────────────────
// FNV-1a 32-bit: hash screens[0] then fold palette version as 4 LE bytes.
// Algorithm identical to fnv1aRender() in tools/demo-test.mjs and
// native-sanitize/i_video.c — ensures apples-to-apples golden comparison.
int fs_palette_version_get(void)
{
    return fs_palette_version;
}

unsigned fs_render_hash(void)
{
    unsigned   h   = 0x811c9dc5u;
    const byte* fb = screens[0];
    int        i;
    int        pv  = fs_palette_version;

    for (i = 0; i < SCREENWIDTH * SCREENHEIGHT; i++)
        h = (h ^ (unsigned)fb[i]) * 0x01000193u;

    h = (h ^ (unsigned)(pv        & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned)((pv >>  8) & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned)((pv >> 16) & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned)((pv >> 24) & 0xff)) * 0x01000193u;

    return h;
}
