// webdoom synth_main: the entry points of build/synth.wasm, the OPL synth as a
// standalone module for the AudioWorklet (ledger NC6).
//
// WHY A SECOND MODULE AT ALL
// --------------------------
// `web_music_render` runs on the MAIN thread, pulled by a 100 ms timer in
// client/js/audio.js.  Round 10 measured what that costs per call: 1.84 ms p99
// on alder, 4.09 on tank, 19.7 on wbox — against a 16.7 ms frame.  On wbox that
// is a dropped frame every sixth frame, in a burst the rAF budget cannot
// absorb.  The fix is not to make the synth faster; it is to run it on the
// thread that owns audio.
//
// AudioWorkletGlobalScope has no `fetch` and no `import.meta`, so the worklet
// cannot load an emscripten ES6 module: it is handed the wasm BYTES over its
// port and instantiates them itself.  Hence a reactor (`--no-entry
// -sSTANDALONE_WASM`), not a second copy of the engine.
//
// ZERO DIFF TO THE SYNTH
// ----------------------
// mus_opl.c reaches the engine through exactly four symbols, all inside
// load_bank(): W_CheckNumForName, W_GetNumForName, W_LumpLength and
// W_CacheLumpName, and all four only ever ask for "GENMIDI".  opl3.c reaches
// nothing at all.  So this file provides those four against a caller-supplied
// GENMIDI lump and `mus_opl.c`/`opl3.c` compile UNCHANGED — the very objects
// doom.wasm links are the ones linked here (engine/Makefile builds $(SYNTH)
// from $(BUILD)/obj/web/{mus_opl,opl3,synth_main}.o).  Byte-identity between
// the two synths is then a property of the build, not a thing to test for.
//
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <emscripten.h>
#include <stddef.h>
#include <stdlib.h> /* malloc/free: the worklet allocates through this module */

#include "doomdef.h"
#include "doomtype.h"
#include "w_wad.h"
#include "web.h"

// The GENMIDI lump the caller handed us.  load_bank() is the only reader.
static byte* genmidi;
static int genmidi_len;
// The song currently owned by this module.  mus_play keeps the caller's
// pointer rather than copying, so the block must outlive the call.
static byte* song;

// --- the four W_ symbols mus_opl.c's load_bank() needs -------------------
// Only "GENMIDI" is ever asked for; anything else is absent, which is a state
// load_bank already handles (it keeps its built-in bank).

int W_CheckNumForName (char* name)
{
    (void) name;
    return genmidi ? 0 : -1;
}

int W_GetNumForName (char* name)
{
    (void) name;
    return 0;
}

int W_LumpLength (int lump)
{
    (void) lump;
    return genmidi_len;
}

void* W_CacheLumpName (char* name, int tag)
{
    (void) name;
    (void) tag;
    return genmidi;
}

// --- the JS-callable surface ---------------------------------------------
//
// Buffers passed in are allocated by the caller through this module's own
// `malloc` and become the module's; it frees the previous song on replace.

EMSCRIPTEN_KEEPALIVE void synth_play (byte* data, int len, int looping)
{
    mus_play (data, len, looping);
    // mus_play validates the header (MUS\x1a, score bounds) and DECLINES by
    // returning with its own pointer unchanged -- so on a refusal the old block
    // is still live and it is the new one that must go.
    if (web_music_debug (0))
    {
        free (song); /* free(NULL) on the first call is fine */
        song = data;
    }
    else
        free (data);
}

EMSCRIPTEN_KEEPALIVE void synth_stop (void)
{
    mus_stop ();
}

EMSCRIPTEN_KEEPALIVE void synth_pause (int on)
{
    mus_pause (on);
}

EMSCRIPTEN_KEEPALIVE void synth_volume (int vol127)
{
    mus_setvolume (vol127);
}

// Bring the module to the state the engine's own synth is in when JS arms the
// AudioContext.  THE ORDER IS THE CONTRACT, because OPL3_WriteRegBuffered
// timestamps every register write: the key-offs a fresh mus_play issues shift
// every later write by 18 samples unless a reset follows them, and the output
// is then not byte-identical to the engine's.  The engine's real sequence is
//
//   mus_init(44100)              I_InitMusic, from D_DoomMain
//   mus_setvolume(1075)          S_Init -> I_SetMusicVolume(127)
//   mus_setvolume(67)            S_Init -> I_SetMusicVolume(snd_MusicVolume=8)
//   mus_play(D_INTRO, 0)         D_StartTitle -> S_StartMusic(mus_intro)
//   mus_init(rate)               client/js/audio.js arm(), at the context rate
//
// and that is what this replays.  Only the last volume matters (no voice is
// live before the song starts), so the caller passes one value.
EMSCRIPTEN_KEEPALIVE void synth_boot (int rate, byte* gm, int gmlen, byte* s,
                                      int slen, int looping, int paused,
                                      int vol127, int oplmode)
{
    genmidi = gm; // before mus_init: load_bank() runs inside it
    genmidi_len = gmlen;
    web_set_opl_mode (oplmode);
    mus_init (rate);
    mus_setvolume (vol127);
    if (s && slen > 0)
        synth_play (s, slen, looping);
    if (paused)
        mus_pause (1);
    mus_init (rate); // the arm-time re-init, which resets the chip
}
