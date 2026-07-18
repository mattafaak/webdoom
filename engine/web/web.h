// webdoom platform layer — shared declarations.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_H__
#define __WEB_H__

#include "doomtype.h"

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
void web_net_setup (int consoleplayer, int numplayers);

// In-heap file registry + JS small-file bridge (files.c)
byte* W_WebFile (const char* path, int* len);
boolean W_WebFileExists (const char* path);
int Web_FileLen (const char* path);
void Web_FileCopy (const char* path, byte* dest);
void Web_FileWrite (const char* path, byte* data, int len);

// MUS + OPL music sequencer (mus_opl.c)
void mus_init (int samplerate);
void mus_play (void* data, int len, int loop);
void mus_stop (void);
void mus_pause (int pause);
void mus_setvolume (int vol127);

#endif
