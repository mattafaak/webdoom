// tools/baremetal/files.c — in-memory WAD blob registry (bare-metal rung 2).
//
// Identical to freestanding/files.c: bm_main() calls fs_register_wad() with
// the WAD blob baked via objcopy, then all W_WebFile / W_WebFileExists calls
// are served from the preloaded blob.  No disk I/O, no malloc.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include "doomtype.h"
#include "web.h"
#include "fs_platform.h"

static byte* fs_wad_data;
static int   fs_wad_len;
static char  fs_wad_name[64];

static const char* fs_basename(const char* path)
{
    const char* s = strrchr(path, '/');
    return s ? s + 1 : path;
}

void fs_register_wad(const char* name, byte* data, int len)
{
    strncpy(fs_wad_name, fs_basename(name), sizeof(fs_wad_name) - 1);
    fs_wad_name[sizeof(fs_wad_name) - 1] = '\0';
    fs_wad_data = data;
    fs_wad_len  = len;
}

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

int Web_FileLen(const char* path)
{
    (void)path;
    return -1;
}

void Web_FileCopy(const char* path, byte* dest)
{
    (void)path;
    (void)dest;
}

void Web_FileWrite(const char* path, byte* data, int len)
{
    (void)path;
    (void)data;
    (void)len;
}
