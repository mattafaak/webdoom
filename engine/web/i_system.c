// webdoom i_system: timing, zone memory, error handling.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

#include <emscripten.h>

#include "doomdef.h"
#include "m_misc.h"
#include "i_video.h"
#include "i_sound.h"
#include "d_net.h"
#include "g_game.h"
#include "i_system.h"

// 32 MB zone: vanilla's 6 MB starves limit-raised rendering and big PWADs.
#define ZONESIZE (32*1024*1024)

int mb_used = 32;

void I_Tactile (int on, int off, int total)
{
    on = off = total = 0;
}

static ticcmd_t emptycmd;
ticcmd_t* I_BaseTiccmd (void)
{
    return &emptycmd;
}

byte* I_ZoneBase (int* size)
{
    *size = ZONESIZE;
    return (byte*) malloc (ZONESIZE);
}

// Time origin is module load; wraps are impossible within a session.
int I_GetTime (void)
{
    return (int) (emscripten_get_now () * TICRATE / 1000.0);
}

void I_Init (void)
{
    I_InitSound ();
}

void I_Quit (void)
{
    D_QuitNetGame ();
    I_ShutdownSound ();
    I_ShutdownMusic ();
    M_SaveDefaults ();
    I_ShutdownGraphics ();
    emscripten_force_exit (0);
}

void I_WaitVBL (int count)
{
    // Never block the browser main thread.
    (void) count;
}

void I_BeginRead (void) {}
void I_EndRead (void) {}

byte* I_AllocLow (int length)
{
    return (byte*) calloc (1, length);
}

void I_StartFrame (void) {}
void I_StartTic (void) {}

void I_Error (char *error, ...)
{
    va_list argptr;
    char msg[512];

    va_start (argptr, error);
    vsnprintf (msg, sizeof msg, error, argptr);
    va_end (argptr);
    fprintf (stderr, "I_Error: %s\n", msg);

    // Surface the message in the page, then halt.
    EM_ASM ({ if (Module["onDoomError"]) Module["onDoomError"](UTF8ToString($0)); }, msg);
    abort ();
}
