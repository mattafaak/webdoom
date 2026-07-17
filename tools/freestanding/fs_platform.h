// tools/freestanding/fs_platform.h — shared state for the freestanding
// platform layer (rung 1: hosted, but narrowed surface).
// Not included by engine/core code — platform-layer-internal only.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __FS_PLATFORM_H__
#define __FS_PLATFORM_H__

#include <setjmp.h>
#include "doomdef.h"

// Timedemo exit mechanism: identical pattern to native-sanitize/nat_platform.h.
// When I_Error("timed %i gametics in %i realtics",...) fires, I_Error detects
// the pattern, stores the gametic count, and longjmps here instead of aborting.
extern volatile int fs_timedemo_active;
extern volatile int fs_timedemo_gametics;
extern jmp_buf      fs_demo_jmp;

// ── The byte-out primitive (rung-1: write(1,...)) ────────────────────────────
// All platform payload output funnels through fs_putc.
// In rung 2 (bare-metal), replace the body with a UART/SWO write.
void fs_putc(int c);

// ── WAD blob registry ────────────────────────────────────────────────────────
// Called by main() (the host shim) BEFORE D_DoomMain to hand the preloaded
// WAD blob to the platform layer.  files.c serves W_WebFile calls from it.
// After this call, no open/read occurs inside the platform layer.
void fs_register_wad(const char* name, byte* data, int len);

// d_main.c (webdoom split-loop patch).
void D_DoomFrame(void);

// Smoothrender and wipeactive: suppress non-deterministic wipes in demo mode.
extern boolean smoothrender;
extern boolean wipeactive;

#endif
