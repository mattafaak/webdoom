// tools/freestanding/i_main.c — freestanding rung-1 host shim + demo harness.
//
// THE SHIM LINE: the only I/O crossing from host into the freestanding layer:
//   open/read/close  WAD blob loading in main() (below the shim line)
//   write(1,...)     per-tic hash stream via fs_putc (the byte-out)
//   malloc/free      WAD buffer allocation in main() (shim-only)
//   fopen/fprintf    -sim/-cycles file output in main() (shim-only, optional)
//
// Inside D_DoomMain and the demo loop, NO open/read/fopen occur.
// The platform layer (files.c) serves WAD data from the preloaded blob.
//
// Usage:
//   ./fs-doom <wad_path> -timedemo <demo> [-sim <out.json>] [-cycles <out.json>]
//
// Instruction counting (13.1a cycle floor):
//   Set WD_CYCLES=1 in the environment and pass -cycles <out.json>.
//   The shim opens perf_event_open(PERF_COUNT_HW_INSTRUCTIONS, exclude_kernel)
//   at boot, reads per-tic deltas at the tic boundary (same point as per-tic
//   hashes), and emits mean/p50/p99/max to the -cycles file at demo end.
//   NOTE: pe.size=0 (not sizeof(pe)) is required for 32-bit compat mode.
//
// Per-tic sim hash stream: same JSON format as nat-doom -sim output so that
// tools/native-sanitize/compare.py can diff them directly.
//
// Demo choice: doom.wad -timedemo demo3 (standard golden in tools/golden/).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <errno.h>
#include <fcntl.h>
#include <linux/perf_event.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
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

// ── Instruction counting (WD_CYCLES=1, shim-only) ────────────────────────────
// Open PERF_COUNT_HW_INSTRUCTIONS for the calling process (pid=0), any CPU,
// no group.  pe.size=0 lets the kernel use its default struct size — required
// for 32-bit compat mode where sizeof(struct perf_event_attr)==144 causes the
// kernel to silently refuse attribution (returns fd but count stays 0).
static int wd_perf_open_instructions(void)
{
    struct perf_event_attr pe;
    memset(&pe, 0, sizeof(pe));
    pe.type           = PERF_TYPE_HARDWARE;
    pe.size           = 0; /* 0 = kernel default; needed for -m32 compat */
    pe.config         = PERF_COUNT_HW_INSTRUCTIONS;
    pe.disabled       = 1;
    pe.exclude_kernel = 1;
    pe.exclude_hv     = 1;
    return (int)syscall(__NR_perf_event_open, &pe,
                        (pid_t)0, -1, -1, (unsigned long)0);
}

static long long wd_perf_read(int fd)
{
    long long v = 0;
    read(fd, &v, sizeof(v)); /* no error check: 0 on fail is a safe fallback */
    return v;
}

// qsort comparator for long long.
static int cmp_llong(const void *a, const void *b)
{
    long long x = *(const long long *)a;
    long long y = *(const long long *)b;
    return (x > y) - (x < y);
}

// Compute percentile of a sorted array (0..100).
static long long percentile(long long *sorted, int n, int pct)
{
    int idx = (int)((long long)n * pct / 100);
    if (idx >= n) idx = n - 1;
    return sorted[idx];
}

// Write per-tic instruction stats to -cycles output file.
// Sorts tic_instr in-place (demo is complete; array no longer consumed).
static void emit_cycles_json(const char *path, int tics,
                              long long *arr, int n)
{
    long long total, maxv, p50, p99;
    double mean;
    FILE *f;
    int i;

    if (n <= 0 || !path) return;

    total = 0; maxv = 0;
    for (i = 0; i < n; i++) {
        total += arr[i];
        if (arr[i] > maxv) maxv = arr[i];
    }
    qsort(arr, (size_t)n, sizeof(long long), cmp_llong);
    p50  = percentile(arr, n, 50);
    p99  = percentile(arr, n, 99);
    mean = (n > 0) ? (double)total / n : 0.0;

    f = fopen(path, "w");
    if (!f) {
        fprintf(stderr, "fs-doom: cannot write cycles output: %s\n", path);
        return;
    }
    fprintf(f,
        "{\"tics\":%d,"
        "\"total_instr\":%lld,"
        "\"instr_per_tic\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,\"max\":%lld}"
        "}\n",
        tics, total, mean, p50, p99, maxv);
    fclose(f);
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

// ── Per-tic instruction counter buffer (WD_CYCLES=1 only) ────────────────────
static long long tic_instr[MAX_TRACE]; /* per-tic instruction deltas */
static int       tic_instr_len = 0;
static int       wd_cycles_fd  = -1;  /* perf fd; -1 = not measuring */
static long long wd_last_count = 0;   /* cumulative count at last tic boundary */

// ── main ─────────────────────────────────────────────────────────────────────
int main(int argc, char** argv)
{
    const char* wad_path   = NULL;
    const char* sim_out    = NULL;
    const char* cycles_out = NULL;
    static const char* fwd[64];
    int   fwd_argc = 0;
    int   i;
    int   last_tic;
    int   wad_len;
    byte* wad_data;

    // Peel off the WAD positional arg, -sim, and -cycles flags; forward the rest.
    for (i = 0; i < argc && fwd_argc < 63; i++) {
        if (i == 0) { fwd[fwd_argc++] = argv[i]; continue; }
        if (strcmp(argv[i], "-sim") == 0 && i + 1 < argc) {
            sim_out = argv[++i]; continue;
        }
        if (strcmp(argv[i], "-cycles") == 0 && i + 1 < argc) {
            cycles_out = argv[++i]; continue;
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
    tic_instr_len        = 0;

    // Open instruction counter before init if WD_CYCLES=1 (shim-only, 13.1a).
    // The counter is not started yet (disabled=1); we enable it after D_DoomMain
    // so that init instructions are excluded from the per-tic floor measurement.
    if (getenv("WD_CYCLES") && getenv("WD_CYCLES")[0] == '1') {
        wd_cycles_fd = wd_perf_open_instructions();
        if (wd_cycles_fd < 0)
            fprintf(stderr, "fs-doom: WD_CYCLES=1 but perf_event_open failed"
                            " (errno %d); check /proc/sys/kernel/perf_event_paranoid"
                            " (<= 2 required for user-space self-measurement)\n",
                    errno);
    }

    if (setjmp(fs_demo_jmp) != 0)
        goto done;

    D_DoomMain(); // init + loads WAD via fs_register_wad/W_WebFile; no disk I/O

    // Disable smooth render interpolation (non-deterministic wall-clock drift).
    smoothrender = false;
    last_tic     = -1;

    // Enable the instruction counter after init, before the demo loop.
    // Read the initial cumulative value so the first per-tic delta is correct.
    if (wd_cycles_fd >= 0) {
        ioctl(wd_cycles_fd, PERF_EVENT_IOC_RESET, 0);
        ioctl(wd_cycles_fd, PERF_EVENT_IOC_ENABLE, 0);
        wd_last_count = wd_perf_read(wd_cycles_fd);
    }

    for (;;) {
        wipeactive = 0; // suppress non-deterministic melt wipes
        D_DoomFrame();

        if (gametic != last_tic) {
            if (trace_len < MAX_TRACE)
                sim_trace[trace_len++] = fs_state_hash();

            // Record per-tic instruction delta at the same tic boundary.
            if (wd_cycles_fd >= 0 && tic_instr_len < MAX_TRACE) {
                long long now = wd_perf_read(wd_cycles_fd);
                tic_instr[tic_instr_len++] = now - wd_last_count;
                wd_last_count = now;
            }

            last_tic = gametic;
        }
    }

done:
    fs_timedemo_active = 0;
    // Stop and close the instruction counter before emitting output.
    if (wd_cycles_fd >= 0) {
        ioctl(wd_cycles_fd, PERF_EVENT_IOC_DISABLE, 0);
        close(wd_cycles_fd);
        wd_cycles_fd = -1;
    }
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

        // Emit per-tic instruction stats if WD_CYCLES=1 and -cycles was given.
        if (cycles_out)
            emit_cycles_json(cycles_out, tics, tic_instr, tic_instr_len);

        fprintf(stderr, "fs-doom: %d gametics, %d trace entries\n",
                tics, trace_len);
        return 0;
    }
}
