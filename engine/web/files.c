// webdoom file layer: no Emscripten filesystem at all. WADs live once
// in the heap (JS mallocs + registers them before main); small files
// (config, savegames, dropped-in demo .lmps) live in a JS Map bridged
// through three tiny imports, so persistence talks IndexedDB directly.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#include <emscripten.h>

#include "doomtype.h"
#include "web.h"

#define MAXWEBFILES 40

typedef struct
{
    char  name[32];
    byte* data;
    int   len;
} webfile_t;

static webfile_t webfiles[MAXWEBFILES];
static int numwebfiles;

// --- JS bridge: the small-file Map -------------------------------------

EM_JS (int, js_file_len, (const char* name), {
    var m = Module["fileMap"];
    if (!m) return -1;
    var b = m.get(UTF8ToString(name));
    return b ? b.length : -1;
});
EM_JS (void, js_file_copy, (const char* name, unsigned char* dest), {
    var b = Module["fileMap"].get(UTF8ToString(name));
    if (b) HEAPU8.set(b, dest);
});
EM_JS (void, js_file_write, (const char* name, unsigned char* data, int len), {
    if (!Module["fileMap"]) Module["fileMap"] = new Map();
    var n = UTF8ToString(name);
    Module["fileMap"].set(n, HEAPU8.slice(data, data + len));
    if (Module["onFileWrite"]) Module["onFileWrite"](n);
});

// --- registry ------------------------------------------------------------

static const char* web_basename (const char* path)
{
    const char* s = strrchr (path, '/');
    return s ? s + 1 : path;
}

EMSCRIPTEN_KEEPALIVE
void web_register_file (const char* name, byte* data, int len)
{
    if (numwebfiles >= MAXWEBFILES)
        return;
    snprintf (webfiles[numwebfiles].name, sizeof webfiles[0].name,
              "%s", web_basename (name));
    webfiles[numwebfiles].data = data;
    webfiles[numwebfiles].len = len;
    numwebfiles++;
}

// Look a file up; on miss, pull it from the JS Map into the heap and
// register it (lets demo .lmps and the like arrive lazily).
byte* W_WebFile (const char* path, int* len)
{
    const char* name = web_basename (path);
    int i, n;
    byte* buf;

    for (i = 0; i < numwebfiles; i++)
        if (!strcasecmp (webfiles[i].name, name))
        {
            *len = webfiles[i].len;
            return webfiles[i].data;
        }

    n = js_file_len (name);
    if (n < 0)
        return NULL;
    buf = (byte*) malloc (n);
    js_file_copy (name, buf);
    web_register_file (name, buf, n);
    *len = n;
    return buf;
}

boolean W_WebFileExists (const char* path)
{
    int len;
    return W_WebFile (path, &len) != NULL;
}

// --- small-file I/O for m_misc (config, savegames) -----------------------

int Web_FileLen (const char* path)
{
    return js_file_len (web_basename (path));
}

void Web_FileCopy (const char* path, byte* dest)
{
    js_file_copy (web_basename (path), dest);
}

void Web_FileWrite (const char* path, byte* data, int len)
{
    js_file_write (web_basename (path), data, len);
}
