// tools/baremetal/fs_platform.h — shared state for the bare-metal platform layer.
// Mirror of tools/freestanding/fs_platform.h; only fs_putc body differs.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __FS_PLATFORM_H__
#define __FS_PLATFORM_H__

#include <setjmp.h>
#include "doomdef.h"

// Timedemo exit mechanism: identical pattern to freestanding/fs_platform.h.
// When I_Error("timed %i gametics in %i realtics",...) fires, I_Error detects
// the pattern, stores the gametic count, and longjmps here instead of halting.
extern volatile int fs_timedemo_active;
extern volatile int fs_timedemo_gametics;
extern jmp_buf      fs_demo_jmp;

// ── The byte-out primitive (bare-metal: PL011 UART at 0x09000000) ────────────
// All platform output funnels through fs_putc.
void fs_putc(int c);

// ── WAD blob registry ────────────────────────────────────────────────────────
// Called before D_DoomMain to hand the baked WAD blob to the platform layer.
// files.c serves W_WebFile calls from it.
void fs_register_wad(const char* name, byte* data, int len);

// d_main.c (webdoom split-loop patch).
void D_DoomFrame(void);

// Smoothrender and wipeactive: suppress non-deterministic wipes in demo mode.
extern boolean smoothrender;
extern boolean wipeactive;

#endif
