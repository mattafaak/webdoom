// webdoom demo recording/playback bridge.
// Provides JS-callable functions to record user gameplay into a .lmp buffer
// and to replay a .lmp from wasm heap memory — bypassing the WAD lump system
// and G_CheckDemoStatus (which calls I_Error and would abort the runtime).
//
// Recording contract:
//   1. Pass '-record webdemo' to callMain; G_RecordDemo is called after Z_Init
//      in D_DoomMain, and G_BeginRecording is called from D_DoomLoop.
//   2. Optionally call web_set_singletics(1) after callMain so that every
//      web_frame() call advances exactly one tic regardless of wall-clock time.
//      This is essential in Node.js test harnesses where emscripten_get_now()
//      barely advances in a tight loop (only ~1 tic/second without it).
//   3. Drive frames with web_frame() — each tic is written to demobuffer.
//   4. Call web_demo_stop() to append DEMOMARKER and stop recording.
//      Returns byte count; caller slices HEAPU8[web_demo_buf_ptr()..+count].
//
// Playback contract:
//   1. Allocate wasm heap memory and copy .lmp bytes in (_malloc + HEAPU8.set).
//   2. Optionally call web_set_singletics(1) for wall-clock-free replay.
//   3. Call web_play_demo_buf(heapPtr).  Returns 0 on success, -1 on error.
//      Internally calls G_InitNew from the demo header, then sets demoplayback.
//   4. Drive frames with web_frame() until web_demo_playing() returns 0.
//
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stddef.h>
#include <emscripten.h>

#include "doomdef.h"    /* VERSION, MAXPLAYERS */
#include "doomstat.h"   /* demorecording, demoplayback, consoleplayer, etc. */
#include "d_event.h"    /* gameaction_t, gameaction, ga_nothing */
#include "g_game.h"     /* G_RecordDemo, G_InitNew */

/* Internal demo buffer pointers defined in g_game.c */
extern byte* demobuffer;
extern byte* demo_p;

/* DEMOMARKER is #defined inside g_game.c — duplicate the value here. */
#define WEBDEMO_MARKER 0x80

// web_set_singletics: enable/disable single-tic-per-frame mode.
// When on != 0, every web_frame() call advances exactly one game tic
// regardless of wall-clock time (bypasses I_GetTime gating in TryRunTics).
// This mirrors the effect of G_TimeDemo's singletics=true, without requiring
// the demo to be played back via the WAD lump system.
// Essential for Node.js test harnesses where emscripten_get_now() barely
// advances in tight loops, causing TryRunTics to advance only ~1 tic/run.
extern boolean singletics;   /* d_main.c: debug flag, also set by timedemo */

EMSCRIPTEN_KEEPALIVE void web_set_singletics (int on)
{
    singletics = on ? true : false;
}

// web_demo_start: arm the engine for demo recording.
// IMPORTANT: This function calls G_RecordDemo which calls Z_Malloc.
// Z_Zone is only initialized during callMain (Z_Init inside D_DoomMain).
// Therefore this function must be called AFTER callMain has been called.
// For typical use, pass "-record webdemo" as a callMain argument instead:
//   doom.callMain(['-warp', '1', '1', '-nodraw', '-record', 'webdemo'])
// That path calls G_RecordDemo from D_DoomMain (after Z_Init) and
// G_BeginRecording from D_DoomLoop, which is the safe sequence.
// This JS-callable version is provided for post-init arm (e.g. mid-session
// prepare before a level transition), but requires Z_Zone to be live.
EMSCRIPTEN_KEEPALIVE void web_demo_start (void)
{
    G_RecordDemo ("webdemo");
}

// web_demo_stop: finalise the current recording.
// Appends the DEMOMARKER byte, sets demorecording=false, and returns the
// total byte count of the complete .lmp (header + tic data + marker).
// Does NOT call G_CheckDemoStatus — that function calls I_Error("Demo
// recorded") which aborts the wasm runtime.
// Returns 0 if not currently recording.
EMSCRIPTEN_KEEPALIVE int web_demo_stop (void)
{
    if (!demorecording)
        return 0;
    *demo_p++ = WEBDEMO_MARKER;
    demorecording = false;
    return (int)(demo_p - demobuffer);
}

// web_demo_buf_ptr: wasm heap address of the demo buffer.
// Valid between web_demo_start() and the next web_demo_start() call.
// Use HEAPU8.slice(ptr, ptr + count) in JS to copy the bytes out.
EMSCRIPTEN_KEEPALIVE int web_demo_buf_ptr (void)
{
    return (int)(size_t) demobuffer;
}

// web_demo_playing: returns 1 while demo playback is active, 0 when done.
// Transitions from 1 to 0 when the DEMOMARKER is reached (G_CheckDemoStatus
// clears demoplayback and calls D_AdvanceDemo in the non-singledemo path).
EMSCRIPTEN_KEEPALIVE int web_demo_playing (void)
{
    return demoplayback ? 1 : 0;
}

// web_play_demo_buf: start replaying a .lmp from wasm heap memory.
// heapPtr: wasm heap address of the raw demo bytes (must stay allocated).
// Parses the demo header, calls G_InitNew with the embedded params, then
// sets demoplayback=true so G_Ticker reads inputs from demobuffer.
// Returns 0 on success, -1 if the demo version byte is not 109 or 110.
EMSCRIPTEN_KEEPALIVE int web_play_demo_buf (int heapPtr)
{
    byte*   buf = (byte*)(size_t) heapPtr;
    byte*   p   = buf;
    int     ver, i;
    skill_t skill;
    int     episode, map;

    ver = (int)*p++;
    if (ver != VERSION && ver != 109)
        return -1;

    skill        = (skill_t)*p++;
    episode      = (int)*p++;
    map          = (int)*p++;
    deathmatch   = (boolean)*p++;
    respawnparm  = (boolean)*p++;
    fastparm     = (boolean)*p++;
    nomonsters   = (boolean)*p++;
    consoleplayer = (int)*p++;
    for (i = 0; i < MAXPLAYERS; i++)
        playeringame[i] = (boolean)*p++;

    // Point demobuffer at buffer start; demo_p at tic data (past header).
    demobuffer  = buf;
    demo_p      = p;

    // G_InitNew sets demoplayback=false; we restore it after.
    gameaction = ga_nothing;
    G_InitNew (skill, episode, map);
    demoplayback = true;
    return 0;
}
