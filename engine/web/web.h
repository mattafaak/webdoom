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

// Multiplayer bridge (see d_net.c in this directory). All state flows
// through these before main() runs; single player needs none of them.
//
// ARITY WAS WRONG HERE until task 25.2: this declared two parameters against a
// three-parameter definition, so any translation unit that included web.h and
// called it passed garbage for ingamemask.  Nothing did, which is why it
// survived — an unused declaration is not checked by anything.  It is now, by
// tools/web-contract-check.mjs.
void web_net_setup (int player, int numplayers, int ingamemask);

// ─────────────────────────────────────────────────────────────────────────────
// THE MEMORY-SAFETY SURFACE
//
// spec.md tenet 5 says a bare-metal port "starts from this repo's
// documentation, not from folklore", and this header is that documentation.  It
// described 5 of 73 exports, and none of the ones a port can get fatally wrong.
//
// Listed here is every export that takes a pointer, or an integer the caller
// must treat as one, together with the bound the callee CANNOT check for
// itself.  Each of these has already been the site of a real defect (task 23):
// web_net_bundle indexed its arrays with an unvalidated wire u32, and
// web_play_demo_buf scanned for its terminator up to the SERVER's 1 MiB cap
// rather than the size of the buffer in front of it.
//
// The rule the whole section exists to state: THE CALLER OWNS THE BOUND.  An
// export that cannot derive a length from its own arguments will not check one.
// ─────────────────────────────────────────────────────────────────────────────

// cmds must point to at least `numplayers` ticcmd_t, ingame to at least
// `numplayers` bytes.  tic is validated internally (0 <= tic < INT_MAX) because
// it arrives from the network; the two POINTERS are the caller's
// responsibility.
void web_net_bundle (int tic, ticcmd_t* cmds, byte* ingame, int fabmask);

// out must point to at least 5 ints.  It does not take a size, so it cannot
// check.  (web_level_state sat beside this and filled 9; it fed the QoL DOM
// overlays, which are gone, and it was that header's only consumer.)
void web_demo_state (int* out);

// out must hold nframes * 2 floats (interleaved stereo).  nframes is NOT
// clamped: the JS caller's buffer is the only bound, and the two live in
// different files (audio.js allocates 16384 frames).
void web_music_render (float* out, int nframes);

// data must remain valid for the lifetime of the registration — the registry
// stores the pointer, it does not copy.  The registry holds MAXWEBFILES (40)
// entries; past that this RETURNS 0 and registers nothing, and the caller owns
// what it passed.  It used to return void and no-op silently, which is how
// W_WebFile came to re-malloc the same file on every lookup.
int web_register_file (const char* name, byte* data, int len);

// heapPtr is a wasm heap offset; len is its size and is MANDATORY.  A call
// without it is rejected rather than overscanned (task 23.4).
int web_play_demo_buf (int heapPtr, int len);

// targetTic is not clamped: the callee replays that many tics.  A large value
// is a long synchronous stall, not a crash.
int web_seek_demo (int targetTic);

// player is bounds-checked against MAXPLAYERS internally (23.1); listed because
// a port re-implementing the JS side must not assume otherwise.
void web_set_console (int player);

// name is a NUL-terminated C string; the callee copies at most MAXPLAYERNAME
// bytes and bounds-checks `player` itself.  Listed because it takes a pointer,
// and the rule of this section is that every such export is listed.
void web_set_player_name (int player, const char* name);

// In-heap file registry + JS small-file bridge (files.c)
// W_WebFile returns NULL both for "no such file" and for "the registry is full"
// — the second is announced on stdout, because a bounded registry that refuses
// silently is indistinguishable from a missing file.
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

#endif
