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
//   3. Call web_play_demo_buf(heapPtr, len).  Returns 0 on success, -1 on
//   error.
//      `len` is the size of the buffer at heapPtr and is mandatory: without
//      it the terminator scan is unbounded with respect to the allocation.
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
extern byte* demoend; /* g_game.c: demobuffer + maxsize */

/* Title-screen demo advance flag defined in d_main.c */
extern boolean advancedemo;

/* Static: demo header params captured by web_play_demo_buf for seek reuse. */
/* web_seek_demo re-calls G_InitNew without re-parsing raw bytes. */
static skill_t seek_skill = sk_medium;
static int seek_episode = 0;
static int seek_map = 0;

/* DEMOMARKER is #defined inside g_game.c — duplicate the value here. */
#define WEBDEMO_MARKER 0x80

// one tic per web_frame() regardless of wall clock (G_TimeDemo's singletics)
extern boolean singletics; /* d_main.c: debug flag, also set by timedemo */

EMSCRIPTEN_KEEPALIVE void web_set_singletics (int on)
{
    singletics = on ? true : false;
}

// Arm recording after callMain (G_RecordDemo needs the zone allocator).  The
// usual path is the '-record webdemo' callMain argument instead.
EMSCRIPTEN_KEEPALIVE void web_demo_start (void)
{
    G_RecordDemo ("webdemo");
}

// Append the marker and stop; returns the .lmp byte count (0 if not
// recording).  Not G_CheckDemoStatus, whose I_Error would abort the runtime.
// A recording that fills the 0x20000-byte buffer (15.6 min) ends in
// G_WriteDemoTiccmd's own I_Error instead -- fail-soft, docs/formats.md 4.2.
EMSCRIPTEN_KEEPALIVE int web_demo_stop (void)
{
    if (!demorecording)
        return 0;
    // G_WriteDemoTiccmd stops at demoend - 16, so there is always room; the
    // bound is stated here rather than inherited
    if (demo_p >= demoend)
    {
        demorecording = false;
        return (int) (demo_p - demobuffer);
    }
    *demo_p++ = WEBDEMO_MARKER;
    demorecording = false;
    return (int) (demo_p - demobuffer);
}

// wasm heap address of the demo buffer, valid until the next recording
EMSCRIPTEN_KEEPALIVE int web_demo_buf_ptr (void)
{
    return (int) (size_t) demobuffer;
}

// 1 while playback is active; 0 once the marker is reached
EMSCRIPTEN_KEEPALIVE int web_demo_playing (void)
{
    return demoplayback ? 1 : 0;
}

// Start replaying a .lmp from wasm heap memory: parse the header, G_InitNew,
// then demoplayback so G_Ticker reads from demobuffer.  0 on success, -1 on a
// bad version or a hostile header.  The bytes are copied into a zone block
// (PU_STATIC) because G_CheckDemoStatus calls Z_ChangeTag(demobuffer) at the
// marker, and a raw heap pointer there reads a garbage block header.
EMSCRIPTEN_KEEPALIVE int web_play_demo_buf (int heapPtr, int len)
{
    byte* raw = (byte*) (size_t) heapPtr;
    byte* p = raw;
    byte* end;
    int ver, i, total;
    skill_t skill;
    int episode, map;
    byte* scan;
    byte* zone_buf;

    // len bounds the terminator scan; a call without it marshals as 0 and is
    // rejected rather than overscanned
    if (len < 14) /* 13-byte header + at least one 4-byte tic */
        return -1;
    end = raw + len;

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

    // each tic is exactly 4 bytes, so the marker can only sit 4-aligned
    // after the header; the scan is bounded by len
    scan = p;
    while (scan < end && *scan != WEBDEMO_MARKER)
        scan += 4;
    if (scan >= end || *scan != WEBDEMO_MARKER)
        return -1; /* no terminator inside the buffer — reject */
    if (scan == p)
        return -1;              /* hostile: 0-tic demo (marker at first tic) —
                                   nothing to replay; rejecting avoids the
                                   post-marker attract-carousel states */
    scan++;                     /* include the marker byte */
    total = (int) (scan - raw); /* header + tic data + marker */

    // Zone-allocate and copy so G_CheckDemoStatus can Z_ChangeTag safely.
    zone_buf = Z_Malloc (total, PU_STATIC, NULL);
    memcpy (zone_buf, raw, total);

    // Adjust pointers to the zone copy.
    demobuffer = zone_buf;
    demo_p = zone_buf + (int) (p - raw);

    // or the WAD's own DEMO1 replaces this buffer on the first G_Ticker tick
    advancedemo = false;
    gameaction = ga_nothing;

    // Hostile headers: a level of 0 leaves the engine in GS_DEMOSCREEN and
    // the attract carousel starts inside the same frame (a hang for the JS
    // replay loop); a console player not in game never consumes ticcmds, so
    // the marker is never read.
    if (episode == 0 || map == 0)
        return -1;
    if (skill > sk_nightmare)
        return -1;
    if (consoleplayer < 0 || consoleplayer >= MAXPLAYERS ||
        !playeringame[consoleplayer])
        return -1;

    // kept for web_seek_demo, only once the header has passed
    seek_skill = skill;
    seek_episode = episode;
    seek_map = map;

    G_InitNew (skill, episode, map);

    // as G_DoPlayDemo: G_InitNew set usergame, and a replay is not a session
    usergame = false;
    demoplayback = true;
    return 0;
}

// nodrawers: D_Display returns before drawing (and before the wipe check)
EMSCRIPTEN_KEEPALIVE void web_set_nodraw (int on)
{
    nodrawers = on ? true : false;
}

// Seek to targetTic by re-simming from tic 0 (the seek contract above).
// Returns the tic reached: targetTic unless the demo ended early, -1 if
// web_play_demo_buf was never called (demoplayback alone cannot say -- it is
// cleared at end of demo, which is normal after a seek).
EMSCRIPTEN_KEEPALIVE int web_seek_demo (int targetTic)
{
    int i;

    if (seek_episode == 0 && seek_map == 0)
        return -1;

    demo_p = demobuffer + 13; // the zone copy persists across seeks
    advancedemo = false;
    gameaction = ga_nothing;

    // G_InitNew → P_SetupLevel → Z_FreeTags(PU_LEVEL): the level heap is
    // reclaimed and rebuilt in place, so the HWM is flat after the first seek
    if (seek_episode > 0 && seek_map > 0)
        G_InitNew (seek_skill, seek_episode, seek_map);
    usergame = false;
    demoplayback = true;

    nodrawers = true; // pure sim throughput
    for (i = 0; i < targetTic && demoplayback; i++)
        D_DoomFrame ();
    nodrawers = false;

    return i; /* actual tic reached */
}
