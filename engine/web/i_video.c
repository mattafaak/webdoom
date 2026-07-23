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
// Sized to MAXSCREENWIDTH; only the first screenwidth columns are populated.
static byte web_rowmajor_buf[MAXSCREENWIDTH * SCREENHEIGHT];

#ifdef WEBDOOM_DIFFBLIT
/* --- 20.3d WEBDOOM_DIFFBLIT: differential blit behind compile-time toggle ---
   Column-major snapshot of the previous frame (same layout as screens[0]).
   I_FinishUpdate compares each column against the snapshot; columns whose
   SCREENHEIGHT-byte content is unchanged skip the column-major → row-major
   transpose into web_rowmajor_buf, saving memory-write bandwidth on frames
   where large fractions of the screen are stationary.
   FastDoom analogue: VGA dirty-column blit tracking (column-major → row-major
   transpose ≡ VGA column blit; changed columns only ≡ dirty-page tracking).
   Trade-off: one memcmp(SCREENHEIGHT bytes) overhead per column per frame.
   For timedemo (camera in motion, ~100% columns dirty every tic) comparison
   cost exceeds savings — measured negative for timedemo, expected positive
   for real-play static scenes (open menus, spectating, stationary view).
   Invalidation uses an explicit web_prev_valid flag, not a sentinel byte
   pattern: any fill value could legitimately occur as a full column of
   screens[0], which would make memcmp report "unchanged" and leave a stale
   wrong-stride column in web_rowmajor_buf. The flag has no such collision.
   web_prev_screenwidth starts at 0 (less than any real screenwidth) so the
   first call always invalidates, and every screenwidth change invalidates
   again so the buffer is re-transposed with the correct row stride. */
static byte web_prev_col[MAXSCREENWIDTH * SCREENHEIGHT];
static int web_prev_screenwidth; /* 0 at startup → force full refresh */
static int web_prev_valid;       /* snapshot usable for skip decisions */
#endif                           /* WEBDOOM_DIFFBLIT */
/* Reset line counter so the toggle-off binary stays byte-identical to master.
   void I_InitGraphics was at physical line 25 — update if i_video.c moves. */
#line 25
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
#ifdef WEBDOOM_DIFFBLIT
    if (screenwidth != web_prev_screenwidth)
    {
        /* Width change or first call: every column must be re-transposed
           with the new stride, so no skip may fire this frame. */
        web_prev_valid = 0;
        web_prev_screenwidth = screenwidth;
    }
    for (x = 0; x < screenwidth; x++)
    {
        const byte* col = src + x * SCREENHEIGHT;
        byte* prv = web_prev_col + x * SCREENHEIGHT;
        if (web_prev_valid && memcmp (col, prv, SCREENHEIGHT) == 0)
            continue;                    /* column unchanged — skip transpose */
        memcpy (prv, col, SCREENHEIGHT); /* update snapshot */
        for (y = 0; y < SCREENHEIGHT; y++)
            web_rowmajor_buf[y * screenwidth + x] = col[y];
    }
    web_prev_valid = 1;
#else
#line 45
    for (x = 0; x < screenwidth; x++)
    {
        const byte* col = src + x * SCREENHEIGHT;
        for (y = 0; y < SCREENHEIGHT; y++)
            web_rowmajor_buf[y * screenwidth + x] = col[y];
    }
#endif /* WEBDOOM_DIFFBLIT */
#line 51
}

void I_ReadScreen (byte* scr)
{
    // Copy raw column-major bytes; callers (wipe, screenshot) handle layout.
    memcpy (scr, screens[0], screenwidth * SCREENHEIGHT);
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
