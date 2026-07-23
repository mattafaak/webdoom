// tools/n64/i_video_n64.c — N64 software rasterizer shim (20.4b).
//
// Scope: software rasterizer only.  RDP (hardware-accelerated) path is
// deferred to 20.5 per the DoD.  The framebuffer lives in RDRAM as a
// palette-index array (screens[0]); no conversion to RGB565 is performed.
//
// I_FinishUpdate stores the rendered frame in a static shadow buffer.
// This confirms the software rasterizer produces output without needing
// a display or RDP.  On real N64 hardware with a future 20.5 RDP shim,
// replace n64_display_update() with an RDP palette-expand blit.
//
// Engine/core: 0-diff.  Only tools/n64/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include "doomdef.h"
#include "i_video.h"

// Active palette: 256 RGB triplets (768 bytes).
static byte n64_pal_rgb[768];

// Shadow framebuffer in RDRAM (320×200 palette indices = 64,000 bytes).
// Sufficient for software rasterizer output validation.
// Future 20.5 RDP path: convert to RGB565 via n64_pal_rgb and DMA blit.
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
// RDP 20.5: replace with hardware palette expand + DMA to VI framebuffer.
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
