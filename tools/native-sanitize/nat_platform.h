// native-sanitize nat_platform.h — shared state between i_main.c and i_system.c.
// Not included by engine/core code.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __NAT_PLATFORM_H__
#define __NAT_PLATFORM_H__

#include <setjmp.h>
#include "doomdef.h"

// When the timedemo ends, G_CheckDemoStatus calls I_Error("timed %i gametics
// in %i realtics", gametic, realtics). I_Error checks this flag; if non-zero
// it treats the message as a graceful exit: stores the gametic count and
// longjmps back to nat_demo_jmp instead of aborting.
extern volatile int nat_timedemo_active;
extern volatile int nat_timedemo_gametics;
extern jmp_buf      nat_demo_jmp;

// FNV-1a hash of screens[0] (64000 bytes) folded with paletteversion.
// Defined in i_video.c; called by i_main.c once per new gametic.
unsigned nat_render_hash (void);

// Expose the palette version counter so i_main.c can include it in the hash.
int      nat_palette_version (void);

// WAD search directory — set by i_main.c before D_DoomMain, read by files.c.
extern const char* nat_wad_dir;

// smoothrender and wipeactive are defined in d_main.c / r_main.c; we just
// reference them from i_main.c to set them before the demo loop.
extern boolean smoothrender;
extern boolean wipeactive;

// D_DoomFrame is declared in d_main.c (webdoom split-loop patch).
void D_DoomFrame (void);

#endif
