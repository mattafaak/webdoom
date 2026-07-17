// tools/freestanding/d_net.c — single-player-only netcode stub.
// No network I/O; the sim is always single-player.
// Identical to native-sanitize/d_net.c — provides TryRunTics, NetUpdate,
// D_CheckNetGame, D_QuitNetGame, I_GetTimeFrac without any emscripten dependency.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include <time.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_net.h"
#include "i_system.h"
#include "g_game.h"
#include "m_menu.h"

extern boolean timingdemo; // g_game.c; no public header declares it

ticcmd_t localcmds[BACKUPTICS];
ticcmd_t netcmds[MAXPLAYERS][BACKUPTICS];
int      nettics[MAXNETNODES];
int      maketic;
int      ticdup = 1;

// g_game.c references these web-layer globals for drop-in netplay.
// In single-player builds they are never non-zero but must exist.
int     web_joinTic[MAXPLAYERS];
boolean web_replaying = false;

static long long last_tic_ns;

static long long now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

int I_GetTimeFrac(void)
{
    long long elapsed = now_ns() - last_tic_ns;
    long long tic_ns  = 1000000000LL / TICRATE;
    int       frac;

    if (elapsed <= 0)      return 0;
    if (elapsed >= tic_ns) return FRACUNIT;

    frac = (int)(((long long)FRACUNIT * elapsed) / tic_ns);
    return frac;
}

void D_ProcessEvents(void);
void G_BuildTiccmd(ticcmd_t* cmd);
void D_DoAdvanceDemo(void);
extern boolean advancedemo;

static void run_tic(void)
{
    if (advancedemo)
        D_DoAdvanceDemo();
    M_Ticker();
    G_Ticker();
    gametic++;
    last_tic_ns = now_ns();
}

void NetUpdate(void)
{
    int nowtime = I_GetTime();
    static int gametime;
    int newtics = nowtime - gametime;
    int i;

    gametime = nowtime;
    if (newtics <= 0)
        return;
    if (newtics > TICRATE)
        newtics = 1;

    for (i = 0; i < newtics; i++) {
        I_StartTic();
        D_ProcessEvents();
        if (maketic - gametic >= BACKUPTICS / 2 - 1)
            break;
        G_BuildTiccmd(&localcmds[maketic % BACKUPTICS]);
        netcmds[consoleplayer][maketic % BACKUPTICS] =
            localcmds[maketic % BACKUPTICS];
        nettics[consoleplayer] = maketic + 1;
        maketic++;
    }
}

void TryRunTics(void)
{
    int counts;
    int lowtic;
    int entertic;
    static int oldentertics;
    int realtics;
    int i;

    entertic     = I_GetTime();
    realtics     = entertic - oldentertics;
    oldentertics = entertic;

    NetUpdate();

    lowtic = MAXINT;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && nettics[i] < lowtic)
            lowtic = nettics[i];

    counts = lowtic - gametic;
    if (counts > realtics + 1)
        counts = realtics + 1;
    if (counts < 0)
        counts = 0;

    // Timedemo: no wall-clock cap — run to sealed tic immediately.
    if (timingdemo)
        counts = lowtic - gametic;

    while (counts-- > 0) {
        run_tic();
        NetUpdate();
    }
}

void D_CheckNetGame(void)
{
    int i;
    for (i = 0; i < MAXNETNODES; i++)
        nettics[i] = 0;
    for (i = 0; i < MAXPLAYERS; i++)
        playeringame[i] = (i == 0);
    consoleplayer = displayplayer = 0;
}

void D_QuitNetGame(void) {}

void web_net_setup(int player, int numplayers)
{
    (void)player;
    (void)numplayers;
}

boolean D_NetCmdFabricated(int player, int tic)
{
    (void)player;
    (void)tic;
    return false;
}
