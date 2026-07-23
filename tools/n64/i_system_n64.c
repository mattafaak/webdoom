// tools/n64/i_system_n64.c — N64 libdragon system shim.
//
// SURFACE CONTRACT (mirrors bare-metal.md §1 + rp2040 shim pattern):
//   (a) MEMORY: static zone arena — I_ZoneBase returns it.
//   (b) BYTE-OUT: n64_putc() → libdragon debugf (ISViewer channel).
//   (c) WAD BLOB: files_n64.c serves WAD from registered ROM blob.
//
// TIMING: I_GetTime uses libdragon get_ticks() / TICKS_PER_SECOND * 35.
//   On real hardware this is accurate.  In ares (35 Hz emulated), close enough
//   for timedemo playback.
//
// MEMORY BUDGET (docs/n64/BRING-UP.md §memory):
//   4 MB RDRAM total.
//   Zone arena (N64_ZONE_SIZE): 512 KB default.
//   Screen buffers (N64_ALLOCLOW_SIZE): 256 KB.
//   Stack + libdragon runtime: ~64 KB.
//   Remaining headroom: ~3.2 MB for heap/map data when WAD is in ROM.
//
// Engine/core: 0-diff.  Only tools/n64/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdarg.h>
#include <string.h>
#include <setjmp.h>
#include <stdlib.h>
#include <stdio.h>

/* Specific libdragon headers (not catch-all <libdragon.h>) to avoid
 * multiple-definition of rdpq_font_load_builtin across TUs. */
#include <debug.h>    /* debug_init, debugf */
#include <n64sys.h>   /* get_ticks, TICKS_PER_SECOND */

#include "doomtype.h"
#include "doomdef.h"
#include "m_misc.h"
#include "i_video.h"
#include "i_sound.h"
#include "d_net.h"
#include "g_game.h"
#include "i_system.h"
#include "n64_platform.h"

// ── Debug init ────────────────────────────────────────────────────────────────
// Call once from n64_main.c before any printf or debugf.
// debug_init_emulog() routes stderr to ares ISViewer (UART pane).
void n64_debug_init(void)
{
    debug_init(DEBUG_FEATURE_LOG_EMU);
}

// ── (b) BYTE-OUT ──────────────────────────────────────────────────────────────
// n64_putc: write one byte to the ISViewer channel.
// libdragon's debug_init_emulog() already routes fprintf(stderr,...);
// n64_putc is provided for direct byte-level I_Error output.
void n64_putc(int c)
{
    char ch = (char)c;
    // Write to stderr — libdragon routes this to ISViewer after debug_init.
    fwrite(&ch, 1, 1, stderr);
}

// ── Timedemo exit state ───────────────────────────────────────────────────────
volatile int n64_timedemo_active   = 0;
volatile int n64_timedemo_gametics = 0;
jmp_buf      n64_demo_jmp;

// ── (a) MEMORY: static zone arena ────────────────────────────────────────────
// N64_ZONE_SIZE default: 512 KB (RDRAM).  Enough for engine init and demo
// playback with a baked WAD blob.  See docs/n64/BRING-UP.md §zone-budget.
// Override: make N64_ZONE_KB=2048
static byte n64_arena[N64_ZONE_SIZE] __attribute__((aligned(8)));

byte* I_ZoneBase(int* size)
{
    *size = N64_ZONE_SIZE;
    return n64_arena;
}

// ── Screen buffers (V_Init calls I_AllocLow once) ────────────────────────────
// Software rasterizer: palette-index framebuffer in RDRAM.
// RDP path (direct colour output) deferred to 20.5.
// 320×200×4 = 256,000 bytes; 8-byte aligned for MIPS lw/sw safety.
static byte n64_screenbufs[N64_ALLOCLOW_SIZE] __attribute__((aligned(8)));

byte* I_AllocLow(int length)
{
    static int initialised;
    if (!initialised) {
        memset(n64_screenbufs, 0, sizeof(n64_screenbufs));
        initialised = 1;
    }
    (void)length;
    return n64_screenbufs;
}

// ── Timing ────────────────────────────────────────────────────────────────────
// I_GetTime: return tic count at TICRATE (35 Hz).
// get_ticks() returns CPU counter ticks (93.75 MHz / 2 = 46.875 MHz).
// TICKS_PER_SECOND = CPU_FREQUENCY / 2 (see n64sys.h).
//
// Formula: tic = ticks * TICRATE / TICKS_PER_SECOND
// To avoid 64-bit division on MIPS o32:  tic = ticks / (TICKS_PER_SECOND/35)
int I_GetTime(void)
{
    uint64_t t = get_ticks();
    // TICKS_PER_SECOND is ~46,875,000 on NTSC N64.
    // ticks_per_tic = TICKS_PER_SECOND / TICRATE
    return (int)(t / (TICKS_PER_SECOND / TICRATE));
}

// I_GetTimeFrac: sub-tic interpolation not used in timedemo mode.
int I_GetTimeFrac(void)
{
    return (1 << 16); /* FRACUNIT = end of tic */
}

// ── Standard stubs ────────────────────────────────────────────────────────────
void I_Tactile(int on, int off, int total)
{
    (void)on; (void)off; (void)total;
}

static ticcmd_t emptycmd;
ticcmd_t* I_BaseTiccmd(void)
{
    return &emptycmd;
}

void I_Init(void)
{
    I_InitSound();
}

void I_Quit(void)
{
    debugf("I_Quit: bare-metal N64 spin\n");
    for (;;) {}
}

void I_WaitVBL(int count) { (void)count; }
void I_BeginRead(void) {}
void I_EndRead(void)   {}
void I_StartFrame(void) {}
void I_StartTic(void)   {}

// ── I_Error ───────────────────────────────────────────────────────────────────
// Format error message via debugf (ISViewer), detect timedemo-end, longjmp.
void I_Error(char* error, ...)
{
    va_list argptr;
    char    buf[512];
    int     tics;
    const char* p;

    va_start(argptr, error);
    vsnprintf(buf, sizeof(buf), error, argptr);
    va_end(argptr);

    // Timedemo-end detection: "timed %i gametics in %i realtics"
    if (n64_timedemo_active &&
        sscanf(buf, "timed %i gametics in", &tics) == 1) {
        n64_timedemo_gametics = tics;
        longjmp(n64_demo_jmp, 1);
    }

    // Print error to ISViewer UART.
    p = buf;
    while (*p) n64_putc((unsigned char)*p++);
    n64_putc('\n');

    // Bare-metal: abort() → CPU exception handler → ares crash/halt.
    abort();
}

// ── mkdir: provided by libdragon (system.c:1374) ─────────────────────────────
// d_main.c calls mkdir() for savegame directory.  libdragon stubs this;
// we do not redefine it here to avoid multiple-definition conflict.
