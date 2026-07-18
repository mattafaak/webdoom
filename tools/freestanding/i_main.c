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
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "m_argv.h"
#include "fs_platform.h"
#include "web.h"

extern int prndindex; /* m_random.c — hashed per tic (fs_state_hash) */
#include "perf.h" /* fs_perf_instr_fd, web_perf_*_us — for attribution */
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

// ── WD_RO_WAD=1: read-only WAD blob (13.2c XIP feasibility proof) ────────────
// When WD_RO_WAD=1, the WAD blob is loaded into an anonymous mmap region and
// mprotect(PROT_READ)'d after load.  Any write into the blob triggers SIGSEGV,
// which our handler catches, prints "WAD-BLOB WRITE" + faulting address, and
// exits nonzero — so a violation is a named diagnosis, not a mystery crash.
// This also doubles as a write trap for 13.4 wild-write triage.
//
// Engine/core: ZERO diff.  Shim-only change.

static void  *wd_ro_wad_base = NULL; /* blob start, for handler range check */
static size_t wd_ro_wad_size = 0;    /* blob byte count */

/* Async-signal-safe: print unsigned long as 0x-prefixed hex to fd. */
static void sig_write_hex(int fd, unsigned long v)
{
    /* "0x" + 8 hex digits (32-bit address in -m32 mode) */
    char buf[10];
    int  i;
    buf[0] = '0'; buf[1] = 'x';
    for (i = 9; i >= 2; i--) {
        int d = (int)(v & 0xfUL);
        buf[i] = (char)(d < 10 ? '0' + d : 'a' + d - 10);
        v >>= 4;
    }
    write(fd, buf, 10);
}

static void wd_ro_wad_handler(int sig, siginfo_t *info, void *ctx)
{
    unsigned long fa = (unsigned long)(unsigned)(long)info->si_addr;
    unsigned long base = (unsigned long)(unsigned)(long)wd_ro_wad_base;
    const char hdr[]  = "\nWAD-BLOB WRITE: fault at ";
    const char in[]   = " (write into PROT_READ WAD blob)\n";
    const char out[]  = " (SIGSEGV outside WAD blob range)\n";
    (void)sig; (void)ctx;
    write(2, hdr, sizeof(hdr) - 1);
    sig_write_hex(2, fa);
    if (fa >= base && fa < base + (unsigned long)wd_ro_wad_size)
        write(2, in,  sizeof(in)  - 1);
    else
        write(2, out, sizeof(out) - 1);
    _exit(2);
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
    int    use_ro;

    use_ro = (getenv("WD_RO_WAD") && getenv("WD_RO_WAD")[0] == '1');

    fd = open(path, O_RDONLY);
    if (fd < 0) return NULL;

    sz = (long)lseek(fd, 0, SEEK_END);
    if (sz <= 0 || sz > 64 * 1024 * 1024L) { close(fd); return NULL; }
    lseek(fd, 0, SEEK_SET);

    if (use_ro) {
        /* mmap returns page-aligned memory; mprotect will work on the full
         * mapping without needing manual page rounding. */
        buf = (byte*)mmap(NULL, (size_t)sz, PROT_READ | PROT_WRITE,
                          MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (buf == (byte*)MAP_FAILED) { close(fd); return NULL; }
    } else {
        buf = (byte*)malloc((size_t)sz);
        if (!buf) { close(fd); return NULL; }
    }

    if ((long)read(fd, buf, (size_t)sz) != sz) {
        if (use_ro) munmap(buf, (size_t)sz);
        else free(buf);
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

// ── Per-tic instruction counter buffers (WD_CYCLES=1 only) ───────────────────
// tic_instr: whole-tic instruction deltas (13.1a whole-program floor).
// tic_*_instr: per-stage deltas (13.1b attribution).  Populated by reading
//   the stage accumulators (web_perf_*_us) at each tic boundary; these
//   accumulate instruction deltas when web_perf_now() reads fs_perf_instr_fd.
// tic_instr_len is the common length for all arrays (incremented once per tic).
static long long tic_instr[MAX_TRACE];        /* whole-tic instruction deltas */
static long long tic_sim_instr[MAX_TRACE];    /* sim (G_Ticker) per tic */
static long long tic_bsp_instr[MAX_TRACE];    /* R_RenderBSPNode per tic */
static long long tic_planes_instr[MAX_TRACE]; /* R_DrawPlanes per tic */
static long long tic_masked_instr[MAX_TRACE]; /* R_DrawMasked per tic */
static long long tic_frame_instr[MAX_TRACE];  /* frame setup per tic */
static int       tic_instr_len = 0;
static int       wd_cycles_fd  = -1;  /* perf fd; -1 = not measuring */
static long long wd_last_count = 0;   /* cumulative count at last tic boundary */
// Stage accumulator snapshots at the previous tic boundary (for delta).
static double    snap_sim    = 0;
static double    snap_bsp    = 0;
static double    snap_planes = 0;
static double    snap_masked = 0;
static double    snap_frame  = 0;

// ── Per-subsystem instruction attribution output (13.1b) ──────────────────────
// Writes per-stage instruction stats (sim/frame/bsp/planes/masked/other + whole)
// to -attrib <path>.  Requires WD_CYCLES=1 (otherwise all stages are zero).
// "other" = whole-program − sum(stages); absorbs inter-bracket overhead.
// Sorts each per-tic array in-place for p50/p99 (arrays no longer needed after).
// The "other" array is heap-allocated since MAX_TRACE × 8 B = 2.4 MB on stack.
// Defined AFTER the static arrays it references (C89 forward-reference rule).
typedef struct {
    double    mean;
    long long p50;
    long long p99;
    long long max;
} attrib_stats_t;

static attrib_stats_t attrib_stats(long long *arr, int n)
{
    attrib_stats_t s = {0, 0, 0, 0};
    long long total = 0;
    int i;
    if (n <= 0) return s;
    for (i = 0; i < n; i++) {
        if (arr[i] < 0) arr[i] = 0; /* clamp negative (perf read overhead) */
        total += arr[i];
        if (arr[i] > s.max) s.max = arr[i];
    }
    s.mean = (double)total / n;
    qsort(arr, (size_t)n, sizeof(long long), cmp_llong);
    s.p50 = percentile(arr, n, 50);
    s.p99 = percentile(arr, n, 99);
    return s;
}

static void emit_attrib_json(const char *path, int tics, int n)
{
    attrib_stats_t sim, bsp, planes, masked, frame, whole, other_s;
    long long *other_arr;
    double sum_stages_mean;
    double delta_pct;
    FILE *f;
    int i;

    if (n <= 0 || !path) return;

    /* compute "other" per-tic before sorting destroys index correspondence */
    other_arr = (long long *)malloc((size_t)n * sizeof(long long));
    if (!other_arr) {
        fprintf(stderr, "fs-doom: cannot allocate attribution buffer\n");
        return;
    }
    for (i = 0; i < n; i++) {
        other_arr[i] = tic_instr[i]
            - tic_sim_instr[i] - tic_bsp_instr[i]
            - tic_planes_instr[i] - tic_masked_instr[i]
            - tic_frame_instr[i];
    }

    /* compute stats (sorts each array in-place) */
    whole   = attrib_stats(tic_instr,        n);
    sim     = attrib_stats(tic_sim_instr,    n);
    bsp     = attrib_stats(tic_bsp_instr,    n);
    planes  = attrib_stats(tic_planes_instr, n);
    masked  = attrib_stats(tic_masked_instr, n);
    frame   = attrib_stats(tic_frame_instr,  n);
    other_s = attrib_stats(other_arr,        n);
    free(other_arr);

    /* reconciliation: by construction sum(stages)+other == whole (per-tic).
     * Check the mean totals; residual > ~5% warrants a caveat. */
    sum_stages_mean = sim.mean + bsp.mean + planes.mean
                    + masked.mean + frame.mean + other_s.mean;
    delta_pct = (whole.mean > 0)
        ? (sum_stages_mean - whole.mean) / whole.mean * 100.0
        : 0.0;
    if (delta_pct < 0) delta_pct = -delta_pct;

    f = fopen(path, "w");
    if (!f) {
        fprintf(stderr, "fs-doom: cannot write attrib output: %s\n", path);
        return;
    }
    fprintf(f,
        "{\"tics\":%d,"
        "\"stages\":{"
          "\"sim\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,\"max\":%lld},"
          "\"frame\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,\"max\":%lld},"
          "\"bsp\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,\"max\":%lld},"
          "\"planes\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,\"max\":%lld},"
          "\"masked\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,\"max\":%lld},"
          "\"other\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,\"max\":%lld}"
        "},"
        "\"whole\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,\"max\":%lld},"
        "\"reconciliation_delta_pct\":%.4f"
        "}\n",
        tics,
        sim.mean,     sim.p50,     sim.p99,     sim.max,
        frame.mean,   frame.p50,   frame.p99,   frame.max,
        bsp.mean,     bsp.p50,     bsp.p99,     bsp.max,
        planes.mean,  planes.p50,  planes.p99,  planes.max,
        masked.mean,  masked.p50,  masked.p99,  masked.max,
        other_s.mean, other_s.p50, other_s.p99, other_s.max,
        whole.mean,   whole.p50,   whole.p99,   whole.max,
        delta_pct);
    fclose(f);
}

// ── zone stats emitter (task 13.2b, WEB_PERF_ZONE_STATS only) ────────────────
// Write render-ON zone HWM + purge-pressure stats to -zonestats output file.
// Reads the zone stat globals defined in z_zone.c (compiled with the flag).
#ifdef WEB_PERF_ZONE_STATS
static void emit_zonestats_json(const char *path, int tics, int zone_bytes)
{
    FILE *f;
    if (!path) return;
    f = fopen(path, "w");
    if (!f) {
        fprintf(stderr, "fs-doom: cannot write zonestats output: %s\n", path);
        return;
    }
    fprintf(f,
        "{\"tics\":%d,"
        "\"zone_bytes\":%d,"
        "\"hwm_total\":%ld,"
        "\"hwm_nonpurgeable\":%ld,"
        "\"hwm_purgeable\":%ld,"
        "\"purge_count\":%ld,"
        "\"purged_bytes\":%ld"
        "}\n",
        tics, zone_bytes,
        web_perf_zone_hwm_total,
        web_perf_zone_hwm_np,
        web_perf_zone_hwm_p,
        web_perf_zone_purge_count,
        web_perf_zone_purged_bytes);
    fclose(f);
}
#endif

// ── main ─────────────────────────────────────────────────────────────────────
int main(int argc, char** argv)
{
    const char* wad_path      = NULL;
    const char* sim_out       = NULL;
    const char* cycles_out    = NULL;
    const char* attrib_out    = NULL; /* 13.1b: per-stage attribution output */
    const char* zonestats_out = NULL; /* 13.2b: zone HWM + purge stats output */
    static const char* fwd[64];
    int   fwd_argc = 0;
    int   i;
    int   last_tic;
    int   wad_len;
    byte* wad_data;

    // Peel off the WAD positional arg, -sim, -cycles, -attrib, and -zonestats
    // flags; forward the rest.
    for (i = 0; i < argc && fwd_argc < 63; i++) {
        if (i == 0) { fwd[fwd_argc++] = argv[i]; continue; }
        if (strcmp(argv[i], "-sim") == 0 && i + 1 < argc) {
            sim_out = argv[++i]; continue;
        }
        if (strcmp(argv[i], "-cycles") == 0 && i + 1 < argc) {
            cycles_out = argv[++i]; continue;
        }
        if (strcmp(argv[i], "-attrib") == 0 && i + 1 < argc) {
            attrib_out = argv[++i]; continue;
        }
        if (strcmp(argv[i], "-zonestats") == 0 && i + 1 < argc) {
            zonestats_out = argv[++i]; continue;
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

    // WD_RO_WAD=1: install SIGSEGV handler then mprotect the blob PROT_READ.
    // Must happen AFTER fs_register_wad (files.c has copied the pointer) and
    // BEFORE D_DoomMain (engine must never write the blob after this point).
    if (getenv("WD_RO_WAD") && getenv("WD_RO_WAD")[0] == '1') {
        struct sigaction sa;
        wd_ro_wad_base = (void*)wad_data;
        wd_ro_wad_size = (size_t)wad_len;
        memset(&sa, 0, sizeof(sa));
        sa.sa_sigaction = wd_ro_wad_handler;
        sa.sa_flags     = SA_SIGINFO;
        sigaction(SIGSEGV, &sa, NULL);
        if (mprotect(wad_data, (size_t)wad_len, PROT_READ) != 0) {
            fprintf(stderr, "fs-doom: WD_RO_WAD=1: mprotect failed (errno %d)\n",
                    errno);
            return 1;
        }
        fprintf(stderr,
                "fs-doom: WD_RO_WAD=1: WAD blob %p+%d locked PROT_READ\n",
                (void*)wad_data, wad_len);
    }
    // ══════════════════════════════════════════════════════════════════════════

    myargc = fwd_argc;
    myargv = (char**)fwd;

    fs_timedemo_active   = 1;
    fs_timedemo_gametics = 0;
    trace_len            = 0;
    tic_instr_len        = 0;

    // Open instruction counter before init if WD_CYCLES=1 (shim-only, 13.1a/b).
    // The counter is not started yet (disabled=1); we enable it after D_DoomMain
    // so that init instructions are excluded from the per-tic floor measurement.
    // 13.1b: after opening, share the fd with perf.c via fs_perf_instr_fd so
    // that web_perf_now() can read it inside stage brackets (d_main/r_main).
    if (getenv("WD_CYCLES") && getenv("WD_CYCLES")[0] == '1') {
        wd_cycles_fd = wd_perf_open_instructions();
        if (wd_cycles_fd < 0)
            fprintf(stderr, "fs-doom: WD_CYCLES=1 but perf_event_open failed"
                            " (errno %d); check /proc/sys/kernel/perf_event_paranoid"
                            " (<= 2 required for user-space self-measurement)\n",
                    errno);
    }
    fs_perf_instr_fd = wd_cycles_fd; /* expose to perf.c's web_perf_now() */

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

            // Record per-tic instruction deltas at the tic boundary (13.1a/b).
            // All arrays share the same tic_instr_len index.
            if (wd_cycles_fd >= 0 && tic_instr_len < MAX_TRACE) {
                long long now = wd_perf_read(wd_cycles_fd);
                int n = tic_instr_len;
                tic_instr[n]        = now - wd_last_count;
                // 13.1b: stage deltas from accumulator snapshots.
                // web_perf_*_us accumulate instruction deltas (not µs) when
                // web_perf_now() reads fs_perf_instr_fd (same fd as wd_cycles_fd).
                tic_sim_instr[n]    = (long long)(web_perf_sim_us    - snap_sim);
                tic_bsp_instr[n]    = (long long)(web_perf_bsp_us    - snap_bsp);
                tic_planes_instr[n] = (long long)(web_perf_planes_us - snap_planes);
                tic_masked_instr[n] = (long long)(web_perf_masked_us - snap_masked);
                tic_frame_instr[n]  = (long long)(web_perf_frame_us  - snap_frame);
                wd_last_count = now;
                snap_sim    = web_perf_sim_us;
                snap_bsp    = web_perf_bsp_us;
                snap_planes = web_perf_planes_us;
                snap_masked = web_perf_masked_us;
                snap_frame  = web_perf_frame_us;
                tic_instr_len = n + 1;
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

        // Emit per-subsystem attribution if -attrib was given (13.1b).
        // MUST be called before emit_cycles_json: both sort tic_instr in-place,
        // and emit_attrib_json needs the original per-tic order to compute
        // per-tic "other = whole - sum(stages)" before any sort.
        if (attrib_out)
            emit_attrib_json(attrib_out, tics, tic_instr_len);

        // Emit per-tic instruction stats if WD_CYCLES=1 and -cycles was given.
        // If emit_attrib_json already ran, tic_instr is sorted; qsort on a
        // sorted array is O(n log n) but harmless (stats are the same).
        if (cycles_out)
            emit_cycles_json(cycles_out, tics, tic_instr, tic_instr_len);

        // task 13.2b: emit zone HWM + purge-pressure stats if -zonestats given.
        // Available only when built with -DWEB_PERF_ZONE_STATS.
#ifdef WEB_PERF_ZONE_STATS
        if (zonestats_out)
            emit_zonestats_json(zonestats_out, tics, FS_ZONE_SIZE);
#endif

        fprintf(stderr, "fs-doom: %d gametics, %d trace entries\n",
                tics, trace_len);
        return 0;
    }
}
