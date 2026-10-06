// tools/n64/i_video_n64.c — N64 software rasterizer shim.
//
// Scope: software rasterizer only; there is no RDP (hardware-accelerated)
// path.  The framebuffer lives in RDRAM as a
// palette-index array (screens[0]); no conversion to RGB565 is performed.
//
// I_FinishUpdate stores the rendered frame in a static shadow buffer.
// This confirms the software rasterizer produces output without needing
// a display or RDP.  A display path on real hardware would replace
// n64_display_update() with an RDP palette-expand blit.
//
// engine/core has no N64-specific changes; the port is tools/n64/.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include "doomdef.h"
#include "i_video.h"

// Active palette: 256 RGB triplets (768 bytes).
static byte n64_pal_rgb[768];

// Shadow framebuffer in RDRAM (320×200 palette indices = 64,000 bytes).
// Sufficient for software rasterizer output validation.
// An RDP path would convert to RGB565 via n64_pal_rgb and DMA blit.
static byte n64_shadow_fb[320 * 200];

// Frame counter: incremented by I_FinishUpdate.
// Write to ISViewer (debugf) to verify frame loop progress in ares.
static unsigned int n64_frame_count = 0;

void I_InitGraphics(void)
{
    memset(n64_pal_rgb, 0, sizeof(n64_pal_rgb));
    memset(n64_shadow_fb, 0, sizeof(n64_shadow_fb));
    n64_frame_count = 0;
}

void I_ShutdownGraphics(void) {}

// Store the 768-byte active palette for future RDP palette-expand blit.
void I_SetPalette(byte* palette)
{
    memcpy(n64_pal_rgb, palette, 768);
}

// Copy the software-rasterized frame (screens[0]) to RDRAM shadow buffer.
// An RDP path would replace this with a hardware palette expand + DMA to the VI framebuffer.
void I_FinishUpdate(void)
{
    extern byte* screens[];
    if (screens[0])
        memcpy(n64_shadow_fb, screens[0], sizeof(n64_shadow_fb));
    n64_frame_count++;
}

void I_UpdateNoBlit(void) {}

void I_ReadScreen(byte* scr)
{
    if (scr)
        memcpy(scr, n64_shadow_fb, sizeof(n64_shadow_fb));
}
