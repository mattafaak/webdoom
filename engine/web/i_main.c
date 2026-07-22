// webdoom i_main: D_DoomMain runs init and returns (the loop was split
// out); JS then drives D_DoomFrame from requestAnimationFrame. Input
// events are posted from JS through web_input_event.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <emscripten.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_event.h"
#include "d_main.h"
#include "d_player.h"
#include "m_argv.h"
#include "r_main.h"
#include "st_stuff.h"
#include "web.h"
#include "perf.h" // webdoom: per-stage timing

/* Vanilla globals for web_set_detail (14.2b). */
extern int detailLevel;
extern int screenblocks;

//
// web_set_wide (18.2c): deferred widescreen resize.
//
// Stores the requested pixel width in pending_wide_width; the change is
// applied at the *start* of the next web_frame() call, before D_Display
// runs.  This is the only safe point: the renderer tables (xtoviewangle,
// distscale, scalelight, psprite scales, …) must be rebuilt in one
// coherent batch before any column/plane drawing begins.
//
// Rules enforced here:
//   - w > DOOM_ORIGWIDTH → setblocks=11 (full-width render, Hor+).
//   - w == DOOM_ORIGWIDTH → setblocks=10 (320-px centre, vanilla).
//   - ST_Start() is called after the width change so widget x-coords
//     (ST_createWidgets) are re-initialised with the correct WIDESCREENDELTA.
//   - Do NOT call web_set_wide() from inside D_DoomFrame / I_FinishUpdate.
//
static int pending_wide_width = 0;

EMSCRIPTEN_KEEPALIVE void web_set_wide (int w)
{
    pending_wide_width = w;
}

int main (int argc, char** argv)
{
    myargc = argc;
    myargv = argv;

    D_DoomMain (); // returns after init; JS drives frames

    emscripten_exit_with_live_runtime ();
}

EMSCRIPTEN_KEEPALIVE void web_frame (void)
{
    // Deferred width change: consume BEFORE D_Display so render tables
    // and ST widgets are rebuilt for the new screenwidth this frame.
    if (pending_wide_width > 0)
    {
        int w = pending_wide_width;
        pending_wide_width = 0;
        screenwidth = w;
        // setblocks=11 → scaledviewwidth=screenwidth (full Hor+ width).
        // setblocks=10 → scaledviewwidth=320 (vanilla centre).
        R_SetViewSize (w > DOOM_ORIGWIDTH ? 11 : 10, detailLevel);
        // Re-initialise HUD widgets with the new WIDESCREENDELTA so
        // health/ammo numerals appear inside the centred STBAR zone.
        ST_Start ();
    }
    D_DoomFrame ();
}

// type: 0 keydown, 1 keyup, 2 mouse, 3 joystick — mirrors evtype_t.
EMSCRIPTEN_KEEPALIVE void web_input_event (int type, int data1, int data2,
                                           int data3)
{
    event_t ev;

    ev.type = (evtype_t) type;
    ev.data1 = data1;
    ev.data2 = data2;
    ev.data3 = data3;
    D_PostEvent (&ev);
}

//
// Gamepad state, polled by JS once per animation frame. Sets the same
// globals the vanilla joystick events fed, plus the analog strafe axis.
// buttons: bit0 fire, bit1 strafe-mod, bit2 speed, bit3 use.
// Axes -100..100: turn (RS x), fwd (LS y, stick-down positive), strafe (LS x).
//
extern int joyxmove, joyymove, joysidemove;
extern boolean* joybuttons;

EMSCRIPTEN_KEEPALIVE void web_gamepad (int buttons, int turn, int fwd,
                                       int strafe)
{
    int i;

    for (i = 0; i < 4; i++)
        joybuttons[i] = (buttons >> i) & 1;
    joyxmove = turn;
    joyymove = fwd;
    joysidemove = strafe;
}

//
// UI-mode probe: JS routes gamepad buttons to menu keys when the menu
// (or any non-level screen) has focus, and to game buttons otherwise.
//
extern boolean menuactive;

EMSCRIPTEN_KEEPALIVE int web_ui_mode (void)
{
    return menuactive || gamestate != GS_LEVEL;
}

// webdoom: test-support export — 1 when any menu is open, 0 otherwise.
// Used by persist-test.mjs Phase 2b to discriminate selectable vs.
// unselectable load-game slots: a status-1 slot triggers M_LoadSelect →
// M_ClearMenus → menuactive=0; a status-0 slot does nothing and the
// menu stays open.
EMSCRIPTEN_KEEPALIVE int web_menu_active (void)
{
    return menuactive;
}

//
// web_set_console
// Repoint the console/display player. A drop-in boots as its own (not-yet-
// ingame) slot, whose mobj is NULL during catch-up replay; point the
// cosmetic tickers at an already-live slot for the replay, then restore the
// real slot when the player spawns. consoleplayer is display-only — it never
// touches the deterministic simulation — so this cannot affect lockstep.
//
void ST_Start (void);

EMSCRIPTEN_KEEPALIVE void web_set_console (int player)
{
    consoleplayer = displayplayer = player;
    ST_Start (); // rebind the status bar to the new view player
}

//
// Table-generation access for tools/gen-tables.mjs: run the generator
// standalone and read the raw arrays (the fix stream starts empty).
//
#include "tables.h"

EMSCRIPTEN_KEEPALIVE void web_gen_tables (void)
{
    T_GenerateTables ();
}

EMSCRIPTEN_KEEPALIVE int* web_table (int which)
{
    switch (which)
    {
    case 0:
        return (int*) finesine;
    case 1:
        return (int*) finetangent;
    case 2:
        return (int*) tantoangle;
    }
    return 0;
}

//
// Lobby names → in-game chat prefixes ("Name: "). Vanilla strings live
// in player_names[]; we repoint entries at static buffers.
//
extern char* player_names[];

EMSCRIPTEN_KEEPALIVE void web_set_player_name (int player, const char* name)
{
    static char buf[MAXPLAYERS][16];

    if (player < 0 || player >= MAXPLAYERS || !name || !name[0])
        return;
    snprintf (buf[player], sizeof buf[player], "%.10s: ", name);
    player_names[player] = buf[player];
}

//
// Config flush: vanilla only writes .doomrc at I_Quit, which a browser
// tab never reaches. JS calls this periodically so menu settings
// (screen size, volumes, gamma) survive reloads.
//
void M_SaveDefaults (void);

EMSCRIPTEN_KEEPALIVE void web_save_defaults (void)
{
    M_SaveDefaults ();
}

//
// Freelook: render-local y-shear in screen pixels. Never enters the
// simulation (autoaim untouched) — safe for demos and netplay.
//
extern int lookdir;

EMSCRIPTEN_KEEPALIVE void web_set_pitch (int pixels)
{
    lookdir = pixels;
}

//
// Render interpolation toggle ("vanilla mode" = 35fps feel).
//
extern boolean smoothrender;

EMSCRIPTEN_KEEPALIVE void web_set_smooth (int on)
{
    smoothrender = on;
}

//
// web_set_detail (14.2b): opt-in detail level for bare-metal/testing use.
// Routes through the vanilla R_SetViewSize mechanism so R_ExecuteSetViewSize
// rebuilds view tables with the new detailshift on the next D_DoomFrame.
// detail=0 → high-detail (R_DrawColumn/R_DrawSpan, default).
// detail=1 → low-detail  (R_DrawColumnLow/R_DrawSpanLow, halved h-res).
// Do NOT poke detailshift directly — view tables must be rebuilt vanilla's way.
//
EMSCRIPTEN_KEEPALIVE void web_set_detail (int detail)
{
    R_SetViewSize (screenblocks, detail);
}

//
// Gamestate fingerprint for the netplay and demo-compatibility
// harnesses: identical simulations must return identical values at the
// same gametic. prndindex (the P_Random cursor) is the sharpest desync
// detector — any diverging gameplay decision shifts RNG consumption.
//
extern int prndindex;

EMSCRIPTEN_KEEPALIVE int web_state_hash (void)
{
    unsigned h = 0x9e3779b9u ^ (unsigned) gametic;
    int i;

    h = (h ^ (unsigned) prndindex) * 0x01000193u;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && players[i].mo)
        {
            h = (h ^ (unsigned) players[i].mo->x) * 0x01000193u;
            h = (h ^ (unsigned) players[i].mo->y) * 0x01000193u;
            h = (h ^ (unsigned) players[i].mo->angle) * 0x01000193u;
            h = (h ^ (unsigned) players[i].health) * 0x01000193u;
        }
    return (int) h;
}

EMSCRIPTEN_KEEPALIVE int web_gametic (void)
{
    return gametic;
}

// web_screenwidth (18.2c): returns the current runtime screenwidth.
// Used by the sim-invariance gate to assert screenwidth > 320 when
// wide mode is active (proving the deferred resize took effect).
EMSCRIPTEN_KEEPALIVE int web_screenwidth (void)
{
    return screenwidth;
}

//
// web_ingame_mask: current playeringame bitmask (drop-in test assertion).
//
EMSCRIPTEN_KEEPALIVE int web_ingame_mask (void)
{
    int i, m = 0;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i])
            m |= 1 << i;
    return m;
}

//
// Raw player-0 tuple for cross-validation against a reference port
// (Chocolate Doom instrumented to print the same fields per tic).
//
EMSCRIPTEN_KEEPALIVE void web_demo_state (int* out)
{
    out[0] = prndindex;
    out[1] = players[0].mo ? players[0].mo->x : 0;
    out[2] = players[0].mo ? players[0].mo->y : 0;
    out[3] = players[0].mo ? (int) players[0].mo->angle : 0;
    out[4] = players[0].health;
}

//
// Weapon state for gamepad cycle buttons: low 4 bits = ready weapon,
// bits 8.. = owned-weapon mask.
//
EMSCRIPTEN_KEEPALIVE int web_weapon_state (void)
{
    player_t* p = &players[consoleplayer];
    int owned = 0, i;

    for (i = 0; i < NUMWEAPONS; i++)
        if (p->weaponowned[i])
            owned |= 1 << i;
    return (p->readyweapon & 15) | (owned << 8);
}

//
// web_wipe_skip
// Instantly clears the melt-wipe state machine so bench.mjs can jump
// straight to measurement frames without waiting for wall-clock time.
// The wipe is purely cosmetic — calling this does not affect simulation.
//
extern boolean wipeactive;

EMSCRIPTEN_KEEPALIVE void web_wipe_skip (void)
{
    wipeactive = 0;
}
