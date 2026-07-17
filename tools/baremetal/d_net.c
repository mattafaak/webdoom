// tools/baremetal/d_net.c — single-player netcode stub (bare-metal rung 2).
//
// Adapted from freestanding/d_net.c: removes POSIX clock_gettime since
// bare-metal has no OS clock.  I_GetTime() (i_system.c) provides a simple
// monotonic counter; for timedemo mode the engine ignores wall-clock timing
// entirely (counts = lowtic - gametic), so any counter produces identical hashes.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_net.h"
#include "i_system.h"
#include "g_game.h"
#include "m_menu.h"

extern boolean timingdemo;

ticcmd_t localcmds[BACKUPTICS];
ticcmd_t netcmds[MAXPLAYERS][BACKUPTICS];
int      nettics[MAXNETNODES];
int      maketic;
int      ticdup = 1;

int     web_joinTic[MAXPLAYERS];
boolean web_replaying = false;

// I_GetTimeFrac: smooth-render interpolation fraction.
// smoothrender is disabled in bm_main so this value is never used.
int I_GetTimeFrac(void)
{
    return FRACUNIT;
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
