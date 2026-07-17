// tools/freestanding/i_main.c — freestanding rung-1 host shim + demo harness.
//
// THE SHIM LINE: the only I/O crossing from host into the freestanding layer:
//   open/read/close  WAD blob loading in main() (below the shim line)
//   write(1,...)     per-tic hash stream via fs_putc (the byte-out)
//   malloc/free      WAD buffer allocation in main() (shim-only)
//   fopen/fprintf    -sim file output in main() (shim-only, optional)
//
// Inside D_DoomMain and the demo loop, NO open/read/fopen occur.
// The platform layer (files.c) serves WAD data from the preloaded blob.
//
// Usage:
//   ./fs-doom <wad_path> -timedemo <demo> [-sim <out.json>]
//
// Per-tic sim hash stream: same JSON format as nat-doom -sim output so that
// tools/native-sanitize/compare.py can diff them directly.
//
// Demo choice: doom.wad -timedemo demo3 (standard golden in tools/golden/).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <fcntl.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "m_argv.h"
#include "fs_platform.h"
#include "web.h"

extern int prndindex;

// ── Sim hash: identical algorithm to web_state_hash() and nat_state_hash() ───
// Every field in exactly the same order — required for bit-identical comparison.
static int fs_state_hash(void)
{
    unsigned h = 0x9e3779b9u ^ (unsigned)gametic;
    int      i;

    h = (h ^ (unsigned)prndindex) * 0x01000193u;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && players[i].mo) {
            h = (h ^ (unsigned)players[i].mo->x)     * 0x01000193u;
            h = (h ^ (unsigned)players[i].mo->y)     * 0x01000193u;
            h = (h ^ (unsigned)players[i].mo->angle) * 0x01000193u;
            h = (h ^ (unsigned)players[i].health)    * 0x01000193u;
        }
    return (int)h;
}

// ── Byte-out helpers (no libc I/O — fs_putc only) ────────────────────────────
static void fs_putu(unsigned u)
{
    char buf[12];
    int  n = 0;
    if (u == 0) { fs_putc('0'); return; }
    while (u) { buf[n++] = (char)('0' + u % 10); u /= 10; }
    while (n--) fs_putc(buf[n]);
}

static void fs_puts(const char* s)
{
    while (*s) fs_putc((unsigned char)*s++);
}

// Write {"tics":N,"trace":[...]} via fs_putc.
// Identical JSON shape to nat-doom -sim so compare.py works without conversion.
static void stream_sim_json(int tics, const int* trace, int n)
{
    int i;
    fs_puts("{\"tics\":");
    fs_putu((unsigned)tics);
    fs_puts(",\"trace\":[");
    for (i = 0; i < n; i++) {
        fs_putu((unsigned)trace[i]);
        if (i + 1 < n) fs_putc(',');
    }
    fs_puts("]}");
    fs_putc('\n');
}

// ── WAD blob loading (SHIM — the only file I/O in this translation unit) ──────
static const char* path_basename(const char* path)
{
    const char* s = strrchr(path, '/');
    return s ? s + 1 : path;
}

static byte* load_wad(const char* path, int* lenout)
{
    int    fd;
    long   sz;
    byte*  buf;

    fd = open(path, O_RDONLY);
    if (fd < 0) return NULL;

    sz = (long)lseek(fd, 0, SEEK_END);
    if (sz <= 0 || sz > 64 * 1024 * 1024L) { close(fd); return NULL; }
    lseek(fd, 0, SEEK_SET);

    buf = (byte*)malloc((size_t)sz);
    if (!buf) { close(fd); return NULL; }

    if ((long)read(fd, buf, (size_t)sz) != sz) {
        free(buf);
        close(fd);
        return NULL;
    }
    close(fd);
    *lenout = (int)sz;
    return buf;
}

// ── Trace buffer ──────────────────────────────────────────────────────────────
#define MAX_TRACE 300000
static int sim_trace[MAX_TRACE];
static int trace_len;

// ── main ─────────────────────────────────────────────────────────────────────
int main(int argc, char** argv)
{
    const char* wad_path = NULL;
    const char* sim_out  = NULL;
    static const char* fwd[64];
    int   fwd_argc = 0;
    int   i;
    int   last_tic;
    int   wad_len;
    byte* wad_data;

    // Peel off the WAD positional arg and -sim flag; forward the rest.
    for (i = 0; i < argc && fwd_argc < 63; i++) {
        if (i == 0) { fwd[fwd_argc++] = argv[i]; continue; }
        if (strcmp(argv[i], "-sim") == 0 && i + 1 < argc) {
            sim_out = argv[++i]; continue;
        }
        // First bare positional (non-flag) argument is the WAD path.
        if (argv[i][0] != '-' && wad_path == NULL) {
            wad_path = argv[i]; continue;
        }
        fwd[fwd_argc++] = argv[i];
    }

    if (!wad_path) {
        fs_puts("fs-doom: usage: fs-doom <wad> -timedemo <demo> [-sim <out.json>]\n");
        return 1;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SHIM LINE — WAD blob loading: the only open/read/malloc below D_DoomMain.
    // ══════════════════════════════════════════════════════════════════════════
    wad_data = load_wad(wad_path, &wad_len);
    if (!wad_data) {
        fs_puts("fs-doom: cannot load WAD: ");
        fs_puts(wad_path);
        fs_putc('\n');
        return 1;
    }
    // Hand the blob to files.c — no more file I/O below this point.
    fs_register_wad(path_basename(wad_path), wad_data, wad_len);
    // ══════════════════════════════════════════════════════════════════════════

    myargc = fwd_argc;
    myargv = (char**)fwd;

    fs_timedemo_active   = 1;
    fs_timedemo_gametics = 0;
    trace_len            = 0;

    if (setjmp(fs_demo_jmp) != 0)
        goto done;

    D_DoomMain(); // init + loads WAD via fs_register_wad/W_WebFile; no disk I/O

    // Disable smooth render interpolation (non-deterministic wall-clock drift).
    smoothrender = false;
    last_tic     = -1;

    for (;;) {
        wipeactive = 0; // suppress non-deterministic melt wipes
        D_DoomFrame();

        if (gametic != last_tic) {
            if (trace_len < MAX_TRACE)
                sim_trace[trace_len++] = fs_state_hash();
            last_tic = gametic;
        }
    }

done:
    fs_timedemo_active = 0;
    {
        int tics = fs_timedemo_gametics;

        // (b) BYTE-OUT: stream JSON via fs_putc (write(1,...)).
        // Redirect stdout to a .json file for compare.py compatibility.
        stream_sim_json(tics, sim_trace, trace_len);

        // Also write to -sim file if requested (shim convenience for compare.py).
        if (sim_out) {
            FILE* f = fopen(sim_out, "w");
            if (f) {
                fprintf(f, "{\"tics\":%d,\"trace\":[", tics);
                for (i = 0; i < trace_len; i++) {
                    fprintf(f, "%u", (unsigned)sim_trace[i]);
                    if (i + 1 < trace_len) fputc(',', f);
                }
                fputs("]}", f);
                fclose(f);
            }
        }

        fprintf(stderr, "fs-doom: %d gametics, %d trace entries\n",
                tics, trace_len);
        return 0;
    }
}
