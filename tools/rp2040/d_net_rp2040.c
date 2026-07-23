// tools/rp2040/d_net_rp2040.c — RP2040 single-player netcode stub.
//
// Mirrors tools/freestanding/d_net.c with POSIX clock_gettime replaced by the
// RP2040's g_ticcount (incremented by a 35 Hz timer ISR in i_system_rp2040.c).
//
// Engine/core: 0-diff.  Only tools/rp2040/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include "doomtype.h"
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

/* g_game.c references these webdoom globals; stub them for single-player. */
int     web_joinTic[MAXPLAYERS];
boolean web_replaying = 0;

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
    return 0;
}

/* I_GetTimeFrac: return end-of-tic (FRACUNIT) — no sub-tic interpolation. */
int I_GetTimeFrac(void)
{
    return (1 << 16); /* FRACUNIT */
}

/* mkdir stub: d_main.c calls mkdir() for the savegame directory.
 * On bare-metal there is no filesystem; return success silently. */
int mkdir(const char* path, unsigned int mode)
{
    (void)path;
    (void)mode;
    return 0;
}
