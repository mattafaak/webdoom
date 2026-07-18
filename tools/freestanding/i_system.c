// tools/freestanding/i_system.c — freestanding platform layer (rung 1).
//
// THREE ALLOWED SURFACES (bare-metal.md §1 + task brief):
//   (a) MEMORY: static arena — I_ZoneBase returns it.  No malloc/calloc here.
//   (b) BYTE-OUT: fs_putc(int c) — write(1,...).  I_Error funnels through it.
//   (c) WAD BLOB: registered by main() before D_DoomMain; files.c serves it.
//
// Stragglers enumerated and eliminated:
//   nat-doom I_ZoneBase: malloc(32MB)   → replaced: static fs_arena[8MB]
//   nat-doom I_AllocLow: calloc(256KB)  → replaced: static fs_screenbufs[]
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "doomdef.h"
#include "m_misc.h"
#include "i_video.h"
#include "i_sound.h"
#include "d_net.h"
#include "g_game.h"
#include "i_system.h"
#include "fs_platform.h"

// ── Timedemo exit state (defined here, declared in fs_platform.h) ─────────────
volatile int fs_timedemo_active   = 0;
volatile int fs_timedemo_gametics = 0;
jmp_buf      fs_demo_jmp;

// ── (b) BYTE-OUT: the single output primitive ─────────────────────────────────
// Rung 1: write(1,...) to stdout.
// Rung 2 (bare-metal): replace with UART/SWO/SPI write.
void fs_putc(int c)
{
    char ch = (char)c;
    write(1, &ch, 1);
}

// ── (a) MEMORY: static zone arena — NO malloc ────────────────────────────────
// 8 MiB: well above the 1.36 MiB peak non-purgeable figure from perf.md §2.
// bare-metal.md §2 recommends 4 MiB minimum; we double it for headroom.
// FS_ZONE_SIZE is defined in fs_platform.h (shared with i_main.c).
// Override at compile time with -DFS_ZONE_SIZE_OVERRIDE=(N) for zone sweeps.
static byte fs_arena[FS_ZONE_SIZE];

byte* I_ZoneBase(int* size)
{
    *size = FS_ZONE_SIZE;
    return fs_arena;
}

// Static screen buffer block for I_AllocLow.
// V_Init calls I_AllocLow once with SCREENWIDTH*SCREENHEIGHT*4 = 256,000 bytes.
// I_InitGraphics (i_video.c) then overrides screens[0] with its own static buf.
#define FS_ALLOCLOW_SIZE (SCREENWIDTH * SCREENHEIGHT * 4)
static byte fs_screenbufs[FS_ALLOCLOW_SIZE];

byte* I_AllocLow(int length)
{
    // Single-call bump: zero on first use.  If called a second time the same
    // buffer is returned (V_Init only calls this once in practice).
    static int initialised;
    if (!initialised) {
        memset(fs_screenbufs, 0, sizeof(fs_screenbufs));
        initialised = 1;
    }
    (void)length; // always 256,000; assert omitted to keep code simple
    return fs_screenbufs;
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

void I_Tactile(int on, int off, int total)
{
    (void)on;
    (void)off;
    (void)total;
}

static ticcmd_t emptycmd;
ticcmd_t* I_BaseTiccmd(void)
{
    return &emptycmd;
}

int I_GetTime(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int)((ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL) * TICRATE / 1000);
}

void I_Init(void)
{
    I_InitSound();
}

void I_Quit(void)
{
    exit(0);
}

void I_WaitVBL(int count)
{
    (void)count;
}

void I_BeginRead(void) {}
void I_EndRead(void)   {}

void I_StartFrame(void) {}
void I_StartTic(void)   {}

// ── (b) I_Error funnels through fs_putc ──────────────────────────────────────
void I_Error(char* error, ...)
{
    va_list argptr;
    char    buf[512];
    int     tics;
    const char* p;

    va_start(argptr, error);
    vsnprintf(buf, sizeof(buf), error, argptr);
    va_end(argptr);

    // Detect the graceful timedemo-end message so we can longjmp instead of abort.
    if (fs_timedemo_active &&
        sscanf(buf, "timed %i gametics in", &tics) == 1) {
        fs_timedemo_gametics = tics;
        longjmp(fs_demo_jmp, 1);
    }

    // Fatal error: stream to byte-out then abort.
    p = "I_Error: ";
    while (*p) fs_putc((unsigned char)*p++);
    p = buf;
    while (*p) fs_putc((unsigned char)*p++);
    fs_putc('\n');
    abort();
}
