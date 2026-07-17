// tools/baremetal/i_main.c — bare-metal entry point (rung 2).
//
// Called from crt0.S as bm_main() — no argc/argv, no OS, no file I/O.
//
// STARTUP SEQUENCE:
//   1. Announce boot over UART.
//   2. Register the WAD blob baked into .data via objcopy (fs_register_wad).
//   3. Run D_DoomMain() + D_DoomFrame() loop (-timedemo demo1).
//   4. On timedemo completion, stream per-tic sim hashes as JSON over UART.
//   5. Print "DEMO-DONE" sentinel and halt.
//
// The WAD is embedded by the Makefile via:
//   arm-none-eabi-objcopy -I binary -O elf32-littlearm -B arm \
//       wads/lib/doom.wad wad.o
// (run from the repo root so symbol names stay clean):
//   _binary_wads_lib_doom_wad_start / _binary_wads_lib_doom_wad_end
//
// Per-tic hash algorithm: identical to fs_state_hash() in freestanding/i_main.c
// and to web_state_hash() in the web layer — required for bit-identical golden
// comparison.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <setjmp.h>
#include <stdio.h>
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "m_argv.h"
#include "fs_platform.h"
#include "web.h"

extern int prndindex;

// ── Baked WAD symbols (from objcopy wad.o) ───────────────────────────────────
extern unsigned char _binary_wads_lib_doom_wad_start[];
extern unsigned char _binary_wads_lib_doom_wad_end[];

// ── Sim hash ─────────────────────────────────────────────────────────────────
// Identical algorithm to freestanding/i_main.c fs_state_hash() and
// native-sanitize/nat_platform.c nat_state_hash(): same field order, same FNV.
static int bm_state_hash(void)
{
    unsigned h = 0x9e3779b9u ^ (unsigned)gametic;
    int      i;

    h = (h ^ (unsigned)prndindex) * 0x01000193u;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && players[i].mo) {
            h = (h ^ (unsigned)players[i].mo->x)     * 0x01000193u;
            h = (h ^ (unsigned)players[i].mo->y)     * 0x01000193u;
            h = (h ^ (unsigned)players[i].mo->angle) * 0x01000193u;
            h = (h ^ (unsigned)players[i].health)    * 0x01000193u;
        }
    return (int)h;
}

// ── UART helpers ─────────────────────────────────────────────────────────────
static void bm_putu(unsigned u)
{
    char buf[12];
    int  n = 0;
    if (u == 0) { fs_putc('0'); return; }
    while (u) { buf[n++] = (char)('0' + u % 10); u /= 10; }
    while (n--) fs_putc(buf[n]);
}

static void bm_puts(const char* s)
{
    while (*s) fs_putc((unsigned char)*s++);
}

// Stream {"tics":N,"trace":[...]} via fs_putc (PL011 UART).
// JSON shape identical to freestanding/i_main.c so compare.py works directly.
static void stream_sim_json(int tics, const int* trace, int n)
{
    int i;
    bm_puts("{\"tics\":");
    bm_putu((unsigned)tics);
    bm_puts(",\"trace\":[");
    for (i = 0; i < n; i++) {
        bm_putu((unsigned)trace[i]);
        if (i + 1 < n) fs_putc(',');
    }
    bm_puts("]}\n");
}

// ── Trace buffer (demo1 has 1710 tics; 2048 gives headroom) ─────────────────
#define BM_MAX_TRACE 2048
static int bm_trace[BM_MAX_TRACE];
static int bm_trace_len;
static int bm_last_tic;

// ── argv for DOOM (-timedemo demo1, no WAD path since files.c serves it) ─────
static const char* bm_argv[] = { "bm-doom", "-timedemo", "demo1" };

// ── bm_main: C entry called from crt0.S ──────────────────────────────────────
void bm_main(void)
{
    int wad_len = (int)(_binary_wads_lib_doom_wad_end
                        - _binary_wads_lib_doom_wad_start);

    // (1) Announce.
    bm_puts("BM-DOOM-BOOT\n");

    // Disable stdio buffering so all printf output is immediately written to UART.
    // Without this, newlib may buffer output and we lose visibility into hangs.
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    // (2) Register baked WAD blob with files.c.
    fs_register_wad("doom.wad",
                    (byte*)_binary_wads_lib_doom_wad_start,
                    wad_len);

    // (3) Set up DOOM args.
    myargc = 3;
    myargv = (char**)bm_argv;

    // (4) Init timedemo state.
    fs_timedemo_active   = 1;
    fs_timedemo_gametics = 0;
    bm_trace_len         = 0;
    bm_last_tic          = -1;

    // (5) Run until timedemo I_Error longjmps back here.
    if (setjmp(fs_demo_jmp) != 0)
        goto done;

    bm_puts("BM:D_DoomMain-start\n");
    D_DoomMain();
    bm_puts("BM:D_DoomMain-done\n");

    // Disable smooth render interpolation (non-deterministic wall-clock drift).
    smoothrender = false;

    for (;;) {
        wipeactive = 0;
        D_DoomFrame();

        if (gametic != bm_last_tic) {
            if (bm_trace_len < BM_MAX_TRACE)
                bm_trace[bm_trace_len++] = bm_state_hash();
            bm_last_tic = gametic;
        }
    }

done:
    // (6) Stream per-tic hashes over UART in JSON format then halt.
    fs_timedemo_active = 0;
    stream_sim_json(fs_timedemo_gametics, bm_trace, bm_trace_len);
    bm_puts("DEMO-DONE\n");

    for (;;) {}
}
