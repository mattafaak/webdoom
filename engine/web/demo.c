// webdoom demo recording and replay, for JS.
//
// Recording: pass '-record webdemo' to callMain (G_RecordDemo needs the zone,
// so it runs inside D_DoomMain), drive frames with web_frame(), then
// web_demo_stop() appends the marker and returns the .lmp length; the bytes
// are at web_demo_buf_ptr().
//
// Replay: web_play_demo_buf(ptr, len) copies the .lmp, then each replay start
// -- the first, and every web_seek_demo -- puts the engine in the state a
// fresh -playdemo would: the header's globals, the -fast tables, gametic, and
// a zone copy of the bytes that G_CheckDemoStatus may release at the marker.
// Replay runs in singletics (one tic per web_frame) from then on.  After the
// marker the engine goes on to the attract loop exactly as vanilla does, and a
// seek starts the replay again from the beginning.
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
#include "info.h"     /* states, mobjinfo: what G_InitNew changes for -fast */
#include "m_fixed.h"
#include <stdlib.h> /* malloc, free */

/* Internal demo buffer pointers defined in g_game.c */
extern byte* demobuffer;
extern byte* demo_p;
extern byte* demoend; /* g_game.c: demobuffer + maxsize */

/* Title-screen demo advance flag defined in d_main.c */
extern boolean advancedemo;

extern boolean netdemo;    /* g_game.c */
extern boolean singletics; /* d_main.c: one tic per web_frame() */
extern int maketic;        /* d_net.c */

// The replay: the .lmp as given (the zone copy is made from it at every
// start, because G_CheckDemoStatus releases that one at the marker), and the
// header fields a start re-applies.
static byte* replay_src;
static int replay_len;
static byte* replay_zone; /* zone copy; the zone clears it if purged */
static int replay_gametic;
static struct
{
    skill_t skill;
    int episode, map;
    boolean deathmatch, respawn, fast, nomonsters;
    int console;
    boolean ingame[MAXPLAYERS];
} hdr;

// G_InitNew halves these when fastparm is set, every time it is called, so a
// second start of a -fast demo would halve them again; each start restores
// the values the first one saw.
#define FAST_FIRST S_SARG_RUN1
#define FAST_COUNT (S_SARG_PAIN2 - S_SARG_RUN1 + 1)
static boolean fast_saved;
static int fast_tics[FAST_COUNT];
static fixed_t fast_speed[3];
static skill_t fast_gameskill;

static void save_fast_tables (void)
{
    int i;
    for (i = 0; i < FAST_COUNT; i++)
        fast_tics[i] = states[FAST_FIRST + i].tics;
    fast_speed[0] = mobjinfo[MT_BRUISERSHOT].speed;
    fast_speed[1] = mobjinfo[MT_HEADSHOT].speed;
    fast_speed[2] = mobjinfo[MT_TROOPSHOT].speed;
    fast_gameskill = gameskill;
    fast_saved = true;
}

static void restore_fast_tables (void)
{
    int i;
    for (i = 0; i < FAST_COUNT; i++)
        states[FAST_FIRST + i].tics = fast_tics[i];
    mobjinfo[MT_BRUISERSHOT].speed = fast_speed[0];
    mobjinfo[MT_HEADSHOT].speed = fast_speed[1];
    mobjinfo[MT_TROOPSHOT].speed = fast_speed[2];
    gameskill = fast_gameskill;
}

// Put the engine at tic 0 of the replay, as G_DoPlayDemo would.
static void begin_replay (void)
{
    int i;

    if (replay_zone)
        Z_Free (replay_zone);
    // owned, so G_CheckDemoStatus may re-tag it PU_CACHE at the marker
    Z_Malloc (replay_len, PU_STATIC, &replay_zone);
    memcpy (replay_zone, replay_src, replay_len);
    demobuffer = replay_zone;
    demo_p = replay_zone + 13;

    restore_fast_tables ();
    deathmatch = hdr.deathmatch;
    respawnparm = hdr.respawn;
    fastparm = hdr.fast;
    nomonsters = hdr.nomonsters;
    consoleplayer = hdr.console;
    for (i = 0; i < MAXPLAYERS; i++)
        playeringame[i] = hdr.ingame[i];
    if (playeringame[1])
    {
        netgame = true; // as G_DoPlayDemo: a two-player demo is a net demo
        netdemo = true;
    }

    // the sim reads gametic (A_Tracer), so every start is at the same one
    gametic = maketic = replay_gametic;
    // or the WAD's own DEMO1 replaces this buffer on the first G_Ticker tick
    advancedemo = false;
    gameaction = ga_nothing;
    singletics = true;

    G_InitNew (hdr.skill, hdr.episode, hdr.map);
    usergame = false; // as G_DoPlayDemo: a replay is not a session
    demoplayback = true;
}

/* DEMOMARKER is #defined inside g_game.c — duplicate the value here. */
#define WEBDEMO_MARKER 0x80

EMSCRIPTEN_KEEPALIVE void web_set_singletics (int on)
{
    singletics = on ? true : false;
}

// Append the marker and stop; returns the .lmp byte count (0 if not
// recording).  Not G_CheckDemoStatus, whose I_Error would abort the runtime.
// A recording that fills its buffer (0x20000 bytes, 15.6 min) keeps the tics
// it has, and this still ends it.
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

// Start replaying a .lmp from wasm heap memory.  0 on success, -1 on a bad
// version or a hostile header, in which case the engine is untouched: the
// header is parsed into locals and validated before anything is committed.
// The bytes are copied, so the caller may free its buffer.
EMSCRIPTEN_KEEPALIVE int web_play_demo_buf (int heapPtr, int len)
{
    byte* raw = (byte*) (size_t) heapPtr;
    byte* p = raw;
    byte* end;
    byte* scan;
    int ver, i, total;
    skill_t skill;
    int episode, map;
    boolean hdr_deathmatch, hdr_respawn, hdr_fast, hdr_nomonsters;
    int hdr_console;
    boolean hdr_ingame[MAXPLAYERS];

    // len bounds the terminator scan
    if (len < 14) /* 13-byte header + at least the marker */
        return -1;
    end = raw + len;

    ver = (int) *p++;
    if (ver != VERSION && ver != 109)
        return -1;

    skill = (skill_t) *p++;
    episode = (int) *p++;
    map = (int) *p++;
    hdr_deathmatch = (boolean) *p++;
    hdr_respawn = (boolean) *p++;
    hdr_fast = (boolean) *p++;
    hdr_nomonsters = (boolean) *p++;
    hdr_console = (int) *p++;
    for (i = 0; i < MAXPLAYERS; i++)
        hdr_ingame[i] = (boolean) *p++;

    // each tic is 4 bytes per player, so the marker sits 4-aligned after the
    // header; the scan is bounded by len
    scan = p;
    while (scan < end && *scan != WEBDEMO_MARKER)
        scan += 4;
    if (scan >= end || *scan != WEBDEMO_MARKER)
        return -1; /* no terminator inside the buffer */
    if (scan == p)
        return -1;                  /* a 0-tic demo has nothing to replay */
    total = (int) (scan + 1 - raw); /* header + tics + marker */

    // A level of 0 leaves the engine in GS_DEMOSCREEN, and a console player
    // not in the game never consumes ticcmds, so the marker is never read.
    if (episode == 0 || map == 0)
        return -1;
    if (skill > sk_nightmare)
        return -1;
    if (hdr_console < 0 || hdr_console >= MAXPLAYERS ||
        !hdr_ingame[hdr_console])
        return -1;

    /* ---- the header is good; only now touch the engine ---- */

    if (!fast_saved)
        save_fast_tables ();
    free (replay_src);
    replay_src = malloc (total);
    memcpy (replay_src, raw, total);
    replay_len = total;
    replay_gametic = gametic;

    hdr.skill = skill;
    hdr.episode = episode;
    hdr.map = map;
    hdr.deathmatch = hdr_deathmatch;
    hdr.respawn = hdr_respawn;
    hdr.fast = hdr_fast;
    hdr.nomonsters = hdr_nomonsters;
    hdr.console = hdr_console;
    for (i = 0; i < MAXPLAYERS; i++)
        hdr.ingame[i] = hdr_ingame[i];

    begin_replay ();
    return 0;
}

// nodrawers: D_Display returns before drawing (and before the wipe check)
EMSCRIPTEN_KEEPALIVE void web_set_nodraw (int on)
{
    nodrawers = on ? true : false;
}

// Seek to targetTic by replaying from tic 0 with drawing off.  Returns the
// tic reached (fewer than targetTic only if the demo ended first), or -1 if
// no replay was ever started.  Works after the marker too: the replay starts
// again from its own copy.
EMSCRIPTEN_KEEPALIVE int web_seek_demo (int targetTic)
{
    int i;
    boolean drew = !nodrawers;

    if (!replay_src)
        return -1;
    begin_replay ();

    nodrawers = true;
    for (i = 0; i < targetTic && demoplayback; i++)
        D_DoomFrame ();
    nodrawers = !drew;
    return i;
}
