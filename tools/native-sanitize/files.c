// native-sanitize files.c — stdio-based file loading to replace web/files.c.
// W_WebFile loads WAD / LMP files from the nat_wad_dir directory (set by
// i_main.c before D_DoomMain runs, defaulting to ../../wads/lib relative to
// the binary).  Web_FileLen / Web_FileCopy / Web_FileWrite emulate the
// small-file bridge using plain stdio temp files so m_misc.c's config and
// savegame code compiles and links without emscripten.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "doomtype.h"
#include "web.h"
#include "nat_platform.h"

// Set by i_main.c before D_DoomMain.
const char* nat_wad_dir = "../../wads/lib";

#define MAXWEBFILES 64

typedef struct
{
    char  name[64];
    byte* data;
    int   len;
} natfile_t;

static natfile_t natfiles[MAXWEBFILES];
static int       numnatfiles;

static const char* nat_basename (const char* path)
{
    const char* s = strrchr (path, '/');
    return s ? s + 1 : path;
}

// Register a pre-loaded buffer under a basename (used internally).
static void nat_register_file (const char* name, byte* data, int len)
{
    if (numnatfiles >= MAXWEBFILES)
        return;
    snprintf (natfiles[numnatfiles].name,
              sizeof natfiles[0].name, "%s", nat_basename (name));
    natfiles[numnatfiles].data = data;
    natfiles[numnatfiles].len  = len;
    numnatfiles++;
}

// Try loading <nat_wad_dir>/<basename> from disk.
static byte* nat_load_from_disk (const char* name, int* lenout)
{
    char   path[512];
    FILE*  f;
    long   sz;
    byte*  buf;

    snprintf (path, sizeof path, "%s/%s", nat_wad_dir, nat_basename (name));
    f = fopen (path, "rb");
    if (!f)
        return NULL;

    fseek (f, 0, SEEK_END);
    sz = ftell (f);
    fseek (f, 0, SEEK_SET);

    buf = (byte*) malloc ((size_t) sz);
    if (!buf) { fclose (f); return NULL; }
    if ((long) fread (buf, 1, (size_t) sz, f) != sz)
    { fclose (f); free (buf); return NULL; }

    fclose (f);
    *lenout = (int) sz;
    return buf;
}

// W_WebFile — called by w_wad.c.
byte* W_WebFile (const char* path, int* len)
{
    const char* name = nat_basename (path);
    int i;
    byte* buf;

    // Check registry first (avoids re-reading disk on second call).
    for (i = 0; i < numnatfiles; i++)
        if (!strcasecmp (natfiles[i].name, name))
        { *len = natfiles[i].len; return natfiles[i].data; }

    // Try disk.
    buf = nat_load_from_disk (name, len);
    if (!buf)
        return NULL;

    nat_register_file (name, buf, *len);
    return buf;
}

boolean W_WebFileExists (const char* path)
{
    int len;
    return W_WebFile (path, &len) != NULL;
}

// ── small-file bridge (config, saves) ────────────────────────────────────────
//
// m_misc.c calls these for .doomrc and savegame files.  In the native
// sanitizer build we redirect them to the system temp dir so saves do not
// collide with user data and the config is ignored (not needed for timedemos).

#define NAT_SMALLFILE_DIR "/tmp"

static void small_path (char* out, size_t sz, const char* path)
{
    snprintf (out, sz, "%s/%s", NAT_SMALLFILE_DIR, nat_basename (path));
}

int Web_FileLen (const char* path)
{
    char   p[512];
    FILE*  f;
    long   sz;

    small_path (p, sizeof p, path);
    f = fopen (p, "rb");
    if (!f) return -1;
    fseek (f, 0, SEEK_END);
    sz = ftell (f);
    fclose (f);
    return (int) sz;
}

void Web_FileCopy (const char* path, byte* dest)
{
    char   p[512];
    FILE*  f;
    int    sz = Web_FileLen (path);

    if (sz < 0) return;
    small_path (p, sizeof p, path);
    f = fopen (p, "rb");
    if (!f) return;
    (void) fread (dest, 1, (size_t) sz, f);
    fclose (f);
}

void Web_FileCopyN (const char* path, byte* dest, int maxlen)
{
    char  p[512];
    FILE* f;
    int   sz = Web_FileLen (path);

    if (sz < 0) return;
    if (sz > maxlen) sz = maxlen;
    small_path (p, sizeof p, path);
    f = fopen (p, "rb");
    if (!f) return;
    (void) fread (dest, 1, (size_t) sz, f);
    fclose (f);
}

void Web_FileWrite (const char* path, byte* data, int len)
{
    char  p[512];
    FILE* f;

    small_path (p, sizeof p, path);
    f = fopen (p, "wb");
    if (!f) return;
    (void) fwrite (data, 1, (size_t) len, f);
    fclose (f);
}
