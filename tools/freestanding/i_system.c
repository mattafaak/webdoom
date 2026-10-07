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

// WD_ZONE_KB=<n> hands the engine only the first n KiB of the arena, so one
// binary can bisect the smallest zone that still completes a demo correctly.
int fs_zone_bytes = FS_ZONE_SIZE;

byte* I_ZoneBase(int* size)
{
    const char* kb = getenv("WD_ZONE_KB");
    if (kb && atoi(kb) > 0 && (long)atoi(kb) * 1024 < (long)FS_ZONE_SIZE)
        fs_zone_bytes = atoi(kb) * 1024;
    *size = fs_zone_bytes;
    return fs_arena;
}

// Static screen buffer block for I_AllocLow.
// V_Init calls I_AllocLow once with SCREENWIDTH*SCREENHEIGHT*4 = 256,000 bytes.
// I_InitGraphics (i_video.c) then overrides screens[0] with its own static buf.
#define FS_ALLOCLOW_SIZE (SCREENWIDTH * SCREENHEIGHT * 4)
/* 4-byte alignment required: wipe code casts (byte*) to (short*) for column-
 * major transform; if the buffer starts at an unaligned address the lhu/sh
 * instructions trap on strict-alignment targets (MIPS, ARM Cortex-M). */
static byte fs_screenbufs[FS_ALLOCLOW_SIZE] __attribute__((aligned(4)));

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

// I_GetTime, in 35 Hz tics, three ways:
//
// - A timedemo runs on a virtual clock, one tic per tic: I_GetTime is gametic.
//   The sim never reads the clock (singletics), but NetUpdate does.  The
//   renderer and D_Display call it mid-frame, and it does a ticcmd iteration for
//   every tic of time that has passed.  On a real clock that work landed
//   wherever the clock happened to tick: zero on an idle x86 host, up to 35
//   iterations (19,139 instructions, measured) after the process was
//   descheduled, and on tools/cortexm's emulated clock in 7% of tics.  So counts
//   moved between identical runs, and the worst tic could miss work a target
//   pays.  On the virtual clock it is one iteration per tic, as on a target
//   that runs at 35 Hz, and every count repeats.  WD_REAL_CLOCK=1 (where the
//   port has an environment) restores the clock below.
// - A port with a free-running hardware counter defines FS_GET_TIME as the name
//   of `int FS_GET_TIME (void)`, the time in 35 Hz tics.  NetUpdate calls
//   I_GetTime about five times a tic, so the clock_gettime form, with its 64-bit
//   divides, would charge each tic the platform's arithmetic rather than the
//   engine's (tools/cortexm measured ~1,000 ARMv6-M instructions a call).
// - Otherwise, clock_gettime.
extern int gametic;
#ifdef FS_GET_TIME
int FS_GET_TIME (void);
#endif

int I_GetTime(void)
{
    static int real = -1;
    if (real < 0)
        real = getenv("WD_REAL_CLOCK") && getenv("WD_REAL_CLOCK")[0] == '1';
    if (fs_timedemo_active && !real)
        return gametic;
#ifdef FS_GET_TIME
    return FS_GET_TIME ();
#else
    {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        return (int)((ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL) * TICRATE / 1000);
    }
#endif
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
