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

#include <string.h>     /* memcpy */

#include "doomdef.h"    /* VERSION, MAXPLAYERS */
#include "doomstat.h"   /* demorecording, demoplayback, consoleplayer, etc. */
#include "d_event.h"    /* gameaction_t, gameaction, ga_nothing */
#include "g_game.h"     /* G_RecordDemo, G_InitNew */
#include "z_zone.h"     /* Z_Malloc, PU_STATIC */

/* Internal demo buffer pointers defined in g_game.c */
extern byte* demobuffer;
extern byte* demo_p;

/* Title-screen demo advance flag defined in d_main.c */
extern boolean advancedemo;

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
//
// ZONE COPY: The raw bytes are copied into a zone-allocator buffer (Z_Malloc,
// PU_STATIC) so that G_CheckDemoStatus can safely call Z_ChangeTag(demobuffer)
// when the DEMOMARKER is reached at end of replay.  Passing a raw heap ptr
// directly as demobuffer causes Z_ChangeTag to read a garbage block header and
// crash the wasm runtime.  Size is computed by scanning for DEMOMARKER after
// the header; since each tic occupies exactly 4 bytes the scan steps 4 bytes
// at a time to avoid false positives on movement/button data.
EMSCRIPTEN_KEEPALIVE int web_play_demo_buf (int heapPtr)
{
    byte*   raw = (byte*)(size_t) heapPtr;
    byte*   p   = raw;
    int     ver, i, total;
    skill_t skill;
    int     episode, map;
    byte*   scan;
    byte*   zone_buf;

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

    // p now points to the first tic (past the 13-byte header).
    // Scan in 4-byte steps for WEBDEMO_MARKER to determine total demo size.
    // Each tic is exactly 4 bytes (forwardmove, sidemove, angleturn, buttons);
    // the marker 0x80 only appears at a 4-byte-aligned position after the header.
    scan = p;
    while (*scan != WEBDEMO_MARKER)
        scan += 4;
    scan++;                         /* include the marker byte */
    total = (int)(scan - raw);      /* header + tic data + marker */

    // Zone-allocate and copy so G_CheckDemoStatus can Z_ChangeTag safely.
    zone_buf = Z_Malloc (total, PU_STATIC, NULL);
    memcpy (zone_buf, raw, total);

    // Adjust pointers to the zone copy.
    demobuffer  = zone_buf;
    demo_p      = zone_buf + (int)(p - raw);

    // Suppress the title-screen demo advance so the WAD's own DEMO* sequence
    // cannot replace our demobuffer on the first G_Ticker tick.  Without this,
    // D_DoAdvanceDemo fires immediately and G_DoPlayDemo overwrites zone_buf
    // with the WAD's DEMO1 bytes, destroying our replay setup.
    advancedemo = false;
    gameaction = ga_nothing;

    // Skip G_InitNew when episode/map are 0: the recording started from the
    // title screen (no level was active at record time).  G_InitNew(skill,0,0)
    // calls P_SetupLevel("E0M0") which is absent from the WAD, triggering
    // I_Error and aborting the wasm runtime.  With no G_InitNew the engine
    // remains in GS_DEMOSCREEN; gametic still advances and prndindex stays 0
    // (P_Random is not called outside GS_LEVEL), producing a deterministic
    // hash sequence that matches the original title-screen recording exactly.
    if (episode > 0 && map > 0)
        G_InitNew (skill, episode, map);

    // Mirror G_DoPlayDemo (g_game.c:1656): replay path requires usergame=false.
    // G_InitNew sets usergame=true; override here so the engine treats this as
    // demo playback, not an active user session.
    usergame = false;
    demoplayback = true;
    return 0;
}
