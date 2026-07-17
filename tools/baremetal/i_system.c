// tools/baremetal/i_system.c — bare-metal ARM platform layer (rung 2).
//
// THREE ALLOWED SURFACES (bare-metal.md §1):
//   (a) MEMORY:    static 6 MiB arena — I_ZoneBase returns it.
//   (b) BYTE-OUT:  fs_putc → PL011 UART UARTDR at 0x09000000.
//   (c) WAD BLOB:  registered by bm_main() before D_DoomMain; files.c serves it.
//
// No OS, no glibc.  newlib provides libc surface (memcpy/sprintf/etc.) via -lc.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "doomdef.h"
#include "m_misc.h"
#include "i_video.h"
#include "i_sound.h"
#include "d_net.h"
#include "g_game.h"
#include "i_system.h"
#include "fs_platform.h"

// ── Timedemo exit state ──────────────────────────────────────────────────────
volatile int fs_timedemo_active   = 0;
volatile int fs_timedemo_gametics = 0;
jmp_buf      fs_demo_jmp;

// ── (b) BYTE-OUT: PL011 UART0 at 0x09000000 (QEMU virt) ─────────────────────
// Writing the low 8 bits of the UARTDR register (offset 0) emits one byte.
// qemu-system-arm -nographic routes UART0 to stdout.
static volatile unsigned* const UART_DR = (volatile unsigned*)0x09000000u;

void fs_putc(int c)
{
    *UART_DR = (unsigned)(unsigned char)c;
}

// ── (a) MEMORY: 6 MiB static zone arena ──────────────────────────────────────
// Sized to fit alongside the 12.4 MiB baked WAD in 32 MiB QEMU RAM.
// bare-metal.md §2.2: 4 MiB minimum; 6 MiB provides comfortable headroom.
//
// __attribute__((aligned(8))): ARMv7-A LDM/STM instructions require that the
// base address be word-aligned (4) or doubleword-aligned (8) even when
// SCTLR.A=0 (alignment faults disabled).  The zone allocator's memblock_t
// contains pointer-sized and int-sized fields; 8-byte alignment guarantees
// all derived pointers are properly aligned for both LDR and LDM.
#define BM_ZONE_SIZE (6 * 1024 * 1024)
static byte bm_arena[BM_ZONE_SIZE] __attribute__((aligned(8)));

byte* I_ZoneBase(int* size)
{
    *size = BM_ZONE_SIZE;
    return bm_arena;
}

// Static screen buffer for I_AllocLow (called once by V_Init).
// 4-byte aligned so word-wide render loops can access it safely.
#define BM_ALLOCLOW_SIZE (SCREENWIDTH * SCREENHEIGHT * 4)
static byte bm_screenbufs[BM_ALLOCLOW_SIZE] __attribute__((aligned(4)));

byte* I_AllocLow(int length)
{
    static int initialised;
    if (!initialised) {
        memset(bm_screenbufs, 0, sizeof(bm_screenbufs));
        initialised = 1;
    }
    (void)length;
    return bm_screenbufs;
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

void I_Tactile(int on, int off, int total)
{
    (void)on; (void)off; (void)total;
}

static ticcmd_t emptycmd;
ticcmd_t* I_BaseTiccmd(void)
{
    return &emptycmd;
}

// Monotonic tick counter.  The demo sim is deterministic on ticcmds, not
// wall-clock; any monotonic source produces identical per-tic hashes.
// In timedemo mode TryRunTics ignores the wall clock entirely.
int I_GetTime(void)
{
    static int t;
    return t++;
}

void I_Init(void)
{
    I_InitSound();
}

void I_Quit(void)
{
    for (;;) {}   // no OS to call exit() on
}

void I_WaitVBL(int count) { (void)count; }
void I_BeginRead(void)    {}
void I_EndRead(void)      {}
void I_StartFrame(void)   {}
void I_StartTic(void)     {}

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

    // Detect graceful timedemo-end: longjmp back to bm_main instead of halting.
    if (fs_timedemo_active &&
        sscanf(buf, "timed %i gametics in", &tics) == 1) {
        fs_timedemo_gametics = tics;
        longjmp(fs_demo_jmp, 1);
    }

    // Fatal error: stream to UART then halt.
    p = "I_Error: ";
    while (*p) fs_putc((unsigned char)*p++);
    p = buf;
    while (*p) fs_putc((unsigned char)*p++);
    fs_putc('\n');
    for (;;) {}
}
