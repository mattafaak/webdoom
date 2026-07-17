// tools/freestanding/web.h — freestanding mirror of engine/web/web.h.
// Provides the same public surface (D_DoomFrame, W_WebFile, Web_File*,
// mus_*) without any emscripten dependency, so engine/core files that
// #include "web.h" compile cleanly in the freestanding build.
// Identical surface to native-sanitize/web.h (FINDING-6: five-header surface).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_H__
#define __WEB_H__

#include "doomtype.h"

// Zone pool size (provided by the static arena — see i_system.c).
#define ZONESIZE (8 * 1024 * 1024)

// d_main.c (webdoom split-loop patch).
void D_DoomFrame(void);

// In-memory file registry (files.c — served from preloaded WAD blob).
byte*   W_WebFile(const char* path, int* len);
boolean W_WebFileExists(const char* path);
int     Web_FileLen(const char* path);
void    Web_FileCopy(const char* path, byte* dest);
void    Web_FileWrite(const char* path, byte* data, int len);

// MUS+OPL music sequencer stubs (i_sound.c — all no-ops in headless build).
void mus_init(int samplerate);
void mus_play(void* data, int len, int loop);
void mus_stop(void);
void mus_pause(int pause);
void mus_setvolume(int vol127);

// web_net_setup stub (declared in web.h for rare core includes).
void web_net_setup(int consoleplayer, int numplayers);

#endif
