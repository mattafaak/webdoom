// wide-experiment/i_main.c — timedemo harness for Hor+ widescreen build.
// Adds -dump-frame N -dump-path <file.ppm> flags (one-shot PPM screenshot).
// Inherits the sim/render trace output from native-sanitize/i_main.c.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <setjmp.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "m_argv.h"
#include "nat_platform.h"
#include "web.h"

extern int prndindex;

// Declared in i_video.c (wide-experiment version).
extern int          nat_dump_tic;
extern const char*  nat_dump_path;

// ── sim hash (same as native-sanitize) ───────────────────────────────────────
static int nat_state_hash (void)
{
    unsigned h = 0x9e3779b9u ^ (unsigned) gametic;
    int i;
    h = (h ^ (unsigned) prndindex) * 0x01000193u;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && players[i].mo)
        {
            h = (h ^ (unsigned) players[i].mo->x)     * 0x01000193u;
            h = (h ^ (unsigned) players[i].mo->y)     * 0x01000193u;
            h = (h ^ (unsigned) players[i].mo->angle) * 0x01000193u;
            h = (h ^ (unsigned) players[i].health)    * 0x01000193u;
        }
    return (int) h;
}

extern unsigned nat_render_hash (void);

#define MAX_TRACE 300000
static int sim_trace[MAX_TRACE];
static int render_trace[MAX_TRACE];
static int trace_len;

static int write_trace (const char* path, int tics,
                         const int* trace, int n)
{
    FILE* f;
    int i;
    f = fopen (path, "w");
    if (!f)
    {
        fprintf (stderr, "nat-doom-wide: cannot write %s\n", path);
        return -1;
    }
    fprintf (f, "{\"tics\":%d,\"trace\":[", tics);
    for (i = 0; i < n; i++)
    {
        fprintf (f, "%u", (unsigned) trace[i]);
        if (i + 1 < n) fputc (',', f);
    }
    fputs ("]}", f);
    fclose (f);
    return 0;
}

int main (int argc, char** argv)
{
    const char* sim_out    = NULL;
    const char* render_out = NULL;
    const char* wad_dir    = NULL;
    int         dump_tic   = 200; // default: capture tic 200
    const char* dump_path  = NULL;

    static const char* fwd[64];
    int fwd_argc = 0;
    int i, last_tic;

    for (i = 0; i < argc && fwd_argc < 63; i++)
    {
        if (strcmp (argv[i], "-sim") == 0 && i + 1 < argc)
            { sim_out = argv[++i]; continue; }
        if (strcmp (argv[i], "-render") == 0 && i + 1 < argc)
            { render_out = argv[++i]; continue; }
        if (strcmp (argv[i], "-waddir") == 0 && i + 1 < argc)
            { wad_dir = argv[++i]; continue; }
        if (strcmp (argv[i], "-dump-frame") == 0 && i + 1 < argc)
            { dump_tic = atoi (argv[++i]); continue; }
        if (strcmp (argv[i], "-dump-path") == 0 && i + 1 < argc)
            { dump_path = argv[++i]; continue; }
        fwd[fwd_argc++] = argv[i];
    }

    if (wad_dir)
        nat_wad_dir = wad_dir;

    // Wire up the frame dump (shared with i_video.c).
    nat_dump_tic  = dump_path ? dump_tic : -1;
    nat_dump_path = dump_path;

    myargc = fwd_argc;
    myargv = (char**) fwd;

    nat_timedemo_active   = 1;
    nat_timedemo_gametics = 0;
    trace_len             = 0;

    if (setjmp (nat_demo_jmp) != 0)
        goto done;

    D_DoomMain ();

    smoothrender = false;
    last_tic = -1;

    for (;;)
    {
        wipeactive = 0;
        D_DoomFrame ();

        if (gametic != last_tic)
        {
            if (trace_len < MAX_TRACE)
            {
                sim_trace[trace_len]    = nat_state_hash ();
                render_trace[trace_len] = (int) nat_render_hash ();
                trace_len++;
            }
            last_tic = gametic;
        }
    }

done:
    nat_timedemo_active = 0;
    {
        int tics = nat_timedemo_gametics;
        int err  = 0;
        if (sim_out)
            err |= write_trace (sim_out, tics, sim_trace, trace_len);
        if (render_out)
            err |= write_trace (render_out, tics, render_trace, trace_len);
        fprintf (stderr, "nat-doom-wide: %d gametics, %d trace entries\n",
                 tics, trace_len);
        return err ? 1 : 0;
    }
}
