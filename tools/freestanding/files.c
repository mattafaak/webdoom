// tools/freestanding/files.c — in-memory WAD blob registry.
//
// The CONTRACT: no open/read/fopen below this file (the shim line).
// main() (i_main.c) loads the WAD once via open/read, calls
// fs_register_wad(), and then ALL W_WebFile / W_WebFileExists calls are
// served from the preloaded blob.  This is the "WAD blob" surface from
// bare-metal.md §2.3(a).
//
// Small-file bridge (config, saves): stubs returning empty/no-op because
// timedemo runs do not need config reads or saves to complete correctly.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include "doomtype.h"
#include "web.h"
#include "w_wad.h" /* W_WebFileInPlace (WEB_LUMPS_IN_PLACE) */
#include "fs_platform.h"

// ── Single preloaded WAD blob ─────────────────────────────────────────────────
// Set by fs_register_wad() before D_DoomMain is called.
static byte* fs_wad_data;
static int   fs_wad_len;
static char  fs_wad_name[64];

static const char* fs_basename(const char* path)
{
    const char* s = strrchr(path, '/');
    return s ? s + 1 : path;
}

// Called by i_main.c (the host shim) to hand the blob to this layer.
void fs_register_wad(const char* name, byte* data, int len)
{
    strncpy(fs_wad_name, fs_basename(name), sizeof(fs_wad_name) - 1);
    fs_wad_name[sizeof(fs_wad_name) - 1] = '\0';
    fs_wad_data = data;
    fs_wad_len  = len;
}

// ── W_WebFile / W_WebFileExists ───────────────────────────────────────────────
// Called by w_wad.c to load WAD lumps.  Serves from the registered blob only;
// no disk I/O, no malloc.

byte* W_WebFile(const char* path, int* len)
{
    if (fs_wad_data && !strcasecmp(fs_basename(path), fs_wad_name)) {
        *len = fs_wad_len;
        return fs_wad_data;
    }
    return NULL;
}

boolean W_WebFileExists(const char* path)
{
    int dummy;
    return W_WebFile(path, &dummy) != NULL;
}

#ifdef WEB_LUMPS_IN_PLACE
// The zero-copy build (fs-doom-zc): the blob is loaded once, before
// D_DoomMain, and never moves or goes away, so lumps are read in place
// (engine/core/w_wad.h).  Under WD_RO_WAD=1 it is also mprotect'd read-only,
// which is what proves the engine never writes one.
int W_WebFileInPlace(char* filename, unsigned char* data, int length)
{
    (void)filename;
    return data && data == fs_wad_data && length == fs_wad_len;
}
#endif

// ── Small-file bridge (config, saves) — no-ops ───────────────────────────────
// m_misc.c calls these for .doomrc and savegame files.  Timedemos do not need
// config reads or saves to produce correct per-tic hashes.

int Web_FileLen(const char* path)
{
    (void)path;
    return -1; // file not found
}

void Web_FileCopy(const char* path, byte* dest)
{
    (void)path;
    (void)dest;
}

void Web_FileCopyN(const char* path, byte* dest, int maxlen)
{
    (void)path;
    (void)dest;
    (void)maxlen;
}

// Nothing is written (no file system below the shim line), but what would
// have been is counted and hashed (FNV-1a over the name and the bytes):
// i_main.c's -frames record carries both, so a screenshot or a savegame is
// compared between two builds like a frame is.  A PCX's byte 64, its
// header's `reserved`, is left out: m_misc.c's WritePCXfile never sets it,
// so it is whatever its zone block held before (measured: 0xA5, the -frames
// poison, in one build and 0x08 in another, the other 66,357 bytes equal).
int      fs_write_count;
unsigned fs_write_hash = 0x811c9dc5u;
void Web_FileWrite(const char* path, byte* data, int len)
{
    int i, n = (int) strlen(path);
    int pcx = n > 4 && strcasecmp(path + n - 4, ".pcx") == 0;
    for (i = 0; path[i]; i++)
        fs_write_hash = (fs_write_hash ^ (byte) path[i]) * 0x01000193u;
    for (i = 0; i < len; i++)
        if (!(pcx && i == 64))
            fs_write_hash = (fs_write_hash ^ data[i]) * 0x01000193u;
    fs_write_count++;
}
