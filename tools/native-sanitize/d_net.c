// native-sanitize d_net.c — single-player-only netcode stub for ASan/UBSan
// timedemo runs.  No network I/O; the sim is always single-player.
// Mirrors the public surface of engine/web/d_net.c that engine/core code
// depends on (TryRunTics, NetUpdate, D_CheckNetGame, D_QuitNetGame,
// I_GetTimeFrac) without any emscripten dependency.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include <time.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_net.h"
#include "i_system.h"
#include "g_game.h"
#include "m_menu.h"

extern boolean timingdemo; // defined in g_game.c; no public header declares it

ticcmd_t localcmds[BACKUPTICS];
ticcmd_t netcmds[MAXPLAYERS][BACKUPTICS];
int      nettics[MAXNETNODES];
int      maketic;
int      ticdup = 1;

// g_game.c references these web-layer globals for drop-in netplay.
// In single-player native builds they are never non-zero but must exist.
int     web_joinTic[MAXPLAYERS]; // gametic each slot went live (consistancy skip)
boolean web_replaying = false;   // true only during catch-up replay

// For timedemos smoothrender=false, so I_GetTimeFrac is never called for
// render interpolation.  We implement it with CLOCK_MONOTONIC anyway so
// the function is well-defined if the test harness forgets to set smoothrender.
static long long last_tic_ns;

// Monotonic nanosecond timestamp.
static long long now_ns (void)
{
    struct timespec ts;
    clock_gettime (CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

int I_GetTimeFrac (void)
{
    // Fraction of one tic (1/35 s) elapsed since the sim last advanced.
    long long elapsed = now_ns () - last_tic_ns;
    long long tic_ns  = 1000000000LL / TICRATE;
    int frac;

    if (elapsed <= 0)      return 0;
    if (elapsed >= tic_ns) return FRACUNIT;

    frac = (int) (((long long) FRACUNIT * elapsed) / tic_ns);
    return frac;
}

void D_ProcessEvents (void);
void G_BuildTiccmd (ticcmd_t* cmd);
void D_DoAdvanceDemo (void);
extern boolean advancedemo;

static void run_tic (void)
{
    if (advancedemo)
        D_DoAdvanceDemo ();
    M_Ticker ();
    G_Ticker ();
    gametic++;
    last_tic_ns = now_ns ();
}

void NetUpdate (void)
{
    // Build one ticcmd per real-time tic outstanding.
    int nowtime  = I_GetTime ();
    static int gametime;
    int newtics  = nowtime - gametime;
    int i;

    gametime = nowtime;
    if (newtics <= 0)
        return;
    if (newtics > TICRATE)
        newtics = 1; // don't fast-forward after a pause

    for (i = 0; i < newtics; i++)
    {
        I_StartTic ();
        D_ProcessEvents ();
        if (maketic - gametic >= BACKUPTICS / 2 - 1)
            break;
        G_BuildTiccmd (&localcmds[maketic % BACKUPTICS]);
        netcmds[consoleplayer][maketic % BACKUPTICS] =
            localcmds[maketic % BACKUPTICS];
        nettics[consoleplayer] = maketic + 1;
        maketic++;
    }
}

void TryRunTics (void)
{
    int counts;
    int lowtic;
    int entertic;
    static int oldentertics;
    int realtics;
    int i;

    entertic    = I_GetTime ();
    realtics    = entertic - oldentertics;
    oldentertics = entertic;

    NetUpdate ();

    // Single player: lowtic == nettics[consoleplayer].
    lowtic = MAXINT;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && nettics[i] < lowtic)
            lowtic = nettics[i];

    // For -timedemo the engine calls G_Ticker as fast as it can; realtics
    // can be 0 many frames in a row.  The timedemo flag bypasses wall-clock
    // gating in vanilla (it records starttime and lets the loop run freely).
    // We match that behaviour: run all sealed tics in one shot, capped to
    // avoid runaway in degenerate cases.
    counts = lowtic - gametic;
    if (counts > realtics + 1)
        counts = realtics + 1;
    if (counts < 0)
        counts = 0;

    // Timedemo: no wall-clock cap — run to sealed tic immediately.
    if (timingdemo)
        counts = lowtic - gametic;

    while (counts-- > 0)
    {
        run_tic ();
        NetUpdate ();
    }
}

void D_CheckNetGame (void)
{
    int i;
    for (i = 0; i < MAXNETNODES; i++)
        nettics[i] = 0;
    for (i = 0; i < MAXPLAYERS; i++)
        playeringame[i] = (i == 0);
    consoleplayer = displayplayer = 0;
}

void D_QuitNetGame (void) {}

// web_net_setup stub (declared in web.h for the rare core include).
void web_net_setup (int player, int numplayers)
{
    (void) player; (void) numplayers;
}

// D_NetCmdFabricated — native single-player: never fabricated.
boolean D_NetCmdFabricated (int player, int tic)
{
    (void) player; (void) tic;
    return false;
}
