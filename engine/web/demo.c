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
// Seek contract (task 19.3):
//   1. web_play_demo_buf must have been called successfully (zone copy is
//   live).
//   2. web_set_singletics(1) must be set (seek uses singletics for exact tic
//      counting; calling code must ensure this before web_seek_demo).
//   3. Call web_seek_demo(N): rewinds demo_p to header+13, re-calls G_InitNew,
//      fast-forwards N tics with nodrawers=1 (no rendering), restores
//      nodrawers=0.  Returns actual tic reached (< N only if demo ended early).
//   4. After web_seek_demo returns, call web_wipe_skip() then web_frame() once
//      to render the final frame at tic N.
//   Zone invariant: web_seek_demo never calls Z_Malloc — it reuses the zone
//   copy made by web_play_demo_buf.  Repeated seeks keep web_zone_hwm flat
//   (G_InitNew calls Z_FreeTags(PU_LEVEL) which reclaims and rebuilds level
//   data in-place, so the level HWM stabilises after the first seek).
//
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stddef.h>
#include <emscripten.h>

#include <string.h> /* memcpy */

#include "doomdef.h"  /* VERSION, MAXPLAYERS */
#include "doomstat.h" /* demorecording, demoplayback, consoleplayer, etc. */
#include "d_event.h"  /* gameaction_t, gameaction, ga_nothing */
#include "web.h"      /* D_DoomFrame (for web_seek_demo fast-forward) */
#include "g_game.h"   /* G_RecordDemo, G_InitNew */
#include "z_zone.h"   /* Z_Malloc, PU_STATIC */

/* Internal demo buffer pointers defined in g_game.c */
extern byte* demobuffer;
extern byte* demo_p;

/* Title-screen demo advance flag defined in d_main.c */
extern boolean advancedemo;

/* Static: demo header params captured by web_play_demo_buf for seek reuse. */
/* web_seek_demo re-calls G_InitNew without re-parsing raw bytes. */
static skill_t seek_skill = sk_medium;
static int seek_episode = 0;
static int seek_map = 0;

/* DEMOMARKER is #defined inside g_game.c — duplicate the value here. */
#define WEBDEMO_MARKER 0x80

// web_set_singletics: enable/disable single-tic-per-frame mode.
// When on != 0, every web_frame() call advances exactly one game tic
// regardless of wall-clock time (bypasses I_GetTime gating in TryRunTics).
// This mirrors the effect of G_TimeDemo's singletics=true, without requiring
// the demo to be played back via the WAD lump system.
// Essential for Node.js test harnesses where emscripten_get_now() barely
// advances in tight loops, causing TryRunTics to advance only ~1 tic/run.
extern boolean singletics; /* d_main.c: debug flag, also set by timedemo */

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
    return (int) (demo_p - demobuffer);
}

// web_demo_buf_ptr: wasm heap address of the demo buffer.
// Valid between web_demo_start() and the next web_demo_start() call.
// Use HEAPU8.slice(ptr, ptr + count) in JS to copy the bytes out.
EMSCRIPTEN_KEEPALIVE int web_demo_buf_ptr (void)
{
    return (int) (size_t) demobuffer;
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
    byte* raw = (byte*) (size_t) heapPtr;
    byte* p = raw;
    int ver, i, total;
    skill_t skill;
    int episode, map;
    byte* scan;
    byte* zone_buf;

    ver = (int) *p++;
    if (ver != VERSION && ver != 109)
        return -1;

    skill = (skill_t) *p++;
    episode = (int) *p++;
    map = (int) *p++;
    deathmatch = (boolean) *p++;
    respawnparm = (boolean) *p++;
    fastparm = (boolean) *p++;
    nomonsters = (boolean) *p++;
    consoleplayer = (int) *p++;
    for (i = 0; i < MAXPLAYERS; i++)
        playeringame[i] = (boolean) *p++;

    // Store header params for web_seek_demo (task 19.3 seek reuse).
    seek_skill = skill;
    seek_episode = episode;
    seek_map = map;

    // p now points to the first tic (past the 13-byte header).
    // Scan in 4-byte steps for WEBDEMO_MARKER to determine total demo size.
    // Each tic is exactly 4 bytes (forwardmove, sidemove, angleturn, buttons);
    // the marker 0x80 only appears at a 4-byte-aligned position after the
    // header. Bounded: a hostile shared demo with no marker must not walk the
    // whole wasm heap (server PER_DEMO_CAP is 1 MiB; +16 covers header slack).
    scan = p;
    while (scan < raw + (1024 * 1024 + 16) && *scan != WEBDEMO_MARKER)
        scan += 4;
    if (*scan != WEBDEMO_MARKER)
        return -1;              /* no terminator within cap — reject */
    scan++;                     /* include the marker byte */
    total = (int) (scan - raw); /* header + tic data + marker */

    // Zone-allocate and copy so G_CheckDemoStatus can Z_ChangeTag safely.
    zone_buf = Z_Malloc (total, PU_STATIC, NULL);
    memcpy (zone_buf, raw, total);

    // Adjust pointers to the zone copy.
    demobuffer = zone_buf;
    demo_p = zone_buf + (int) (p - raw);

    // Suppress the title-screen demo advance so the WAD's own DEMO* sequence
    // cannot replace our demobuffer on the first G_Ticker tick.  Without this,
    // D_DoAdvanceDemo fires immediately and G_DoPlayDemo overwrites zone_buf
    // with the WAD's DEMO1 bytes, destroying our replay setup.
    advancedemo = false;
    gameaction = ga_nothing;

    // Reject out-of-range level indices (episode 0 or map 0).
    // Without a valid level the engine stays in GS_DEMOSCREEN; when the
    // DEMOMARKER is reached G_CheckDemoStatus calls D_AdvanceDemo which sets
    // advancedemo=true.  D_DoAdvanceDemo then fires within the same
    // D_DoomFrame call (singletics path), starting the attract-mode carousel.
    // Because demoplayback goes false→true inside one web_frame() invocation,
    // the JS-side web_demo_playing() check never sees the transition and the
    // replay loop runs until REPLAY_TIC_CAP is exhausted (~hang).
    // Valid DOOM ranges: episode 1-4, map 1-9 (retail/shareware);
    //                   episode 1,   map 1-32 (commercial/tnt/plutonia).
    if (episode == 0 || map == 0)
        return -1;             /* hostile: out-of-range level index, reject */

    G_InitNew (skill, episode, map);

    // Mirror G_DoPlayDemo (g_game.c:1656): replay path requires usergame=false.
    // G_InitNew sets usergame=true; override here so the engine treats this as
    // demo playback, not an active user session.
    usergame = false;
    demoplayback = true;
    return 0;
}

// web_set_nodraw: enable/disable the renderer (nodrawers flag, task 19.3).
// When on != 0, D_Display returns immediately without rendering any pixels.
// Enables fast-forward during seek: web_seek_demo sets nodrawers=1 while
// replaying tics at speed, then restores nodrawers=0 so the final frame
// is rendered normally.
// The wipe state machine is skipped in nodrawers mode (D_Display returns
// before checking wipeactive), so web_wipe_skip() is only needed before
// the final rendering web_frame() call after seek.
EMSCRIPTEN_KEEPALIVE void web_set_nodraw (int on)
{
    nodrawers = on ? true : false;
}

// web_seek_demo: seek to targetTic by re-simming from tic 0 (task 19.3).
//
// Algorithm:
//   1. Rewind demo_p to demobuffer+13 (first tic after the 13-byte header).
//   2. Re-call G_InitNew(seek_skill, seek_episode, seek_map) to reset sim
//      state: P_SetupLevel → Z_FreeTags(PU_LEVEL) reclaims and rebuilds
//      level data in-place.  No new Z_Malloc for the demo buffer.
//   3. Fast-forward targetTic tics with nodrawers=1 (D_Display skipped).
//      Requires singletics=1 so each D_DoomFrame advances exactly one tic.
//   4. Restore nodrawers=0 before returning.
//
// Caller must:
//   - Have called web_play_demo_buf successfully (zone copy live).
//   - Have called web_set_singletics(1) before any replay frames.
//   - Call web_wipe_skip() then web_frame() once after return to render.
//
// Returns: actual tic reached (== targetTic unless demo ended early, < 0 if
//   web_play_demo_buf was never called).
EMSCRIPTEN_KEEPALIVE int web_seek_demo (int targetTic)
{
    int i;

    // Guard: seek_episode==0 means web_play_demo_buf was never called with
    // a valid level-based demo (title-screen demos have episode=0).
    // demoplayback may have been cleared by end-of-demo; that is normal after
    // a seek completes — rely on seek_episode to gate the initial call.
    if (seek_episode == 0 && seek_map == 0)
        return -1;

    // Rewind to first tic: demobuffer+13 skips the 13-byte header.
    // The zone copy (PU_STATIC) persists across seeks — no new Z_Malloc.
    demo_p = demobuffer + 13;
    advancedemo = false;
    gameaction = ga_nothing;

    // Reset sim state.  G_InitNew → P_SetupLevel → Z_FreeTags(PU_LEVEL)
    // reclaims level heap and rebuilds it — HWM stabilises after first seek.
    if (seek_episode > 0 && seek_map > 0)
        G_InitNew (seek_skill, seek_episode, seek_map);

    // Restore demo-playback flags (G_InitNew sets usergame=true).
    usergame = false;
    demoplayback = true;

    // Fast-forward: nodrawers=1 makes D_Display return immediately, cutting
    // seek cost to pure sim throughput (~100× realtime on wbox at 35 Hz).
    nodrawers = true;
    for (i = 0; i < targetTic && demoplayback; i++)
        D_DoomFrame ();
    nodrawers = false;

    return i; /* actual tic reached */
}
