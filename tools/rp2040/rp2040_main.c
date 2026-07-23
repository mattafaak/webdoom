// tools/rp2040/rp2040_main.c — RP2040 entry point shim.
//
// On a real Pico board with pico-sdk, this file would be replaced by the SDK's
// main() (which calls main() after core0 startup) and the board init sequence.
// For the footprint build (no pico-sdk), we provide a POSIX-compatible main()
// that feeds a mock WHD blob and calls D_DoomMain — sufficient to measure the
// linker output and exercise the shim layer in a simulator.
//
// BLOCKED: actual RP2040 boot requires pico-sdk.  See docs/rp2040/BRING-UP.md.
//
// WAD/WHD loading: on real hardware the blob is XIP-mapped in flash.
// Here we pass a NULL pointer of known length to satisfy the registry call
// without requiring a real WAD file (the linker output is the goal).
//
// Engine/core: 0-diff.  Only tools/rp2040/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include <setjmp.h>

#include "doomtype.h"
#include "doomdef.h"
#include "m_argv.h"
#include "rp2040_platform.h"   /* rp2040_register_whd, smoothrender, wipeactive */
#include "web.h"               /* D_DoomMain, D_DoomFrame */

/* Argv for D_DoomMain: timedemo demo3 in single-player. */
static const char* rp2040_argv[] = {
    "rp2040-doom",
    "-timedemo", "demo3",
    NULL
};

// On bare-metal there is no OS-provided stack or argc/argv.
// The pico-sdk startup calls main(void); adapt here.
int main(void)
{
    // Register a null WHD blob — replace with the XIP flash address in a real
    // deployment: rp2040_register_whd((const byte*)0x10010000, WHD_SIZE);
    rp2040_register_whd(NULL, 0);

    // Set up a minimal argv that DOOM's arg parser (m_argv.c) can consume.
    myargc = 3;
    myargv = (char**)rp2040_argv;

    // Suppress screen wipes and smooth-render interpolation (deterministic demo).
    smoothrender = 0;
    wipeactive   = 0;

    rp2040_timedemo_active   = 0;
    rp2040_timedemo_gametics = 0;

    // Call the engine entry point — this is the critical milestone:
    // the engine reaches D_DoomMain with the RP2040 shim layer.
    if (setjmp(rp2040_demo_jmp) != 0) {
        // Demo completed via longjmp from I_Error — normal exit path.
        return 0;
    }

    D_DoomMain();

    // Bare-metal: if D_DoomMain ever returns (it normally never does), spin.
    for (;;) {}
    return 0;
}
