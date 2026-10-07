// tools/freestanding/files.c — in-memory WAD blob registry.
//
// The CONTRACT: no open/read/fopen below this file (the shim line).
// main() (i_main.c) loads the WAD once via open/read, calls
// fs_register_wad(), and then ALL W_WebFile / W_WebFileExists calls are
// served from the preloaded blob.  This is the "WAD blob" surface from
// bare-metal.md §2.3(a).
//
// Small-file bridge (config, saves): nothing is read or written, but a
// savegame written is kept in memory and served back to a read of its name,
// for i_main.c's -frames save and load (a demo run writes none and reads none).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdlib.h>
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

// ── Small-file bridge (config, saves) ───────────────────────────────────────
// m_misc.c calls these for .doomrc and savegame files.  Timedemos need
// neither.  A savegame (a name ending .dsg) that Web_FileWrite is given is
// kept, a copy in the host's heap like the WAD blob, and a read of that name
// is served from it: -frames mode saves and loads as a player would
// (i_main.c's WD_SAVE_AT, WD_LOAD_AT).  The harness can hand one in before
// D_DoomMain and take one out at the end (fs_keep_file, fs_kept_file: another
// build's save, loaded here).  Anything else reads as absent.
#define FS_KEPT_MAX 4
static struct
{
    char  name[32];
    byte* data;
    int   len;
} fs_kept[FS_KEPT_MAX];

static int fs_kept_find(const char* path)
{
    int i;
    for (i = 0; i < FS_KEPT_MAX; i++)
        if (fs_kept[i].data && !strcasecmp(fs_kept[i].name, fs_basename(path)))
            return i;
    return -1;
}

int fs_keep_file(const char* name, const byte* data, int len)
{
    int i = fs_kept_find(name);
    if (i < 0)
        for (i = 0; i < FS_KEPT_MAX && fs_kept[i].data; i++)
            ;
    if (i >= FS_KEPT_MAX || len < 0 || strlen(fs_basename(name)) >= sizeof(fs_kept[i].name))
        return 0;
    free(fs_kept[i].data);
    fs_kept[i].data = malloc(len ? (size_t) len : 1);
    if (!fs_kept[i].data)
        return 0;
    memcpy(fs_kept[i].data, data, (size_t) len);
    fs_kept[i].len = len;
    strcpy(fs_kept[i].name, fs_basename(name));
    return 1;
}

const byte* fs_kept_file(const char* name, int* len)
{
    int i = fs_kept_find(name);
    if (i < 0)
        return NULL;
    *len = fs_kept[i].len;
    return fs_kept[i].data;
}

int Web_FileLen(const char* path)
{
    int i = fs_kept_find(path);
    return i < 0 ? -1 : fs_kept[i].len; // -1: file not found
}

void Web_FileCopy(const char* path, byte* dest)
{
    int i = fs_kept_find(path);
    if (i >= 0)
        memcpy(dest, fs_kept[i].data, (size_t) fs_kept[i].len);
}

void Web_FileCopyN(const char* path, byte* dest, int maxlen)
{
    int i = fs_kept_find(path);
    if (i >= 0 && maxlen > 0)
        memcpy(dest, fs_kept[i].data, (size_t) (fs_kept[i].len < maxlen ? fs_kept[i].len : maxlen));
}

// Nothing is written (no file system below the shim line; a savegame is kept,
// above), but what would have been is counted and hashed (FNV-1a over the name and the bytes):
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
    if (n > 4 && strcasecmp(path + n - 4, ".dsg") == 0)
        fs_keep_file(path, data, len);
}
