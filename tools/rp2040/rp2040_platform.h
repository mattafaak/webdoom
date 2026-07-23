// tools/rp2040/rp2040_platform.h — RP2040 (Cortex-M0+) platform shim header.
//
// PURPOSE: minimum definitions for compiling engine/core against the RP2040
// platform shim.  Mirrors the role of tools/freestanding/fs_platform.h in the
// hosted-freestanding (rung-1) build, adapted for bare-metal (rung-2).
//
// SCOPE CAVEAT (20.7a): pico-sdk is not installed; no real boot occurs.
// This shim exists to enable (a) Cortex-M0+ cross-compilation of engine/core,
// (b) footprint measurement via arm-none-eabi-size, and (c) the WHD asset
// pipeline.  The BLOCKED items are enumerated in docs/rp2040/BRING-UP.md.
//
// Engine/core: 0-diff.  Only tools/rp2040/ and docs/rp2040/ are new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __RP2040_PLATFORM_H__
#define __RP2040_PLATFORM_H__

/* doomdef.h has #include "doomtype.h" commented-out; include directly. */
#include "doomtype.h"

// ── Zone pool size ───────────────────────────────────────────────────────────
// FOOTPRINT BUILD: 256 KB token to keep the shim compilable.
//   Enough to confirm the shim links and get arm-none-eabi-size readings.
//   Not enough to run DOOM (minimum non-purgeable HWM = 1,004 KB per
//   tools/golden/zone-stats.json tnt-demo2 worst case).
// Override at build time: make RP2040_ZONE_KB=512
#ifndef RP2040_ZONE_KB
#define RP2040_ZONE_KB 256
#endif
#define RP2040_ZONE_SIZE ((RP2040_ZONE_KB) * 1024)

// ── Byte-out primitive ───────────────────────────────────────────────────────
// Replace body with UART/SWO write when pico-sdk is available.
// Current stub: no-op so the shim compiles without SDK headers.
void rp2040_putc(int c);

// ── WAD blob registry ────────────────────────────────────────────────────────
// On RP2040, the WHD blob lives in flash (XIP-mapped).
// Callers use rp2040_register_whd() before D_DoomMain.
void rp2040_register_whd(const byte* data, int len);

// ── Timedemo exit mechanism (mirrors fs_platform.h) ──────────────────────────
// Required by i_system_rp2040.c I_Error to detect graceful demo-end.
// On bare-metal with no OS, we use abort() for fatal errors and
// longjmp for demo-end detection — same as the hosted freestanding build.
#include <setjmp.h>
extern volatile int rp2040_timedemo_active;
extern volatile int rp2040_timedemo_gametics;
extern jmp_buf      rp2040_demo_jmp;

// Screen buffers (fixed allocation, no malloc).
// V_Init calls I_AllocLow once with MAXSCREENWIDTH*SCREENHEIGHT*4.
// With MAXSCREENWIDTH=320, SCREENHEIGHT=200: 256,000 bytes.
#define RP2040_ALLOCLOW_SIZE (320 * 200 * 4)

// Smooth-render and wipe suppression (demo-mode).
extern boolean smoothrender;
extern boolean wipeactive;

#endif /* __RP2040_PLATFORM_H__ */
