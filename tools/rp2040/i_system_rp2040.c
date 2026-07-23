// tools/rp2040/i_system_rp2040.c — RP2040 system shim (Cortex-M0+ bare-metal).
//
// SURFACE CONTRACT (mirrors bare-metal.md §1):
//   (a) MEMORY: static zone arena — I_ZoneBase returns it.
//   (b) BYTE-OUT: rp2040_putc() → UART stub (no-op until pico-sdk lands).
//   (c) WAD BLOB: files_rp2040.c serves WHD from XIP flash.
//
// BLOCKED: I_GetTime uses a tick counter that needs a 35 Hz hardware timer.
//   On RP2040, use alarm_pool / hardware_timer / SysTick at 35 Hz.
//   The stub returns 0 always — DOOM will busy-wait in TryRunTics.
//   Unblock: configure SysTick in rp2040_main.c, increment g_ticcount at ISR.
//
// BLOCKED: I_Error longjmp path needs setjmp stack for timedemo-end detection.
//   Works once pico-sdk provides a C runtime with setjmp support (newlib does).
//
// FOOTPRINT NOTE: RP2040_ZONE_SIZE defaults to 256 KB in the build system.
//   This is enough to compile and link; not enough to run DOOM.
//   See docs/rp2040/BRING-UP.md §BLOCKED for zone size analysis.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdarg.h>
#include <string.h>
#include <setjmp.h>
#include <stdlib.h>
#include <stdio.h>

#include "doomtype.h"
#include "doomdef.h"
#include "m_misc.h"
#include "i_video.h"
#include "i_sound.h"
#include "d_net.h"
#include "g_game.h"
#include "i_system.h"
#include "rp2040_platform.h"

// ── Timedemo exit state ───────────────────────────────────────────────────────
volatile int rp2040_timedemo_active   = 0;
volatile int rp2040_timedemo_gametics = 0;
jmp_buf      rp2040_demo_jmp;

// ── (b) BYTE-OUT ──────────────────────────────────────────────────────────────
// Stub: no-op until pico-sdk uart_putc() is available.
// Replace with: uart_putc(UART_ID, (char)c);
void rp2040_putc(int c)
{
    (void)c;
    /* TODO(pico-sdk): uart_putc(uart0, (char)c); */
}

// ── (a) MEMORY: static zone arena ────────────────────────────────────────────
// RP2040_ZONE_SIZE is set by the Makefile (default: 256 KB token).
// NOTE: this is placed in BSS (SRAM).  On RP2040, SRAM is only 264 KB total.
// Even a 256 KB zone leaves only 8 KB for all other runtime state —
// insufficient.  The number is here to make the footprint build link.
// Actual runs require external SRAM or a redesigned WAD paging scheme.
static byte rp2040_arena[RP2040_ZONE_SIZE];

byte* I_ZoneBase(int* size)
{
    *size = RP2040_ZONE_SIZE;
    return rp2040_arena;
}

// ── Screen buffers (V_Init calls I_AllocLow once) ────────────────────────────
// With MAXSCREENWIDTH=320: 320*200*4 = 256,000 bytes.
// These live in BSS (SRAM).
static byte rp2040_screenbufs[RP2040_ALLOCLOW_SIZE] __attribute__((aligned(4)));

byte* I_AllocLow(int length)
{
    static int initialised;
    if (!initialised) {
        memset(rp2040_screenbufs, 0, sizeof(rp2040_screenbufs));
        initialised = 1;
    }
    (void)length;
    return rp2040_screenbufs;
}

// ── Timing (BLOCKED: needs 35 Hz hardware timer) ─────────────────────────────
// On RP2040: configure hardware_alarm or SysTick in rp2040_main.c to fire
// at 35 Hz and increment this counter.
volatile int g_ticcount = 0;

int I_GetTime(void)
{
    return g_ticcount;
    /* TODO(pico-sdk): use timer_hw->timerawl / 28571 for microsecond timer. */
}

// ── Standard stubs ───────────────────────────────────────────────────────────
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
    for (;;) {} /* bare-metal: spin */
}

void I_WaitVBL(int count) { (void)count; }
void I_BeginRead(void) {}
void I_EndRead(void)   {}
void I_StartFrame(void) {}
void I_StartTic(void)   {}

// ── I_Error: stream via rp2040_putc, detect timedemo-end via longjmp ─────────
void I_Error(char* error, ...)
{
    va_list argptr;
    char    buf[512];
    int     tics;
    const char* p;

    va_start(argptr, error);
    /* vsnprintf needs newlib — available in arm-none-eabi with -specs=nosys.specs */
    /* Use vsnprintf stub if newlib not available: just copy the format string. */
    {
        /* minimal: format without %i/%s expansion if newlib absent */
        int n = 0;
        const char* f = error;
        while (*f && n < (int)sizeof(buf)-1) buf[n++] = *f++;
        buf[n] = '\0';
        (void)argptr;
    }
    va_end(argptr);

    if (rp2040_timedemo_active &&
        /* sscanf: needs newlib — available in arm-none-eabi */
        /* For the footprint build, the longjmp path is preserved in source. */
        (sscanf(buf, "timed %i gametics in", &tics) == 1)) {
        rp2040_timedemo_gametics = tics;
        longjmp(rp2040_demo_jmp, 1);
    }

    p = buf;
    while (*p) rp2040_putc((unsigned char)*p++);
    rp2040_putc('\n');
    abort(); /* bare-metal abort() → hard fault handler */
}

// ── Newlib syscall stubs (required when linking with -specs=nosys.specs) ─────
// These make the linker happy without OS support.
// With pico-sdk, replace these with the SDK-provided _write/_sbrk.
#include <sys/stat.h>
int _write(int fd, const char* buf, int len)
{
    int i;
    (void)fd;
    for (i = 0; i < len; i++) rp2040_putc((unsigned char)buf[i]);
    return len;
}

int _read(int fd, char* buf, int len)
{
    (void)fd; (void)buf; (void)len;
    return 0;
}

int _close(int fd) { (void)fd; return -1; }
int _fstat(int fd, struct stat* st) { (void)fd; (void)st; return -1; }
int _isatty(int fd) { (void)fd; return 0; }
int _lseek(int fd, int offset, int whence) { (void)fd; (void)offset; (void)whence; return -1; }

void* _sbrk(int incr)
{
    (void)incr;
    return (void*)-1; /* no heap — use zone allocator */
}
