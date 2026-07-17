// tools/baremetal/web.h — bare-metal mirror of engine/web/web.h.
// Same public surface as freestanding/web.h but ZONESIZE reduced to 6 MiB
// so the 12.4 MiB baked WAD + 6 MiB arena + stack fit in 32 MiB QEMU RAM.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_H__
#define __WEB_H__

#include "doomtype.h"

// Zone pool size.  bare-metal.md §2.2 minimum is 4 MiB; 6 MiB gives headroom.
#define ZONESIZE (6 * 1024 * 1024)

// d_main.c (webdoom split-loop patch).
void D_DoomFrame(void);

// In-memory file registry (files.c — served from baked WAD blob).
byte*   W_WebFile(const char* path, int* len);
boolean W_WebFileExists(const char* path);
int     Web_FileLen(const char* path);
void    Web_FileCopy(const char* path, byte* dest);
void    Web_FileWrite(const char* path, byte* data, int len);

// MUS+OPL music sequencer stubs (i_sound.c — all no-ops).
void mus_init(int samplerate);
void mus_play(void* data, int len, int loop);
void mus_stop(void);
void mus_pause(int pause);
void mus_setvolume(int vol127);

// web_net_setup stub.
void web_net_setup(int consoleplayer, int numplayers);

#endif
