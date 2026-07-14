// webdoom i_main: D_DoomMain runs init and returns (the loop was split
// out); JS then drives D_DoomFrame from requestAnimationFrame. Input
// events are posted from JS through web_input_event.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <emscripten.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_event.h"
#include "d_main.h"
#include "d_player.h"
#include "m_argv.h"
#include "web.h"

int main (int argc, char** argv)
{
    myargc = argc;
    myargv = argv;

    D_DoomMain ();      // returns after init; JS drives frames

    emscripten_exit_with_live_runtime ();
}

EMSCRIPTEN_KEEPALIVE
void web_frame (void)
{
    D_DoomFrame ();
}

// type: 0 keydown, 1 keyup, 2 mouse, 3 joystick — mirrors evtype_t.
EMSCRIPTEN_KEEPALIVE
void web_input_event (int type, int data1, int data2, int data3)
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
extern int      joyxmove, joyymove, joysidemove;
extern boolean* joybuttons;

EMSCRIPTEN_KEEPALIVE
void web_gamepad (int buttons, int turn, int fwd, int strafe)
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

EMSCRIPTEN_KEEPALIVE
int web_ui_mode (void)
{
    return menuactive || gamestate != GS_LEVEL;
}

//
// Weapon state for gamepad cycle buttons: low 4 bits = ready weapon,
// bits 8.. = owned-weapon mask.
//
EMSCRIPTEN_KEEPALIVE
int web_weapon_state (void)
{
    player_t* p = &players[consoleplayer];
    int owned = 0, i;

    for (i = 0; i < NUMWEAPONS; i++)
        if (p->weaponowned[i])
            owned |= 1 << i;
    return (p->readyweapon & 15) | (owned << 8);
}
