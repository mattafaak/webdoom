// native-sanitize i_system.c — minimal native platform layer for ASan/UBSan
// demo runs.  Mirrors engine/web/i_system.c without any emscripten dependency.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "doomdef.h"
#include "m_misc.h"
#include "i_video.h"
#include "i_sound.h"
#include "d_net.h"
#include "g_game.h"
#include "i_system.h"
#include "nat_platform.h"

// Timedemo exit mechanism: i_main.c sets these before the demo loop.
// When I_Error("timed %i gametics in ...") fires, we longjmp back instead
// of aborting so the harness can record the gametic count.
volatile int nat_timedemo_active = 0;
volatile int nat_timedemo_gametics = 0;
jmp_buf      nat_demo_jmp;

// Zone pool size: match ZONESIZE from web.h (32 MiB).
#define NATIVE_ZONESIZE (32 * 1024 * 1024)

byte* I_ZoneBase (int* size)
{
    *size = NATIVE_ZONESIZE;
    return (byte*) malloc ((size_t) NATIVE_ZONESIZE);
}

void I_Tactile (int on, int off, int total)
{
    (void) on; (void) off; (void) total;
}

static ticcmd_t emptycmd;
ticcmd_t* I_BaseTiccmd (void)
{
    return &emptycmd;
}

int I_GetTime (void)
{
    struct timespec ts;
    clock_gettime (CLOCK_MONOTONIC, &ts);
    return (int) ((ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL) * TICRATE / 1000);
}

void I_Init (void)
{
    I_InitSound ();
}

void I_Quit (void)
{
    exit (0);
}

void I_WaitVBL (int count) { (void) count; }
void I_BeginRead (void) {}
void I_EndRead (void) {}

byte* I_AllocLow (int length)
{
    return (byte*) calloc (1, (size_t) length);
}

void I_StartFrame (void) {}
void I_StartTic (void) {}

void I_Error (char* error, ...)
{
    va_list argptr;
    char    buf[512];
    int     tics;

    va_start (argptr, error);
    vsnprintf (buf, sizeof buf, error, argptr);
    va_end (argptr);

    // Detect the graceful timedemo-end message:
    //   "timed %i gametics in %i realtics"
    // G_CheckDemoStatus always produces this exact format string.
    if (nat_timedemo_active &&
        sscanf (buf, "timed %i gametics in", &tics) == 1)
    {
        nat_timedemo_gametics = tics;
        longjmp (nat_demo_jmp, 1);
    }

    // Fatal error — print to stderr and abort so ASan/UBSan produces a
    // full backtrace/report before the process exits.
    fprintf (stderr, "I_Error: %s\n", buf);
    fflush (stderr);
    abort ();
}
