// tools/n64/n64_platform.h — N64 (MIPS R4300i) libdragon platform shim header.
//
// PURPOSE: minimum definitions for compiling engine/core against the N64
// libdragon platform shim.  Mirrors the role of tools/rp2040/rp2040_platform.h
// in the RP2040 bring-up, adapted for MIPS/libdragon bare-metal.
//
// SCOPE (20.4b): software rasterizer only; RDP deferred to 20.5.
//   WAD: NULL blob for footprint build; DFS-backed for real ROM deployment.
//   UART: libdragon debug_init_emulog() → ares ISViewer channel.
//   Engine/core: 0-diff.  Only tools/n64/ and docs/n64/ are new.
//
// ABI NOTE (docs/n64/MIPS-ABI-LANDMINES.md):
//   libdragon uses -mabi=o64 -march=vr4300 (ILP32, big-endian).
//   The engine's __BIG_ENDIAN__ swap path is active automatically (GCC
//   defines __BIG_ENDIAN__ on any big-endian target).  No core changes needed.
//
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __N64_PLATFORM_H__
#define __N64_PLATFORM_H__

#include "doomtype.h"

// ── Zone pool size ────────────────────────────────────────────────────────────
// N64 has 4 MB RDRAM (8 MB with Expansion Pak).  Zone sits in RDRAM.
// 512 KB is the footprint-build token: above the 262 KB non-purgeable peak
// (tools/golden/zone-stats.json) but keeps the full ROM under 4 MB.
// A real deployment needs at least 2 MB for gameplay + map loading.
// Override: make N64_ZONE_KB=2048
#ifndef N64_ZONE_KB
#define N64_ZONE_KB 512
#endif
#define N64_ZONE_SIZE ((N64_ZONE_KB) * 1024)

// ── Screen buffer size ────────────────────────────────────────────────────────
// Software rasterizer: 320×200 palette-index framebuffer.
// RDP output path is deferred to 20.5.
#define N64_ALLOCLOW_SIZE (320 * 200 * 4)

// ── UART byte-out primitive ───────────────────────────────────────────────────
// Uses libdragon's ISViewer channel (visible in ares UART pane).
// After n64_debug_init(), all fprintf(stderr,...) routes to ISViewer.
// Call n64_putc only for direct byte writes (e.g., I_Error).
void n64_putc(int c);
void n64_debug_init(void);

// ── WAD blob registry ─────────────────────────────────────────────────────────
// On real hardware, the WAD lives in ROM and is DMA-read via libdragon DFS.
// For the footprint build, pass NULL / len 0 to suppress WAD access.
void n64_register_wad(const byte* data, int len);

// ── Timedemo exit mechanism ───────────────────────────────────────────────────
// I_Error("timed %i gametics...") longjmps here on demo completion.
#include <setjmp.h>
extern volatile int n64_timedemo_active;
extern volatile int n64_timedemo_gametics;
extern jmp_buf      n64_demo_jmp;

// ── Smooth-render / wipe suppressors (demo-mode) ─────────────────────────────
extern boolean smoothrender;
extern boolean wipeactive;

#endif /* __N64_PLATFORM_H__ */
