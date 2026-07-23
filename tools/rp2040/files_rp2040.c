// tools/rp2040/files_rp2040.c — RP2040 WAD/WHD file registry (XIP flash).
//
// On RP2040, the WAD/WHD blob lives in flash at a fixed XIP address
// (determined by the linker script, typically 0x10010000 for Pico boards
// with the first 64 KB reserved for the UF2 bootloader).
//
// This file mirrors tools/freestanding/files.c but uses XIP flash pointers
// instead of a malloc'd buffer.  The blob is registered by rp2040_main.c
// before D_DoomMain is called.
//
// Engine/core: 0-diff.  Only tools/rp2040/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include "doomtype.h"
#include "web.h"
#include "rp2040_platform.h"

// Registered blob (points into XIP flash — no copy needed).
static const byte* rp2040_whd_data = NULL;
static int         rp2040_whd_len  = 0;
static char        rp2040_whd_name[64];

static const char* rp2040_basename(const char* path)
{
    const char* s = strrchr(path, '/');
    return s ? s + 1 : path;
}

// Called by rp2040_main.c BEFORE D_DoomMain to hand the flash blob to this
// layer.  On a real Pico, pass the XIP-mapped address: e.g.
//   rp2040_register_whd((const byte*)0x10010000, WHD_SIZE_BYTES);
void rp2040_register_whd(const byte* data, int len)
{
    rp2040_whd_data = data;
    rp2040_whd_len  = len;
}

// W_WebFile / W_WebFileExists: serve from the registered flash blob.
byte* W_WebFile(const char* path, int* len)
{
    if (rp2040_whd_data &&
        !strcasecmp(rp2040_basename(path), rp2040_whd_name)) {
        *len = rp2040_whd_len;
        return (byte*)rp2040_whd_data; /* XIP flash — read-only pointer */
    }
    return NULL;
}

boolean W_WebFileExists(const char* path)
{
    int dummy;
    return W_WebFile(path, &dummy) != NULL;
}

// Small-file bridge: no config reads or savegame I/O in timedemo mode.
int Web_FileLen(const char* path)   { (void)path; return -1; }
void Web_FileCopy(const char* path, byte* dest) { (void)path; (void)dest; }
void Web_FileCopyN(const char* path, byte* dest, int maxlen)
    { (void)path; (void)dest; (void)maxlen; }
void Web_FileWrite(const char* path, byte* data, int len)
    { (void)path; (void)data; (void)len; }
