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

void Web_FileWrite(const char* path, byte* data, int len)
{
    (void)path;
    (void)data;
    (void)len;
}
