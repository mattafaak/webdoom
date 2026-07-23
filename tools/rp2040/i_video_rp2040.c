// tools/rp2040/i_video_rp2040.c — RP2040 video shim (headless, footprint build).
//
// This is a working implementation for the headless/footprint-build context:
// no SPI LCD is attached, so I_FinishUpdate stores the rendered frame in a
// static shadow buffer and I_SetPalette stores the active palette.
// Both functions compile and operate without pico-sdk.
//
// When a physical LCD is wired up (ILI9341 or similar via SPI):
//   Replace rp2040_display_update() with a DMA blit through rp2040_pal_rgb565.
//   At 35 Hz and 320x200 = 64,000 bytes/frame this is 2.24 MB/s —
//   within SPI range at 20+ MHz.
//
// Engine/core: 0-diff.  Only tools/rp2040/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include "doomdef.h"
#include "i_video.h"

// Active palette: 256 RGB triplets (768 bytes).
static byte rp2040_pal_rgb[768];

// Shadow framebuffer: one screen worth of palette indices (64,000 bytes).
// Allows footprint measurement without needing screens[0] to be valid yet.
static byte rp2040_shadow_fb[320 * 200];

// Frame counter incremented by I_FinishUpdate.
// Useful for profiling: write this to UART to confirm frame loop progress.
static unsigned int rp2040_frame_count = 0;

void I_InitGraphics(void)
{
    memset(rp2040_pal_rgb, 0, sizeof(rp2040_pal_rgb));
    memset(rp2040_shadow_fb, 0, sizeof(rp2040_shadow_fb));
    rp2040_frame_count = 0;
}

void I_ShutdownGraphics(void) {}

void I_SetPalette(byte* palette)
{
    // Store the 768-byte active palette for later use in I_FinishUpdate blit.
    memcpy(rp2040_pal_rgb, palette, 768);
}

// Called by D_Display after every render frame.
// Headless: copy screens[0] to rp2040_shadow_fb and increment the counter.
// With LCD: replace the memcpy with a DMA blit through rp2040_pal_rgb.
void I_FinishUpdate(void)
{
    extern byte* screens[];
    if (screens[0])
        memcpy(rp2040_shadow_fb, screens[0], sizeof(rp2040_shadow_fb));
    rp2040_frame_count++;
}

void I_UpdateNoBlit(void) {}

void I_ReadScreen(byte* scr)
{
    if (scr)
        memcpy(scr, rp2040_shadow_fb, sizeof(rp2040_shadow_fb));
}
