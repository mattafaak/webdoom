// wide-experiment/i_video.c — headless framebuffer for wide (854-px) ASan build.
// Extends native-sanitize/i_video.c with a PPM frame-dump hook used to capture
// the widescreen screenshot committed as task 18.2b visual evidence.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "v_video.h"
#include "i_video.h"
#include "nat_platform.h"

// screens[0]: column-major framebuffer (x*SCREENHEIGHT+y).
static byte screenbuf[MAXSCREENWIDTH * SCREENHEIGHT];

// Palette mirror + version counter.
static byte webpalette[768];   /* 256 * 3 */
static int  paletteversion;

// Frame-dump hook — set externally by i_main.c.
int  nat_dump_tic  = -1;         // tic at which to write a PPM
const char* nat_dump_path = NULL; // output path (NULL = disabled)

// Called once after PLAYPAL is loaded and on every flash/tint.
// gammatable is declared in v_video.c.
void I_InitGraphics (void)
{
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
    // If the dump tic has been reached, write a PPM screenshot.
    if (nat_dump_path && gametic == nat_dump_tic)
    {
        // De-transpose column-major framebuffer to row-major for PPM.
        int x, y;
        FILE* f = fopen (nat_dump_path, "wb");
        if (f)
        {
            fprintf (f, "P6\n%d %d\n255\n", screenwidth, SCREENHEIGHT);
            for (y = 0; y < SCREENHEIGHT; y++)
                for (x = 0; x < screenwidth; x++)
                {
                    byte idx = screenbuf[x * SCREENHEIGHT + y];
                    fputc (webpalette[idx * 3 + 0], f); /* R */
                    fputc (webpalette[idx * 3 + 1], f); /* G */
                    fputc (webpalette[idx * 3 + 2], f); /* B */
                }
            fclose (f);
            fprintf (stderr, "nat-doom-wide: wrote PPM → %s (tic %d, %dx%d)\n",
                     nat_dump_path, gametic, screenwidth, SCREENHEIGHT);
            nat_dump_path = NULL; // one-shot
        }
        else
            fprintf (stderr, "nat-doom-wide: cannot open %s\n", nat_dump_path);
    }
}

void I_ReadScreen (byte* scr)
{
    int x, y;
    for (y = 0; y < SCREENHEIGHT; y++)
        for (x = 0; x < screenwidth; x++)
            scr[y * screenwidth + x] = screenbuf[x * SCREENHEIGHT + y];
}

// ── render hash (same algorithm as native-sanitize) ─────────────────────────
unsigned nat_render_hash (void)
{
    unsigned h = 0x811c9dc5u;
    const byte* fb = screens[0];
    int x, y;
    int pv = paletteversion;

    for (y = 0; y < SCREENHEIGHT; y++)
        for (x = 0; x < screenwidth; x++)
            h = (h ^ (unsigned) fb[x * SCREENHEIGHT + y]) * 0x01000193u;

    h = (h ^ (unsigned) ( pv        & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned) ((pv >>  8) & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned) ((pv >> 16) & 0xff)) * 0x01000193u;
    h = (h ^ (unsigned) ((pv >> 24) & 0xff)) * 0x01000193u;

    return h;
}
