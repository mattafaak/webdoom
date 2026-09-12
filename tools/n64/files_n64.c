// tools/n64/files_n64.c — N64 WAD/file registry.
//
// Serves W_WebFile / Web_File* from a registered in-ROM blob.
// The blob is registered by n64_main.c before D_DoomMain via
// n64_register_wad().
//
// Deployment paths:
//   (A) Baked ROM blob — WAD linked as a raw data segment via n64tool.
//       Caller passes the ROM-mapped virtual address and WAD length.
//   (B) libdragon DFS — WAD in DragonFS partition at end of ROM.
//       Future task: call dfs_init(), dfs_open(), then map the WAD.
//   (C) Footprint build — NULL / 0: D_DoomMain prints the banner but
//       W_InitMultipleFiles will call I_Error("W_InitFiles: no files found").
//
// Engine/core: 0-diff.  Only tools/n64/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include <debug.h>    /* debugf */

#include "doomtype.h"
#include "web.h"
#include "n64_platform.h"

/* Registered blob (ROM-mapped or DFS-backed pointer). */
static const byte* n64_wad_data = NULL;
static int         n64_wad_len  = 0;
static char        n64_wad_name[64];  /* basename stored at registration */

static const char* n64_basename(const char* path)
{
    const char* s = strrchr(path, '/');
    return s ? s + 1 : path;
}

// Register WAD blob.  Pass the virtual address of the WAD in ROM (or a
// RDRAM-copied pointer).  Pass NULL/0 for a footprint-only build.
void n64_register_wad(const byte* data, int len)
{
    n64_wad_data = data;
    n64_wad_len  = len;
    /* The name must be one IdentifyVersion() probes (d_main.c:592-630):
       doom2f / doom2 / plutonia / tnt / doomu / doom / doom1, in that order.
       N64_WAD_NAME is set by the Makefile alongside the WAD it embeds, so the
       two cannot drift apart. */
#ifndef N64_WAD_NAME
#define N64_WAD_NAME "doom1.wad"
#endif
    strncpy(n64_wad_name, N64_WAD_NAME, sizeof(n64_wad_name) - 1);
    n64_wad_name[sizeof(n64_wad_name) - 1] = '\0';

    /* Announce the name COMPILED INTO THIS OBJECT, not the one the build was
       asked for.  They came apart once and it was invisible: the 20.4c gate
       force-rebuilt n64_main.o and n64_hash.o between IWADs, but N64_WAD_NAME is
       baked in HERE, and n64_hash.c does not use it at all -- so the doom2 ROM
       registered doom2.wad's bytes under the previous build's "doomu.wad".
       IdentifyVersion() matched doomu, set gamemode retail, and the run died on
       "W_GetNumForName: E1M9 not found!".  A stale object with a plausible
       constant is not a build error; the only way to see it is to have the
       running program say which value it holds.  run-n64-demos.sh asserts this
       line against the IWAD it meant to build. */
    debugf("N64 webdoom: registry name '%s'\n", n64_wad_name);
}

byte* W_WebFile(const char* path, int* len)
{
    if (n64_wad_data &&
        strcasecmp(n64_basename(path), n64_wad_name) == 0) {
        *len = n64_wad_len;
        return (byte*)n64_wad_data;
    }
    return NULL;
}

boolean W_WebFileExists(const char* path)
{
    int dummy;
    return W_WebFile(path, &dummy) != NULL;
}

/* Small-file bridge: no config/savegame I/O in bare-metal. */
int  Web_FileLen(const char* path)                          { (void)path; return -1; }
void Web_FileCopy(const char* path, byte* dest)             { (void)path; (void)dest; }
void Web_FileCopyN(const char* path, byte* dest, int maxlen){ (void)path; (void)dest; (void)maxlen; }
void Web_FileWrite(const char* path, byte* data, int len)   { (void)path; (void)data; (void)len; }

/* newlib syscall stub: M_ScreenShot() (m_misc.c) calls access() to find an
   unused screenshot filename. There is no filesystem here; report every path
   as absent so the screenshot path resolves without a link error. Screenshots
   are not a bring-up concern. */
int access(const char* path, int mode) { (void)path; (void)mode; return -1; }
