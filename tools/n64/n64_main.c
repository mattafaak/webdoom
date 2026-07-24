// tools/n64/n64_main.c — N64 libdragon entry point for webdoom.
//
// Boot sequence:
//   1. libdragon's _start (entrypoint.S) sets up CPU, FPU, cache, interrupts.
//   2. libdragon calls main() from the C runtime.
//   3. main() initialises the ISViewer UART channel (ares debugf output).
//   4. main() registers the WAD blob (NULL for footprint build).
//   5. main() calls D_DoomMain() — engine entry point.
//
// The D_DoomMain startup banner is printed via printf() → stderr →
// ISViewer → ares UART pane.  This is the "boot to banner" DoD milestone.
//
// WAD: libdragon DFS (DragonFS) or baked blob in ROM are both viable paths.
//   This build uses a NULL blob to verify the engine reaches D_DoomMain.
//   Real deployment: mount DFS, open doom1.wad via dragonfs, pass pointer.
//
// Software rasterizer only.  RDP path deferred to 20.5.
// Engine/core: 0-diff.  Only tools/n64/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
/* Include only the specific libdragon headers we need (not the catch-all
 * <libdragon.h>) to avoid multiple-definition of rdpq_font_load_builtin. */
#include <debug.h>    /* debug_init, debugf */
#include <n64sys.h>   /* get_ticks, TICKS_PER_SECOND */
#include <string.h>
#include <setjmp.h>

#include "doomtype.h"
#include "doomdef.h"
#include "d_main.h"   /* D_DoomMain */
#include "m_argv.h"
#include "n64_platform.h"

/* Argv for D_DoomMain.  No -timedemo for banner-only check; add to exercise
 * the demo loop once a WAD blob is registered. */
static const char* n64_argv[] = {
    "n64-doom",
    NULL
};

int main(void)
{
    // ── Step 1: UART output to ares ISViewer ────────────────────────────────
    // All printf / fprintf(stderr,...) now appear in the ares UART pane.
    n64_debug_init();

    debugf("N64 webdoom boot: initialising shim layer\n");

    // ── Step 2: WAD blob registration ────────────────────────────────────────
    // The IWAD is appended into the ROM image by n64tool at N64_WAD_OFFSET and
    // read IN PLACE from cartridge space — it is far too large to copy into
    // RDRAM (doom.wad is 12,408,292 B; the console has 4 MB, 8 MB with an
    // Expansion Pak, and the engine already holds ~990 KB of that).
    //
    // Cartridge domain 1 is physical 0x10000000. We address it through KSEG1
    // (0xA0000000 + physical), which is UNCACHED — mandatory here, because the
    // CPU must not cache lines from a region it never writes.
    //
    // N64_WAD_LEN is 0 for a footprint-only build, in which case nothing is
    // registered and IdentifyVersion() reports an indeterminate game mode.
#if N64_WAD_LEN > 0
    {
        /* Locate the WAD by scanning cartridge space for its magic rather than
           trusting a compile-time offset. n64tool's --offset is expressed in
           N64 memory terms, not file position, so the WAD does not land where
           a naive byte offset would predict — an earlier build looked at
           0xB0200000 and found zeroes while the WAD sat at 0xB00433F0.
           n64tool aligns payloads (we pass --align 256), and the WAD always
           follows the ELF, so a coarse aligned scan over the low megabyte
           finds it in a few thousand reads and stays correct as the shim's
           size changes. */
        const unsigned int   base = 0xA0000000u + 0x10000000u;   /* KSEG1 cart domain 1 */
        const byte* wad  = NULL;
        unsigned int off;
        for (off = 0x1000; off < 0x400000u; off += 0x100) {
            const volatile unsigned int* p = (const volatile unsigned int*)(base + off);
            if (*p == 0x49574144u) {                    /* "IWAD" big-endian */
                wad = (const byte*)(base + off);
                break;
            }
            if (*p == 0x50574144u) {                    /* "PWAD" */
                wad = (const byte*)(base + off);
                break;
            }
        }
        if (wad) {
            debugf("N64 webdoom: WAD %s @ %p len %d\n",
                   N64_WAD_NAME, wad, (int)N64_WAD_LEN);
            n64_register_wad(wad, (int)N64_WAD_LEN);
        } else {
            debugf("N64 webdoom: WAD magic not found in cartridge scan\n");
            n64_register_wad(NULL, 0);
        }
    }
#else
    debugf("N64 webdoom: footprint-only build, no WAD embedded\n");
    n64_register_wad(NULL, 0);
#endif

    // ── Step 3: argv ─────────────────────────────────────────────────────────
    myargc = 1;
    myargv = (char**)n64_argv;

    // ── Step 4: suppress non-deterministic display paths ────────────────────
    smoothrender = 0;
    wipeactive   = 0;

    n64_timedemo_active   = 0;
    n64_timedemo_gametics = 0;

    // ── Step 5: engine entry point ───────────────────────────────────────────
    // D_DoomMain prints the startup title banner (d_main.c:796):
    //   printf("%s\n", title)  → stderr → ISViewer → ares UART
    // This is the primary DoD milestone for 20.4b.
    if (setjmp(n64_demo_jmp) != 0) {
        // Demo completed via longjmp from I_Error — normal exit path.
        debugf("N64 webdoom: demo completed normally\n");
        // Spin: bare-metal N64 has no OS to return to.
        for (;;) {}
    }

    D_DoomMain();

    // D_DoomMain never returns in normal operation; spin if it does.
    for (;;) {}
    return 0;
}
