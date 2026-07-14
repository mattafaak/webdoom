// webdoom d_net: deterministic lockstep over a server tic-relay,
// replacing vanilla's peer-to-peer transport wholesale. Public surface
// (TryRunTics/NetUpdate/D_CheckNetGame/D_QuitNetGame + doomstat externs)
// is unchanged, so game code is untouched.
//
// Single player: nettics[you] tracks maketic and nothing ever blocks.
// Net play: JS owns the WebSocket. Local ticcmds go up via the
// js_net_send import; the server's sealed per-tic bundles come back
// down through web_net_bundle(), written straight into netcmds[][].
// The game advances only to the lowest sealed tic — desync-free by
// construction, and a stalled peer freezes the sim but never the page.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include <emscripten.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_net.h"
#include "i_system.h"
#include "g_game.h"
#include "m_menu.h"

ticcmd_t localcmds[BACKUPTICS];
ticcmd_t netcmds[MAXPLAYERS][BACKUPTICS];
static double web_lastticms;    // when the sim last advanced (ms)
int      nettics[MAXNETNODES];    // per PLAYER here; sealed-through tic
int      maketic;
int      ticdup = 1;

// How many tics of input to build ahead of the sealed frontier. LAN=1.
// The JS bridge can raise it from measured RTT before the game starts.
static int web_inputdelay = 1;
static int web_numplayers = 1;

void D_ProcessEvents (void);
void G_BuildTiccmd (ticcmd_t* cmd);
void D_DoAdvanceDemo (void);
extern boolean advancedemo;

// Send one local ticcmd to the relay. No-op stub until the JS side
// defines it (single player, or netcode phase not wired yet).
EM_JS (void, js_net_send, (int tic, ticcmd_t* cmd, int size), {
    if (Module.netSend) Module.netSend(tic, cmd, size);
});

//
// web_net_setup
// Called from JS before main() when entering a lobby game.
//
EMSCRIPTEN_KEEPALIVE
void web_net_setup (int player, int numplayers)
{
    consoleplayer = displayplayer = player;
    web_numplayers = numplayers;
    netgame = numplayers > 1;
}

EMSCRIPTEN_KEEPALIVE
void web_net_set_delay (int tics)
{
    if (tics < 1) tics = 1;
    if (tics > BACKUPTICS/2-1) tics = BACKUPTICS/2-1;
    web_inputdelay = tics;
}

//
// web_net_bundle
// JS delivers one sealed tic: every live player's ticcmd, in slot order.
// Bundles always arrive in tic order (the relay guarantees it).
// fabmask: bit N set = slot N's cmd was fabricated by the relay (stalled
// client) and carries no valid consistancy checksum.
//
static byte fabricated[BACKUPTICS];

EMSCRIPTEN_KEEPALIVE
void web_net_bundle (int tic, ticcmd_t* cmds, byte* ingame, int fabmask)
{
    int i;

    fabricated[tic % BACKUPTICS] = (byte) fabmask;
    for (i = 0; i < web_numplayers; i++)
    {
        playeringame[i] = ingame[i];
        if (ingame[i])
            netcmds[i][tic % BACKUPTICS] = cmds[i];
        nettics[i] = tic + 1;
    }
}

//
// D_NetCmdFabricated
// g_game's consistancy check skips relay-fabricated cmds (their checksum
// is meaningless); every real cmd is still verified.
//
boolean D_NetCmdFabricated (int player, int tic)
{
    if (!netgame)
        return false;
    return (fabricated[tic % BACKUPTICS] >> player) & 1;
}

EMSCRIPTEN_KEEPALIVE
ticcmd_t* web_net_scratch (void)
{
    // Scratch space JS borrows to pass bundles in (one full player row).
    static ticcmd_t scratch[MAXPLAYERS];
    return scratch;
}

//
// NetUpdate
// Build local ticcmds up to real time (+ input delay in net games)
// and ship them to the relay.
//
static int gametime;

void NetUpdate (void)
{
    int nowtime;
    int newtics;
    int i;

    nowtime = I_GetTime ();
    newtics = nowtime - gametime;
    gametime = nowtime;

    if (newtics <= 0)
        return;

    // A hidden tab stops rAF; on return, resume instead of fast-forwarding.
    if (newtics > TICRATE)
        newtics = 1;

    for (i = 0; i < newtics; i++)
    {
        I_StartTic ();
        D_ProcessEvents ();
        if (maketic - gametic >= BACKUPTICS/2-1)
            break;          // can't hold any more

        G_BuildTiccmd (&localcmds[maketic%BACKUPTICS]);

        if (netgame)
            js_net_send (maketic, &localcmds[maketic%BACKUPTICS],
                         sizeof(ticcmd_t));
        else
        {
            netcmds[consoleplayer][maketic%BACKUPTICS] =
                localcmds[maketic%BACKUPTICS];
            nettics[consoleplayer] = maketic + 1;
        }
        maketic++;
    }
}

//
// D_CheckNetGame
//
void D_CheckNetGame (void)
{
    int i;

    for (i = 0; i < MAXNETNODES; i++)
        nettics[i] = 0;

    for (i = 0; i < MAXPLAYERS; i++)
        playeringame[i] = i < web_numplayers;

    if (!netgame)
        consoleplayer = displayplayer = 0;
}

//
// D_QuitNetGame
//
void D_QuitNetGame (void)
{
    if (!netgame || !usergame || consoleplayer == -1 || demoplayback)
        return;

    EM_ASM ({ if (Module.netQuit) Module.netQuit(); });
}

//
// TryRunTics
// Run every tic that is both sealed and due. Never blocks, never spins:
// if the relay is behind, we render the frozen world and return.
//
void TryRunTics (void)
{
    int i;
    int lowtic;
    int entertic;
    static int oldentertics;
    int realtics;
    int counts;

    entertic = I_GetTime ();
    realtics = entertic - oldentertics;
    oldentertics = entertic;

    NetUpdate ();

    lowtic = MAXINT;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && nettics[i] < lowtic)
            lowtic = nettics[i];

    // Sealed and due. realtics caps sim speed at wall-clock rate; the
    // +web_inputdelay slack lets a late frame catch up gradually.
    counts = lowtic - gametic;
    if (counts > realtics + web_inputdelay)
        counts = realtics + web_inputdelay;

    while (counts-- > 0)
    {
        if (advancedemo)
            D_DoAdvanceDemo ();
        M_Ticker ();
        G_Ticker ();
        gametic++;
        web_lastticms = emscripten_get_now ();
        NetUpdate ();   // pick up whatever the frame produced
    }
}

//
// I_GetTimeFrac
// Fraction of the current tic elapsed since the sim last advanced,
// clamped to one tic: a stalled sim (netplay wait, pause) holds still
// instead of sawtoothing between old and current positions.
//
int I_GetTimeFrac (void)
{
    double f = (emscripten_get_now () - web_lastticms) * TICRATE / 1000.0;

    if (f < 0.0) f = 0.0;
    if (f > 1.0) f = 1.0;
    return (int) (f * FRACUNIT);
}
