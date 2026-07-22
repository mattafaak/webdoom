// native-sanitize web.h — native mirror of engine/web/web.h.
// Provides the same public surface (D_DoomFrame, W_WebFile, Web_File*,
// mus_*) without any emscripten dependency, so engine/core files that
// #include "web.h" compile cleanly in the native ASan/UBSan build.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_H__
#define __WEB_H__

#include "doomtype.h"

// Zone pool size — matches engine/web/web.h.
#define ZONESIZE (32 * 1024 * 1024)

// d_main.c (webdoom split-loop patch).
void D_DoomFrame (void);

// In-heap file registry (files.c, native: stdio-based).
byte*   W_WebFile       (const char* path, int* len);
boolean W_WebFileExists (const char* path);
int     Web_FileLen     (const char* path);
void    Web_FileCopy    (const char* path, byte* dest);
void    Web_FileCopyN   (const char* path, byte* dest, int maxlen);
void    Web_FileWrite   (const char* path, byte* data, int len);

// MUS+OPL music sequencer stubs (i_sound.c, native: all no-ops).
void mus_init      (int samplerate);
void mus_play      (void* data, int len, int loop);
void mus_stop      (void);
void mus_pause     (int pause);
void mus_setvolume (int vol127);

// web_net_setup is referenced by web d_net.c only; the native d_net.c
// provides its own D_CheckNetGame instead.  Stub it here so any translation
// unit that prototypes it compiles.
void web_net_setup (int consoleplayer, int numplayers);

#endif
