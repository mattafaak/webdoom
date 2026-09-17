// webdoom platform layer — shared declarations.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_H__
#define __WEB_H__

#include "doomtype.h"
#include "d_ticcmd.h" // ticcmd_t, for the web_net_bundle contract below

// Zone pool size.  Single authoritative define — both i_system.c
// (I_ZoneBase) and perf.c (web_zone_sample / web_zone_size) consume this.
// Value chosen after measurement (see perf.md §2 and task 2.5):
// - Non-purgeable HWM across 13 IWAD demos: 1.36 MB (plutonia demo3)
// - 4 MB test: confirmed zero I_Error failures across all 13 demos + 2p/4p net
// - 8 MB: 2× safety margin over 4 MB worst-case, 5.9× over HWM
// Do not change without re-running demo-test.mjs (13/13) + net-test.mjs.
#ifndef ZONESIZE
#define ZONESIZE (4 * 1024 * 1024)
#endif

// d_main.c (webdoom patches)
void D_DoomFrame (void);

// Multiplayer bridge (d_net.c in this directory). All state flows through
// these before main() runs; single player needs none of them.
// tools/web-contract-check.mjs asserts every declaration here against its
// definition.
void web_net_setup (int player, int numplayers, int ingamemask);

// ─────────────────────────────────────────────────────────────────────────────
// THE MEMORY-SAFETY SURFACE: every export that takes a pointer, or an integer
// the caller must treat as one, with the bound the callee cannot check for
// itself.  THE CALLER OWNS THE BOUND -- an export that cannot derive a length
// from its own arguments will not check one.  (spec.md tenet 5: a port starts
// from this documentation, not from folklore.)
// ─────────────────────────────────────────────────────────────────────────────

// cmds must point to at least `numplayers` ticcmd_t, ingame to at least
// `numplayers` bytes.  tic is validated internally (0 <= tic < INT_MAX) because
// it arrives from the network; the two POINTERS are the caller's
// responsibility.
void web_net_bundle (int tic, ticcmd_t* cmds, byte* ingame, int fabmask);

// out must point to at least 5 ints; it takes no size and cannot check.
void web_demo_state (int* out);

// out must hold nframes * 2 floats (interleaved stereo).  nframes is NOT
// clamped: the JS caller's buffer is the only bound, and the two live in
// different files (audio.js allocates 16384 frames).
void web_music_render (float* out, int nframes);

// data must remain valid for the lifetime of the registration — the registry
// stores the pointer, it does not copy.  It holds MAXWEBFILES (40) entries;
// past that this RETURNS 0 and registers nothing.
int web_register_file (const char* name, byte* data, int len);

// heapPtr is a wasm heap offset; len is its size and is MANDATORY -- a call
// without it is rejected rather than overscanned.
int web_play_demo_buf (int heapPtr, int len);

// targetTic is not clamped: the callee replays that many tics.  A large value
// is a long synchronous stall, not a crash.
int web_seek_demo (int targetTic);

// player is bounds-checked against MAXPLAYERS internally; a port must not
// assume otherwise.
void web_set_console (int player);

// name is a NUL-terminated C string; the callee copies at most MAXPLAYERNAME
// bytes and bounds-checks `player` itself.
void web_set_player_name (int player, const char* name);

// In-heap file registry + JS small-file bridge (files.c).  W_WebFile returns
// NULL for "no such file" and for "registry full"; the second is announced.
byte* W_WebFile (const char* path, int* len);
boolean W_WebFileExists (const char* path);
int Web_FileLen (const char* path);
void Web_FileCopy (const char* path, byte* dest);
void Web_FileCopyN (const char* path, byte* dest, int maxlen);
void Web_FileWrite (const char* path, byte* data, int len);

// MUS + OPL music sequencer (mus_opl.c)
void mus_init (int samplerate);
void mus_play (void* data, int len, int loop);
void mus_stop (void);
void mus_pause (int pause);
void mus_setvolume (int vol127);
int web_music_debug (
    int what); /* 0 playing, 1 events, 2 noteons, 3 bank, 4 voices */
void web_set_opl_mode (int mode); /* 0 OPL2, 1 OPL3; call before mus_init */
/* web_music_render is declared once, above, with its bound contract.  A second
   declaration lived here and web-contract-check could not see it: that tool
   builds its declaration set as a Map, so a duplicate key collapses silently.
 */

// --- build/synth.wasm contract (engine/web/synth_main.c) ------------------
//
// The same mus_opl.c linked as a standalone reactor for the AudioWorklet.
// Every pointer below is allocated by the CALLER through the module's own
// `malloc` and becomes the module's: it frees the previous song when a new one
// is accepted, and frees the new one when mus_play declines it.  `gm` must
// outlive the module (load_bank keeps no copy of the lump it reads).
// `out` in web_music_render must have room for nframes * 2 floats.
void web_music_state (int* out); /* 7 ints: see engine/web/i_sound.c */

void synth_boot (int rate, byte* gm, int gmlen, byte* song, int songlen,
                 int looping, int paused, int vol127, int oplmode);
void synth_play (byte* data, int len, int looping);
void synth_stop (void);
void synth_pause (int on);
void synth_volume (int vol127);

#endif
