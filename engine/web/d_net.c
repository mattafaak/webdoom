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
static double web_lastticms; // when the sim last advanced (ms)
int nettics[MAXNETNODES];    // per PLAYER here; sealed-through tic
int maketic;
int ticdup = 1;

// How many tics of input to build ahead of the sealed frontier. LAN=1.
// The JS bridge can raise it from measured RTT before the game starts.
static int web_inputdelay = 1;
static int web_numplayers = 1;
static int web_localslot = 0; // this client's own slot (for view auto-restore)
boolean web_replaying =
    false; // true only inside web_replay_tic (skip cosmetic tickers)

void D_ProcessEvents (void);
void G_BuildTiccmd (ticcmd_t* cmd);
void D_DoAdvanceDemo (void);
void ST_Start (void);
extern boolean advancedemo;

// Send one local ticcmd to the relay. No-op stub until the JS side
// defines it (single player, or netcode phase not wired yet).
// clang-format off
EM_JS (void, js_net_send, (int tic, ticcmd_t* cmd, int size), {
    if (Module["netSend"]) Module["netSend"](tic, cmd, size);
});
// clang-format on

//
// web_net_setup
// Called from JS before main() when entering a lobby game. Slots are
// sparse (color choice = slot choice): numplayers is the bundle width
// (always MAXPLAYERS from the relay) and ingamemask marks real players.
//
static int web_ingamemask;

EMSCRIPTEN_KEEPALIVE void web_net_setup (int player, int numplayers,
                                         int ingamemask)
{
    consoleplayer = displayplayer = player;
    web_localslot = player;
    web_numplayers = numplayers;
    web_ingamemask = ingamemask;
    netgame = true;
}

EMSCRIPTEN_KEEPALIVE void web_net_set_delay (int tics)
{
    if (tics < 1)
        tics = 1;
    if (tics > BACKUPTICS / 2 - 1)
        tics = BACKUPTICS / 2 - 1;
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
static byte
    ingamering[BACKUPTICS];  // per-tic ingame mask, applied at the sim tic
int web_joinTic[MAXPLAYERS]; // gametic each slot went live (consistancy skip)

EMSCRIPTEN_KEEPALIVE void web_net_bundle (int tic, ticcmd_t* cmds, byte* ingame,
                                          int fabmask)
{
    int i;
    byte mask = 0;

    fabricated[tic % BACKUPTICS] = (byte) fabmask;
    for (i = 0; i < web_numplayers; i++)
    {
        if (ingame[i])
        {
            mask |= 1 << i;
            netcmds[i][tic % BACKUPTICS] = cmds[i];
        }
        nettics[i] = tic + 1;
    }
    // The roster is applied at the sim tic (apply_roster), NOT here: bundles
    // arrive ahead of the sim, so writing playeringame now would flip a
    // join/leave at a per-client-variable moment and desync. Stash the mask
    // per tic instead.
    ingamering[tic % BACKUPTICS] = mask;
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

EMSCRIPTEN_KEEPALIVE ticcmd_t* web_net_scratch (void)
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
        if (maketic - gametic >= BACKUPTICS / 2 - 1)
            break; // can't hold any more

        G_BuildTiccmd (&localcmds[maketic % BACKUPTICS]);

        if (netgame)
            js_net_send (maketic, &localcmds[maketic % BACKUPTICS],
                         sizeof (ticcmd_t));
        else
        {
            netcmds[consoleplayer][maketic % BACKUPTICS] =
                localcmds[maketic % BACKUPTICS];
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
        playeringame[i] =
            netgame ? (web_ingamemask >> i) & 1 : i < web_numplayers;

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

    // clang-format off
    EM_ASM ({ if (Module["netQuit"]) Module["netQuit"](); });
    // clang-format on
}

//
// apply_roster
// Bring playeringame into line with the sealed mask for `tic` at the exact
// instant the sim runs it (netplay only — single player's roster is fixed
// by D_CheckNetGame). A slot going 0->1 is a drop-in: mark it PST_REBORN so
// G_Ticker spawns it (coop start or a P_Random deathmatch spot) on this very
// tic, identically on every client because they share the deterministic
// state and the sealed mask.
//
static void apply_roster (int tic)
{
    byte mask = ingamering[tic % BACKUPTICS];
    int i;

    for (i = 0; i < web_numplayers; i++)
    {
        boolean now = (mask >> i) & 1;
        if (now && !playeringame[i])
        {
            players[i].playerstate = PST_REBORN;
            web_joinTic[i] = tic;
            // our own slot just spawned: snap the view back to it (the
            // catch-up replay had parked it on an already-live player) and
            // rebind the status bar to us
            if (i == web_localslot)
            {
                consoleplayer = displayplayer = i;
                ST_Start ();
            }
        }
        playeringame[i] = now;
    }
}

//
// run_tic
// Advance the simulation exactly one tic. Shared by the live loop below and
// the join catch-up replay (web_replay_tic). Does not touch the network or
// the clock pacing — the caller owns those.
//
static void run_tic (void)
{
    if (netgame)
        apply_roster (gametic);
    if (advancedemo)
        D_DoAdvanceDemo ();
    M_Ticker ();
    G_Ticker ();
    gametic++;
    web_lastticms = emscripten_get_now ();
}

//
// web_replay_tic
// Run one sim tic unpaced (no wall-clock gate, no render/sound), consuming
// the bundle a JS catch-up loop has already fed into netcmds. Lets a joiner
// re-simulate the whole cmd history to the live frontier in a fraction of a
// second, arriving at the identical world state by construction.
//
EMSCRIPTEN_KEEPALIVE void web_replay_tic (void)
{
    web_replaying = true;
    run_tic ();
    web_replaying = false;
}

//
// web_end_catchup
// Called once a drop-in has replayed to the frontier and is about to go live.
// Replay advanced gametic but never maketic, so without this the joiner would
// build cmds from maketic 0 — ancient tics the relay discards — and freeze
// until maketic crawled back up to gametic. Snap maketic to gametic (and the
// clocks to now) so the very next NetUpdate sends cmds for CURRENT tics.
//
EMSCRIPTEN_KEEPALIVE void web_end_catchup (void)
{
    maketic = gametic;
}

//
// web_first_ingame
// Lowest currently-live slot (or -1). A joiner parks the view here for the
// brief window between going live and its own slot spawning.
//
EMSCRIPTEN_KEEPALIVE int web_first_ingame (void)
{
    int i;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i])
            return i;
    return -1;
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

    if (netgame)
    {
        // Jitter buffer. Network delivery is uneven, so running straight to
        // the sealed frontier makes the sim alternate stalls with multi-tic
        // catch-up bursts — and render interpolation only smooths a burst's
        // last tic, so the rest reads as a rubber-band jump.
        //
        // Instead aim at a point web_inputdelay tics BEHIND the frontier and
        // advance toward it at wall-clock rate (realtics = 0 or 1 per 60fps
        // frame). The buffer is runway: when jitter briefly freezes the
        // frontier the sim keeps gliding on the runway instead of stalling,
        // and when the frontier lurches forward the realtics cap stops the
        // sim from swallowing the gap in one visible jump. Target and gametic
        // share the level-relative tic origin — I_GetTime counts from boot,
        // so it can't be the reference here.
        int target = lowtic - web_inputdelay;
        counts = target - gametic;
        // Steady state paces strictly at wall-clock (realtics = 0 or 1 per
        // frame) so the view never jumps — ordinary jitter just breathes the
        // buffer depth in and out, invisibly. The one exception is a safety
        // drain: if a stall far deeper than the buffer has let the frontier
        // margin grow past twice its target, reclaim latency one tic/frame so
        // input lag can't creep upward without bound on a bad link.
        int cap =
            (lowtic - gametic > 2 * web_inputdelay) ? realtics + 1 : realtics;
        if (counts > cap)
            counts = cap;
        if (counts > lowtic - gametic) // never run past sealed tics
            counts = lowtic - gametic;
    }
    else
    {
        // Single player: no network, so the frontier is always ready;
        // run to it, capped at wall-clock rate plus a tic of slack.
        counts = lowtic - gametic;
        if (counts > realtics + web_inputdelay)
            counts = realtics + web_inputdelay;
    }
    if (counts < 0)
        counts = 0;

    while (counts-- > 0)
    {
        run_tic ();
        NetUpdate (); // pick up whatever the frame produced
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

    if (f < 0.0)
        f = 0.0;
    if (f > 1.0)
        f = 1.0;
    return (int) (f * FRACUNIT);
}
