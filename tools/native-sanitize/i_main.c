// native-sanitize i_main.c — native ASan/UBSan timedemo harness.
//
// Runs ONE demo per invocation (one per process) so D_DoomMain global state
// is always fresh.  Usage:
//
//   ./nat-doom -iwad <wad> -timedemo <demo> \
//              [-sim <out.json>] [-render <out-render.json>] \
//              [-waddir <dir>]
//
// Any argument not recognized by this preamble is passed through to D_DoomMain
// via myargc/myargv.  The harness inserts -timedemo automatically and
// removes -sim / -render / -waddir from the argv it forwards.
//
// Collects per-tic sim hash (identical to web_state_hash in engine/web/i_main.c)
// and per-tic render FNV-1a hash (identical to fnv1aRender in demo-test.mjs),
// writes both to JSON as {"tics": N, "trace": [u32...]}.
// run-all.sh calls this binary once per demo; compare.py diffs the output.
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
#include "web.h"    // D_DoomFrame declaration

// External sim state.
extern int prndindex;

// ── sim hash: identical to web_state_hash() in engine/web/i_main.c ───────────
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

// ── JSON output ───────────────────────────────────────────────────────────────
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
        fprintf (stderr, "nat-doom: cannot write %s\n", path);
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

// ── main ─────────────────────────────────────────────────────────────────────

int main (int argc, char** argv)
{
    // Peel off harness-only flags before forwarding argv to D_DoomMain.
    const char* sim_out    = NULL;
    const char* render_out = NULL;
    const char* wad_dir    = NULL;

    // Forward-argv buffer: at most as many entries as input.
    static const char* fwd[64];
    int fwd_argc = 0;
    int i;
    int last_tic;

    for (i = 0; i < argc && fwd_argc < 63; i++)
    {
        if (strcmp (argv[i], "-sim") == 0 && i + 1 < argc)
            { sim_out = argv[++i]; continue; }
        if (strcmp (argv[i], "-render") == 0 && i + 1 < argc)
            { render_out = argv[++i]; continue; }
        if (strcmp (argv[i], "-waddir") == 0 && i + 1 < argc)
            { wad_dir = argv[++i]; continue; }
        fwd[fwd_argc++] = argv[i];
    }

    // Apply WAD directory (files.c reads nat_wad_dir).
    if (wad_dir)
        nat_wad_dir = wad_dir;

    myargc = fwd_argc;
    myargv = (char**) fwd;

    // Arm the timedemo longjmp exit.
    nat_timedemo_active   = 1;
    nat_timedemo_gametics = 0;
    trace_len             = 0;

    if (setjmp (nat_demo_jmp) != 0)
        goto done;

    D_DoomMain (); // init + load WAD; calls I_Error on missing WAD (aborts)

    // Pin fractic = FRACUNIT: no wall-clock contribution to render interpolation.
    smoothrender = false;

    last_tic = -1;
    for (;;)
    {
        // Skip active melt wipes: wall-clock driven and non-deterministic.
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

        fprintf (stderr, "nat-doom: %d gametics, %d trace entries\n",
                 tics, trace_len);
        return err ? 1 : 0;
    }
}
