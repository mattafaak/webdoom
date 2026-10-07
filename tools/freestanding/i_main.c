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
//   ./fs-doom <wad_path> -timedemo <demo> [-sim <out.json>] [-cycles
//   <out.json>]
//
// Instruction counting (cycle floor):
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
#include "r_main.h"
#include "w_wad.h"  /* W_CacheLumpName: the lump-write probe */
#include "z_zone.h" /* PU_CACHE */
#include "fs_platform.h"
#include "web.h"

/* Vanilla globals: defined in m_menu.c; used for WD_DETAIL opt-in. */
extern int detailLevel;
extern int screenblocks;

#include "perf.h" /* fs_perf_instr_fd, web_perf_*_us — for attribution */
#include "floor_log.h"
#include "g_game.h"  /* G_ExitLevel: -frames mode's scheduled level exit */
#include "r_state.h" /* scaledviewwidth: -frames mode's record */
#include "v_video.h" /* screens[]: -frames mode's record */
#include "z_zone.h"  /* memblock_t: -frames mode's zone poison */

unsigned fs_render_hash (void); /* i_video.c: the render goldens' hash */
extern int fs_zone_bytes;       /* i_system.c: the zone actually handed out */

// Renderer limit counters: globals the frame resets and grows, read after it.
#include "r_defs.h"
extern visplane_t visplanes[], *lastvisplane;
extern drawseg_t drawsegs[], *ds_p;
extern vissprite_t vissprites[], *vissprite_p;
extern short openings[], *lastopening;

#ifdef FS_FIXED_COUNT /* fixed_count.h, force-included by the counting build */
unsigned long long fs_fixedmul_n, fs_fixeddiv_n, fs_fixeddiv_clamped_n;
#endif
void fs_audio_floor (floor_audio_t* a); /* fs_audio.c: the AUDIO line */

// ── Floor gate log (-floor <path>, WD_FLOOR_MODE=A|B) ────────────────────────
// Set by floor_wrap.c's --wrap hooks (native build only), read and cleared at
// each tic boundary.  fs_floor_blob is the WAD blob a lump copy is counted from.
volatile unsigned fs_floor_load;
volatile unsigned fs_floor_mbytes;
const unsigned char* fs_floor_blob;
size_t fs_floor_blob_len;
// ── Sim hash: fs_state_hash.h, one copy shared with tools/cortexm ─────────────
#include "fs_state_hash.h"

// ── Byte-out helpers (no libc I/O — fs_putc only) ────────────────────────────
static void fs_putu (unsigned u)
{
    char buf[12];
    int n = 0;
    if (u == 0)
    {
        fs_putc ('0');
        return;
    }
    while (u)
    {
        buf[n++] = (char) ('0' + u % 10);
        u /= 10;
    }
    while (n--)
        fs_putc (buf[n]);
}

static void fs_puts (const char* s)
{
    while (*s)
        fs_putc ((unsigned char) *s++);
}

// Write {"tics":N,"trace":[...]} via fs_putc.
// Identical JSON shape to nat-doom -sim so compare.py works without conversion.
static void stream_sim_json (int tics, const int* trace, int n)
{
    int i;
    fs_puts ("{\"tics\":");
    fs_putu ((unsigned) tics);
    fs_puts (",\"trace\":[");
    for (i = 0; i < n; i++)
    {
        fs_putu ((unsigned) trace[i]);
        if (i + 1 < n)
            fs_putc (',');
    }
    fs_puts ("]}");
    fs_putc ('\n');
}

// ── Instruction counting (WD_CYCLES=1, shim-only) ────────────────────────────
// Open PERF_COUNT_HW_INSTRUCTIONS for the calling process (pid=0), any CPU,
// no group.  pe.size=0 lets the kernel use its default struct size — required
// for 32-bit compat mode where sizeof(struct perf_event_attr)==144 causes the
// kernel to silently refuse attribution (returns fd but count stays 0).
static int wd_perf_open_instructions (void)
{
    struct perf_event_attr pe;
    memset (&pe, 0, sizeof (pe));
    pe.type = PERF_TYPE_HARDWARE;
    pe.size = 0; /* 0 = kernel default; needed for -m32 compat */
    pe.config = PERF_COUNT_HW_INSTRUCTIONS;
    pe.disabled = 1;
    pe.exclude_kernel = 1;
    pe.exclude_hv = 1;
    return (int) syscall (__NR_perf_event_open, &pe, (pid_t) 0, -1, -1,
                          (unsigned long) 0);
}

static long long wd_perf_read (int fd)
{
    long long v = 0;
    read (fd, &v,
          sizeof (v)); /* no error check: 0 on fail is a safe fallback */
    return v;
}

// qsort comparator for long long.
static int cmp_llong (const void* a, const void* b)
{
    long long x = *(const long long*) a;
    long long y = *(const long long*) b;
    return (x > y) - (x < y);
}

// Compute percentile of a sorted array (0..100).
static long long percentile (long long* sorted, int n, int pct)
{
    int idx = (int) ((long long) n * pct / 100);
    if (idx >= n)
        idx = n - 1;
    return sorted[idx];
}

// Write per-tic instruction stats to -cycles output file.
// Sorts tic_instr in-place (demo is complete; array no longer consumed).
static void emit_cycles_json (const char* path, int tics, long long* arr, int n)
{
    long long total, maxv, p50, p99;
    double mean;
    FILE* f;
    int i;

    if (n <= 0 || !path)
        return;

    total = 0;
    maxv = 0;
    for (i = 0; i < n; i++)
    {
        total += arr[i];
        if (arr[i] > maxv)
            maxv = arr[i];
    }
    qsort (arr, (size_t) n, sizeof (long long), cmp_llong);
    p50 = percentile (arr, n, 50);
    p99 = percentile (arr, n, 99);
    mean = (n > 0) ? (double) total / n : 0.0;

    f = fopen (path, "w");
    if (!f)
    {
        fprintf (stderr, "fs-doom: cannot write cycles output: %s\n", path);
        return;
    }
    fprintf (f,
             "{\"tics\":%d,"
             "\"total_instr\":%lld,"
             "\"instr_per_tic\":{\"mean\":%.1f,\"p50\":%lld,\"p99\":%lld,"
             "\"max\":%lld}"
             "}\n",
             tics, total, mean, p50, p99, maxv);
    fclose (f);
}

// ── WD_RO_WAD=1: read-only WAD blob (XIP feasibility proof) ────────────
// When WD_RO_WAD=1, the WAD blob is loaded into an anonymous mmap region and
// mprotect(PROT_READ)'d after load.  Any write into the blob triggers SIGSEGV,
// which our handler catches, prints "WAD-BLOB WRITE" + faulting address, and
// exits nonzero — so a violation is a named diagnosis, not a mystery crash.
// This also doubles as a write trap for wild-write triage.
//
// Engine/core: ZERO diff.  Shim-only change.

static void* wd_ro_wad_base = NULL; /* blob start, for handler range check */
static size_t wd_ro_wad_size = 0;   /* blob byte count */

/* Async-signal-safe: print unsigned long as 0x-prefixed hex to fd. */
static void sig_write_hex (int fd, unsigned long v)
{
    /* "0x" + 8 hex digits (32-bit address in -m32 mode) */
    char buf[10];
    int i;
    buf[0] = '0';
    buf[1] = 'x';
    for (i = 9; i >= 2; i--)
    {
        int d = (int) (v & 0xfUL);
        buf[i] = (char) (d < 10 ? '0' + d : 'a' + d - 10);
        v >>= 4;
    }
    write (fd, buf, 10);
}

static void wd_ro_wad_handler (int sig, siginfo_t* info, void* ctx)
{
    unsigned long fa = (unsigned long) (unsigned) (long) info->si_addr;
    unsigned long base = (unsigned long) (unsigned) (long) wd_ro_wad_base;
    const char hdr[] = "\nWAD-BLOB WRITE: fault at ";
    const char in[] = " (write into PROT_READ WAD blob)\n";
    const char out[] = " (SIGSEGV outside WAD blob range)\n";
    (void) sig;
    (void) ctx;
    write (2, hdr, sizeof (hdr) - 1);
    sig_write_hex (2, fa);
    if (fa >= base && fa < base + (unsigned long) wd_ro_wad_size)
        write (2, in, sizeof (in) - 1);
    else
        write (2, out, sizeof (out) - 1);
    _exit (2);
}

// ── WAD blob loading (SHIM — the only file I/O in this translation unit)
// ──────
static const char* path_basename (const char* path)
{
    const char* s = strrchr (path, '/');
    return s ? s + 1 : path;
}

static byte* load_wad (const char* path, int* lenout)
{
    int fd;
    long sz;
    byte* buf;
    int use_ro;

    use_ro = (getenv ("WD_RO_WAD") && getenv ("WD_RO_WAD")[0] == '1');

    fd = open (path, O_RDONLY);
    if (fd < 0)
        return NULL;

    sz = (long) lseek (fd, 0, SEEK_END);
    if (sz <= 0 || sz > 64 * 1024 * 1024L)
    {
        close (fd);
        return NULL;
    }
    lseek (fd, 0, SEEK_SET);

    if (use_ro)
    {
        /* mmap returns page-aligned memory; mprotect will work on the full
         * mapping without needing manual page rounding. */
        buf = (byte*) mmap (NULL, (size_t) sz, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (buf == (byte*) MAP_FAILED)
        {
            close (fd);
            return NULL;
        }
    }
    else
    {
        buf = (byte*) malloc ((size_t) sz);
        if (!buf)
        {
            close (fd);
            return NULL;
        }
    }

    if ((long) read (fd, buf, (size_t) sz) != sz)
    {
        if (use_ro)
            munmap (buf, (size_t) sz);
        else
            free (buf);
        close (fd);
        return NULL;
    }
    close (fd);
    *lenout = (int) sz;
    return buf;
}

// ── Trace buffer
// ──────────────────────────────────────────────────────────────
#define MAX_TRACE 300000
static int sim_trace[MAX_TRACE];
static int trace_len;

// ── Per-tic instruction counter buffers (WD_CYCLES=1 only) ───────────────────
// tic_instr: whole-tic instruction deltas (whole-program floor).
// tic_*_instr: per-stage deltas (attribution).  Populated by reading
//   the stage accumulators (web_perf_*_us) at each tic boundary; these
//   accumulate instruction deltas when web_perf_now() reads fs_perf_instr_fd.
// tic_instr_len is the common length for all arrays (incremented once per tic).
static long long tic_instr[MAX_TRACE];        /* whole-tic instruction deltas */
static long long tic_sim_instr[MAX_TRACE];    /* sim (G_Ticker) per tic */
static long long tic_bsp_instr[MAX_TRACE];    /* R_RenderBSPNode per tic */
static long long tic_planes_instr[MAX_TRACE]; /* R_DrawPlanes per tic */
static long long tic_masked_instr[MAX_TRACE]; /* R_DrawMasked per tic */
static long long tic_frame_instr[MAX_TRACE];  /* frame setup per tic */
static int tic_instr_len = 0;
// The floor log's per-tic record, one entry per tic boundary (floor_n).
static unsigned char tic_flags[MAX_TRACE];
static unsigned tic_mbytes[MAX_TRACE];
static int tic_gametic[MAX_TRACE];
static unsigned tic_render[MAX_TRACE]; /* mode A only */
static long long tic_elapsed[MAX_TRACE];
static int floor_n = 0;
// -tictrace: the per-tic record the demand vector is built from
typedef struct
{
    unsigned short visplanes, drawsegs, vissprites;
    unsigned openings;
    unsigned fixedmul, fixeddiv, fixeddiv_clamped;
} tic_peaks_t;
static tic_peaks_t tic_peaks[MAX_TRACE];
static int fs_view_blocks, fs_view_detail; /* the view in force for the run */
static int wd_cycles_fd = -1;       /* perf fd; -1 = not measuring */
static int wd_cycles_fd_was_open = 0;
static long long wd_last_count = 0; /* cumulative count at last tic boundary */
// Stage accumulator snapshots at the previous tic boundary (for delta).
static double snap_sim = 0;
static double snap_bsp = 0;
static double snap_planes = 0;
static double snap_masked = 0;
static double snap_frame = 0;

// ── Per-subsystem instruction attribution output
// ────────────────────── Writes per-stage instruction stats
// (sim/frame/bsp/planes/masked/other + whole) to -attrib <path>.  Requires
// WD_CYCLES=1 (otherwise all stages are zero). "other" = whole-program −
// sum(stages); absorbs inter-bracket overhead. Sorts each per-tic array
// in-place for p50/p99 (arrays no longer needed after). The "other" array is
// heap-allocated since MAX_TRACE × 8 B = 2.4 MB on stack. Defined AFTER the
// static arrays it references (C89 forward-reference rule).
typedef struct
{
    double mean;
    long long p50;
    long long p99;
    long long max;
} attrib_stats_t;

static attrib_stats_t attrib_stats (long long* arr, int n)
{
    attrib_stats_t s = {0, 0, 0, 0};
    long long total = 0;
    int i;
    if (n <= 0)
        return s;
    for (i = 0; i < n; i++)
    {
        if (arr[i] < 0)
            arr[i] = 0; /* clamp negative (perf read overhead) */
        total += arr[i];
        if (arr[i] > s.max)
            s.max = arr[i];
    }
    s.mean = (double) total / n;
    qsort (arr, (size_t) n, sizeof (long long), cmp_llong);
    s.p50 = percentile (arr, n, 50);
    s.p99 = percentile (arr, n, 99);
    return s;
}

static void emit_attrib_json (const char* path, int tics, int n)
{
    attrib_stats_t sim, bsp, planes, masked, frame, whole, other_s;
    long long* other_arr;
    double sum_stages_mean;
    double delta_pct;
    FILE* f;
    int i;

    if (n <= 0 || !path)
        return;

    /* compute "other" per-tic before sorting destroys index correspondence */
    other_arr = (long long*) malloc ((size_t) n * sizeof (long long));
    if (!other_arr)
    {
        fprintf (stderr, "fs-doom: cannot allocate attribution buffer\n");
        return;
    }
    for (i = 0; i < n; i++)
    {
        other_arr[i] = tic_instr[i] - tic_sim_instr[i] - tic_bsp_instr[i] -
                       tic_planes_instr[i] - tic_masked_instr[i] -
                       tic_frame_instr[i];
    }

    /* compute stats (sorts each array in-place) */
    whole = attrib_stats (tic_instr, n);
    sim = attrib_stats (tic_sim_instr, n);
    bsp = attrib_stats (tic_bsp_instr, n);
    planes = attrib_stats (tic_planes_instr, n);
    masked = attrib_stats (tic_masked_instr, n);
    frame = attrib_stats (tic_frame_instr, n);
    other_s = attrib_stats (other_arr, n);
    free (other_arr);

    /* reconciliation: by construction sum(stages)+other == whole (per-tic).
     * Check the mean totals; residual > ~5% warrants a caveat. */
    sum_stages_mean = sim.mean + bsp.mean + planes.mean + masked.mean +
                      frame.mean + other_s.mean;
    delta_pct = (whole.mean > 0)
                    ? (sum_stages_mean - whole.mean) / whole.mean * 100.0
                    : 0.0;
    if (delta_pct < 0)
        delta_pct = -delta_pct;

    f = fopen (path, "w");
    if (!f)
    {
        fprintf (stderr, "fs-doom: cannot write attrib output: %s\n", path);
        return;
    }
    fprintf (
        f,
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
        tics, sim.mean, sim.p50, sim.p99, sim.max, frame.mean, frame.p50,
        frame.p99, frame.max, bsp.mean, bsp.p50, bsp.p99, bsp.max, planes.mean,
        planes.p50, planes.p99, planes.max, masked.mean, masked.p50, masked.p99,
        masked.max, other_s.mean, other_s.p50, other_s.p99, other_s.max,
        whole.mean, whole.p50, whole.p99, whole.max, delta_pct);
    fclose (f);
}

// ── zone stats emitter (WEB_PERF_ZONE_STATS only) ───────────────────────────
// Write render-ON zone HWM + purge-pressure stats to -zonestats output file.
// Reads the zone stat globals defined in z_zone.c (compiled with the flag).
#ifdef WEB_PERF_ZONE_STATS
static void emit_zonestats_json (const char* path, int tics, int zone_bytes)
{
    FILE* f;
    if (!path)
        return;
    f = fopen (path, "w");
    if (!f)
    {
        fprintf (stderr, "fs-doom: cannot write zonestats output: %s\n", path);
        return;
    }
    fprintf (f,
             "{\"tics\":%d,"
             "\"zone_bytes\":%d,"
             "\"hwm_total\":%ld,"
             "\"hwm_nonpurgeable\":%ld,"
             "\"hwm_purgeable\":%ld,"
             "\"purge_count\":%ld,"
             "\"purged_bytes\":%ld"
             "}\n",
             tics, zone_bytes, web_perf_zone_hwm_total, web_perf_zone_hwm_np,
             web_perf_zone_hwm_p, web_perf_zone_purge_count,
             web_perf_zone_purged_bytes);
    fclose (f);
}
#endif

// ── floor log emission (after the demo: never inside a timed tic) ────────────
static FILE* floor_file;
static void floor_file_putc (int c)
{
    fputc (c, floor_file);
}

// "doom-demo3" from "path/to/doom.wad" and "demo3"
static void floor_demo_name (char* out, int cap, const char* wad, const char* demo)
{
    const char* b = path_basename (wad);
    int n = 0;
    while (*b && *b != '.' && n < cap - 1)
        out[n++] = *b++;
    if (n < cap - 1)
        out[n++] = '-';
    while (demo && *demo && n < cap - 1)
        out[n++] = *demo++;
    out[n] = 0;
}

static int emit_floor_log (const char* path, char mode, const char* name,
                           int have_time, unsigned final_sim, unsigned final_render)
{
    floor_header_t h;
    floor_audio_t a;
    int i;
    floor_file = fopen (path, "w");
    if (!floor_file)
    {
        fprintf (stderr, "fs-doom: cannot write floor log: %s\n", path);
        return 0;
    }
    floor_log_init (floor_file_putc);
    memset (&h, 0, sizeof (h));
    h.target = "x86-fs-doom";
    h.source = "host";
    h.unit = have_time ? "instructions" : "none";
    h.unit_hz = 0; /* instructions are demand, not time */
    h.build = getenv ("WD_BUILD") ? getenv ("WD_BUILD") : "unknown";
    h.view = fs_view_blocks;
    h.detail = fs_view_detail;
    h.zone = (unsigned) fs_zone_bytes;
    h.precache = 0;
    h.mode = mode;
    floor_header (&h);
    floor_demo_begin (name, (unsigned) floor_n);
    for (i = 0; i < floor_n; i++)
        floor_tic ((unsigned) i, (unsigned) tic_gametic[i],
                   have_time ? (unsigned long long) tic_elapsed[i] : 0,
                   tic_flags[i], tic_mbytes[i], mode == 'A',
                   (unsigned) sim_trace[i], tic_render[i]);
    fs_audio_floor (&a); /* all zero with WD_AUDIO=0 */
    floor_audio (&a);
    floor_demo_end (name, final_sim, final_render);
    fclose (floor_file);
    return 1;
}

// -tictrace <path>: one tab-separated row per tic, unsorted (written before the
// -cycles/-attrib emitters sort the instruction arrays in place).  The
// instruction columns are 0 unless WD_CYCLES=1; the fixed-point columns are 0
// unless this is the fixed_count.h build.
static void emit_tictrace (const char* path)
{
    FILE* f = fopen (path, "w");
    int i;
    if (!f)
    {
        fprintf (stderr, "fs-doom: cannot write tictrace: %s\n", path);
        return;
    }
    fprintf (f, "i\tgametic\twhole\tsim\tframe\tbsp\tplanes\tmasked\tother\tload\tmbytes"
                "\tvisplanes\tdrawsegs\tvissprites\topenings\tfixedmul\tfixeddiv\tfixeddiv_clamped\n");
    for (i = 0; i < floor_n; i++)
    {
        int c = i < tic_instr_len;
        long long whole = c ? tic_instr[i] : 0;
        long long st[5];
        st[0] = c ? tic_sim_instr[i] : 0;
        st[1] = c ? tic_frame_instr[i] : 0;
        st[2] = c ? tic_bsp_instr[i] : 0;
        st[3] = c ? tic_planes_instr[i] : 0;
        st[4] = c ? tic_masked_instr[i] : 0;
        fprintf (f, "%d\t%d\t%lld\t%lld\t%lld\t%lld\t%lld\t%lld\t%lld\t%d\t%u\t%u\t%u\t%u\t%u\t%u\t%u\t%u\n",
                 i, tic_gametic[i], whole, st[0], st[1], st[2], st[3], st[4],
                 whole - st[0] - st[1] - st[2] - st[3] - st[4],
                 (tic_flags[i] & FLOOR_TIC_LOAD) ? 1 : 0, tic_mbytes[i],
                 tic_peaks[i].visplanes, tic_peaks[i].drawsegs, tic_peaks[i].vissprites,
                 tic_peaks[i].openings, tic_peaks[i].fixedmul, tic_peaks[i].fixeddiv,
                 tic_peaks[i].fixeddiv_clamped);
    }
    fclose (f);
}


// ── -frames <path>: every frame recorded, wipes run to their end ─────────────
// The lean-screens differential (tools/floor/lean-screens-test.mjs) drives the
// paths the 13 demos never reach -- a melt wipe to its end, an intermission and
// the level after it, a narrowed view's border, the status bar coming and
// going -- and compares two builds frame by frame.  This mode has its own loop
// (frames_run), so the demo loop below, and what the floor gate measures, are
// untouched.  One line per D_DoomFrame call, wipe frames included:
//   F <frame> <gametic> <gamestate> <wipeactive> <render> <sim> <held>
//     <scaledviewwidth> <viewheight> <detailshift> <writes> <write hash>
//     <gameepisode> <gamemap>
// <held> has bit n set while screens[n] is allocated (n = 1..4): a
// LEAN_SCREENS build's evidence that it released what it borrowed.
// Set from the environment:
//   WD_WIPES=1              wipes run on the wipe clock (fs_wipe_clock), one
//                           tic per frame while a wipe is active, to their end
//   WD_EXIT_AT=t[,t...]     G_ExitLevel() at the first frame gametic >= t
//   WD_VIEW_AT=t:blocks[:detail][,...]   R_SetViewSize likewise
//   WD_SHOT_AT=t[,t...]     G_ScreenShot() likewise: the PCX it writes is in
//                           the record's write count and hash (files.c)
//   WD_POISON=1             after every frame, every free zone block's bytes
//                           are 0xA5: memory read after it was freed shows
//                           up in the pixels, whoever freed it
//   WD_FREE_AT=f:n          (LEAN_SCREENS) release screens[n] after frame f,
//                           whoever holds it: the red-proofs' wrong lean path
//   WD_SAVE_AT=t:n          save the game there into slot n, as the menu does
//                           (doomsav<n>.dsg, kept by files.c; G_DoSaveGame,
//                           since a demo's ticcmds cannot carry the request),
//                           and record an S line:
//     S <frame> <gametic> <slot> <bytes> <hash>
//                           the FNV-1a hash of the part P_ArchiveWorld wrote
//                           (sectors, lines, sides), which holds no pointer:
//                           unlike the rest of a save it is the same bytes in
//                           any build of the same game
//   WD_LOAD_AT=t:n          load doomsav<n>.dsg there (G_LoadGame, done by
//                           the next tic).  The demo stops (G_InitNew), so the
//                           player stands still from then on: WD_END_AT ends
//                           the run
//   WD_END_AT=t             end the run there, as a demo's end would
//   WD_SAVE_IN=path         a savegame file handed in as doomsav1.dsg before
//                           D_DoomMain: another build's save, for WD_LOAD_AT=t:1
//   WD_SAVE_OUT=path        doomsav0.dsg written out at the end
//   WD_LEVELS_FAULT=k       (LEAN_LEVELS) the red-proofs' wrong lean paths:
//                           glass  SEG_BACK has no null sector (r_state.h)
//                                  from the second frame on: a two-sided line
//                                  with no back side reads as one-sided
//                           save   after the frame a load completed in, every
//                                  side's texture offsets are 0, as a restore
//                                  that dropped them would leave them
//                           twosided  from the second frame on, no line is
//                                  two-sided as loaded (line_t's twosided):
//                                  every seg has no back sector
static FILE* frames_file;
static int   frames_n;
static int   frames_poison;
#define FRAMES_MAX_SCHED 16
static struct { int tic, kind, blocks, detail, done; } frames_sched[FRAMES_MAX_SCHED];
static int   frames_nsched;
static int   frames_free_at = -1, frames_free_scrn;
static int   frames_fault;  /* WD_LEVELS_FAULT: 0 none, 1 glass, 2 save, 3 twosided */
static int   frames_loaded; /* the frame a scheduled load completes in, or -1 */
extern int      fs_write_count; /* files.c: what Web_FileWrite was given */
extern unsigned fs_write_hash;
extern int  savegameslot;       /* g_game.c: the menu's save, done directly */
extern char savedescription[32];
void        G_DoSaveGame (void);

static void frames_parse_sched (const char* env, int kind)
{
    const char* p = getenv (env);
    while (p && *p && frames_nsched < FRAMES_MAX_SCHED)
    {
        int t = 0, b = 0, d = 0, n = 0;
        if (kind != 1 && kind != 3 && kind != 4 ? sscanf (p, "%d%n", &t, &n) < 1
                                                : sscanf (p, "%d:%d%n", &t, &b, &n) < 2)
            break;
        p += n;
        if (kind == 1 && *p == ':' && sscanf (p, ":%d%n", &d, &n) == 1)
            p += n;
        frames_sched[frames_nsched].tic = t;
        frames_sched[frames_nsched].kind = kind;
        frames_sched[frames_nsched].blocks = b;
        frames_sched[frames_nsched].detail = d;
        frames_nsched++;
        if (*p == ',')
            p++;
    }
}

// The zone's own header, as z_zone.c declares it there (memzone_t is private
// to that file).  The walk checks itself: the blocks must link both ways and
// their sizes must add up to the zone, or the layout moved and the poison
// would be writing blind.
typedef struct
{
    int         size;
    memblock_t  blocklist;
    memblock_t* rover;
} fs_memzone_t;
extern fs_memzone_t* mainzone;

static void frames_poison_zone (void)
{
    memblock_t* b;
    long total = 0;
    for (b = mainzone->blocklist.next; b != &mainzone->blocklist; b = b->next)
    {
        if (b->next->prev != b || b->size < (int) sizeof (memblock_t))
            break;
        total += b->size;
        if (!b->user)
            memset ((byte*) b + sizeof (memblock_t), 0xA5,
                    (size_t) b->size - sizeof (memblock_t));
    }
    if (b != &mainzone->blocklist || total != mainzone->size - (long) sizeof (fs_memzone_t))
    {
        fprintf (stderr, "fs-doom: -frames: the zone walk does not add up (%ld of %d B): "
                 "has memzone_t's layout changed?\n", total, mainzone->size);
        exit (3);
    }
}

// WD_SAVE_IN, WD_SAVE_OUT: a savegame file in and out of files.c's keeping,
// above the shim line as the WAD's load is
static int frames_save_in (const char* path)
{
    enum { MAX = 1 << 20 };
    byte* buf = malloc (MAX); /* the heap, as the WAD's: not the zone, not .bss */
    FILE* f = buf ? fopen (path, "rb") : NULL;
    int   n = f ? (int) fread (buf, 1, MAX, f) : -1;
    int   ok;
    if (f)
        fclose (f);
    ok = n > 0 && n < MAX && fs_keep_file ("doomsav1.dsg", buf, n);
    free (buf);
    if (!ok)
        fprintf (stderr, "fs-doom: WD_SAVE_IN: cannot read a savegame from %s\n", path);
    return ok;
}

static int frames_save_out (const char* path)
{
    int         n;
    const byte* d = fs_kept_file ("doomsav0.dsg", &n);
    FILE*       f = d ? fopen (path, "wb") : NULL;
    int         ok = f && fwrite (d, 1, (size_t) n, f) == (size_t) n;
    if (f && fclose (f))
        ok = 0;
    if (!ok)
        fprintf (stderr, "fs-doom: WD_SAVE_OUT: %s\n", d ? "cannot write it" : "the run saved nothing");
    return ok;
}

// The S line: the world's part of the save just written to `slot`.  It
// follows the 50-byte header and each player in the game (padded to 4 as
// PADSAVEP pads, the buffer being malloc's), and is as long as P_ArchiveSize
// counts it.
static void frames_save_world (int slot)
{
    char        name[32];
    int         len, i, j, n = 0, off = 24 + 16 + 3 + MAXPLAYERS + 3;
    unsigned    h = 0x811c9dc5u;
    const byte* d;

    sprintf (name, "doomsav%d.dsg", slot);
    d = fs_kept_file (name, &len);
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i])
            off = ((off + 3) & ~3) + (int) sizeof (player_t);
    for (i = 0; i < numlines; i++)
        for (n += 3, j = 0; j < 2; j++)
            if (lines[i].sidenum[j] != -1)
                n += 5;
    n = (n + numsectors * 7) * (int) sizeof (short);
    if (!d || off + n > len)
    {
        fprintf (stderr, "fs-doom: WD_SAVE_AT: %s is not a whole savegame\n", name);
        exit (3);
    }
    for (i = 0; i < n; i++)
        h = (h ^ d[off + i]) * 0x01000193u;
    fprintf (frames_file, "S %d %d %d %d %u\n", frames_n, gametic, slot, n, h);
}

static void frames_run (void)
{
    fprintf (frames_file, "FRAMES zone=%d wipes=%d poison=%d lean_screens=%d\n",
             fs_zone_bytes, fs_wipe_clock >= 0, frames_poison,
#ifdef LEAN_SCREENS
             1
#else
             0
#endif
             );
    for (;;)
    {
        int i, held = 0;
        for (i = 0; i < frames_nsched; i++)
            if (!frames_sched[i].done && gametic >= frames_sched[i].tic && !wipeactive)
            {
                frames_sched[i].done = 1;
                if (frames_sched[i].kind == 0)
                    G_ExitLevel ();
                else if (frames_sched[i].kind == 2)
                    G_ScreenShot ();
                else if (frames_sched[i].kind == 3)
                {
                    savegameslot = frames_sched[i].blocks;
                    strcpy (savedescription, "fs-doom");
                    G_DoSaveGame ();
                    frames_save_world (savegameslot);
                }
                else if (frames_sched[i].kind == 4)
                {
                    static char name[32];
                    sprintf (name, "doomsav%d.dsg", frames_sched[i].blocks);
                    G_LoadGame (name);
                    frames_loaded = frames_n;
                }
                else if (frames_sched[i].kind == 5)
                {
                    fs_timedemo_gametics = gametic;
                    longjmp (fs_demo_jmp, 1);
                }
                else
                    R_SetViewSize (frames_sched[i].blocks, frames_sched[i].detail);
            }
        if (fs_wipe_clock >= 0)
        {
            if (wipeactive)
                fs_wipe_clock++;
        }
        else
            wipeactive = 0; /* as the demo loop does */

        D_DoomFrame ();

        for (i = 1; i <= 4; i++)
            if (screens[i])
                held |= 1 << i;
        fprintf (frames_file, "F %d %d %d %d %u %u %d %d %d %d %d %u %d %d\n", frames_n, gametic,
                 (int) gamestate, wipeactive ? 1 : 0, fs_render_hash (),
                 (unsigned) fs_state_hash (), held, scaledviewwidth, viewheight,
                 detailshift, fs_write_count, fs_write_hash, gameepisode, gamemap);
#ifdef LEAN_SCREENS
        if (frames_n == frames_free_at)
            V_ReleaseScreen (frames_free_scrn);
#endif
#ifdef LEAN_LEVELS
        if (frames_fault == 1)
            p_nullsector = NULL;
        if (frames_fault == 2 && frames_n == frames_loaded)
            for (i = 0; i < numsides; i++)
                sides[i].textureoffset16 = sides[i].rowoffset16 = 0;
        if (frames_fault == 3)
            for (i = 0; i < numlines; i++)
                lines[i].twosided = 0;
#endif
        if (frames_poison)
            frames_poison_zone ();
        frames_n++;
    }
}

// ── main ─────────────────────────────────────────────────────────────────────
int main (int argc, char** argv)
{
    const char* wad_path = NULL;
    const char* sim_out = NULL;
    const char* cycles_out = NULL;
    const char* attrib_out = NULL;    /* per-stage attribution output */
    const char* zonestats_out = NULL; /* zone HWM + purge stats output */
    const char* floor_out = NULL;     /* floor gate log */
    const char* tictrace_out = NULL;  /* per-tic demand rows */
    const char* timedemo = NULL;      /* the demo lump, for the log's name */
    const char* frames_out = NULL;    /* -frames: every frame recorded */
    char floor_mode = 'A';
    static const char* fwd[64];
    int fwd_argc = 0;
    int i;
    int last_tic;
    int wad_len;
    byte* wad_data;

    // Peel off the WAD positional arg, -sim, -cycles, -attrib, and -zonestats
    // flags; forward the rest.
    for (i = 0; i < argc && fwd_argc < 63; i++)
    {
        if (i == 0)
        {
            fwd[fwd_argc++] = argv[i];
            continue;
        }
        if (strcmp (argv[i], "-sim") == 0 && i + 1 < argc)
        {
            sim_out = argv[++i];
            continue;
        }
        if (strcmp (argv[i], "-cycles") == 0 && i + 1 < argc)
        {
            cycles_out = argv[++i];
            continue;
        }
        if (strcmp (argv[i], "-attrib") == 0 && i + 1 < argc)
        {
            attrib_out = argv[++i];
            continue;
        }
        if (strcmp (argv[i], "-zonestats") == 0 && i + 1 < argc)
        {
            zonestats_out = argv[++i];
            continue;
        }
        if (strcmp (argv[i], "-floor") == 0 && i + 1 < argc)
        {
            floor_out = argv[++i];
            continue;
        }
        if (strcmp (argv[i], "-tictrace") == 0 && i + 1 < argc)
        {
            tictrace_out = argv[++i];
            continue;
        }
        if (strcmp (argv[i], "-frames") == 0 && i + 1 < argc)
        {
            frames_out = argv[++i];
            continue;
        }
        if (strcmp (argv[i], "-timedemo") == 0 && i + 1 < argc)
            timedemo = argv[i + 1]; /* still forwarded below */
        // First bare positional (non-flag) argument is the WAD path.
        if (argv[i][0] != '-' && wad_path == NULL)
        {
            wad_path = argv[i];
            continue;
        }
        fwd[fwd_argc++] = argv[i];
    }

    if (!wad_path)
    {
        fs_puts ("fs-doom: usage: fs-doom <wad> -timedemo <demo> [-sim "
                 "<out.json>]\n");
        return 1;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SHIM LINE — WAD blob loading: the only open/read/malloc below D_DoomMain.
    // ══════════════════════════════════════════════════════════════════════════
    wad_data = load_wad (wad_path, &wad_len);
    if (!wad_data)
    {
        fs_puts ("fs-doom: cannot load WAD: ");
        fs_puts (wad_path);
        fs_putc ('\n');
        return 1;
    }
    // Hand the blob to files.c — no more file I/O below this point.
    fs_register_wad (path_basename (wad_path), wad_data, wad_len);
    fs_floor_blob = wad_data;
    fs_floor_blob_len = (size_t) wad_len;
    if (getenv ("WD_FLOOR_MODE"))
        floor_mode = getenv ("WD_FLOOR_MODE")[0] == 'B' ? 'B' : 'A';

    // WD_RO_WAD=1: install SIGSEGV handler then mprotect the blob PROT_READ.
    // Must happen AFTER fs_register_wad (files.c has copied the pointer) and
    // BEFORE D_DoomMain (engine must never write the blob after this point).
    if (getenv ("WD_RO_WAD") && getenv ("WD_RO_WAD")[0] == '1')
    {
        struct sigaction sa;
        wd_ro_wad_base = (void*) wad_data;
        wd_ro_wad_size = (size_t) wad_len;
        memset (&sa, 0, sizeof (sa));
        sa.sa_sigaction = wd_ro_wad_handler;
        sa.sa_flags = SA_SIGINFO;
        sigaction (SIGSEGV, &sa, NULL);
        if (mprotect (wad_data, (size_t) wad_len, PROT_READ) != 0)
        {
            fprintf (stderr,
                     "fs-doom: WD_RO_WAD=1: mprotect failed (errno %d)\n",
                     errno);
            return 1;
        }
        fprintf (stderr,
                 "fs-doom: WD_RO_WAD=1: WAD blob %p+%d locked PROT_READ\n",
                 (void*) wad_data, wad_len);
    }
    // ══════════════════════════════════════════════════════════════════════════

    myargc = fwd_argc;
    myargv = (char**) fwd;

    fs_timedemo_active = 1;
    fs_timedemo_gametics = 0;
    trace_len = 0;
    tic_instr_len = 0;

    // Open instruction counter before init if WD_CYCLES=1 (shim-only, 13.1a/b).
    // The counter is not started yet (disabled=1); we enable it after
    // D_DoomMain so that init instructions are excluded from the per-tic floor
    // measurement. After opening, share the fd with perf.c via
    // fs_perf_instr_fd so that web_perf_now() can read it inside stage brackets
    // (d_main/r_main).
    if (getenv ("WD_CYCLES") && getenv ("WD_CYCLES")[0] == '1')
    {
        wd_cycles_fd = wd_perf_open_instructions ();
        if (wd_cycles_fd < 0)
            fprintf (stderr,
                     "fs-doom: WD_CYCLES=1 but perf_event_open failed"
                     " (errno %d); check /proc/sys/kernel/perf_event_paranoid"
                     " (<= 2 required for user-space self-measurement)\n",
                     errno);
    }
    fs_perf_instr_fd = wd_cycles_fd; /* expose to perf.c's web_perf_now() */

    if (frames_out)
    {
        frames_file = fopen (frames_out, "w");
        if (!frames_file)
        {
            fprintf (stderr, "fs-doom: cannot write %s\n", frames_out);
            return 1;
        }
        // a line at a time: a run that dies keeps every frame it finished
        setvbuf (frames_file, NULL, _IOLBF, 0);
        if (getenv ("WD_WIPES") && getenv ("WD_WIPES")[0] == '1')
            fs_wipe_clock = 0;
        frames_poison = getenv ("WD_POISON") && getenv ("WD_POISON")[0] == '1';
        frames_parse_sched ("WD_EXIT_AT", 0);
        frames_parse_sched ("WD_VIEW_AT", 1);
        frames_parse_sched ("WD_SHOT_AT", 2);
        frames_parse_sched ("WD_SAVE_AT", 3);
        frames_parse_sched ("WD_LOAD_AT", 4);
        frames_parse_sched ("WD_END_AT", 5);
        frames_loaded = -1;
        if (getenv ("WD_SAVE_IN") && !frames_save_in (getenv ("WD_SAVE_IN")))
            return 1;
        if (getenv ("WD_LEVELS_FAULT"))
            frames_fault = !strcmp (getenv ("WD_LEVELS_FAULT"), "glass") ? 1
                           : !strcmp (getenv ("WD_LEVELS_FAULT"), "save") ? 2
                           : !strcmp (getenv ("WD_LEVELS_FAULT"), "twosided") ? 3 : -1;
#ifdef LEAN_LEVELS
        if (frames_fault < 0)
#else
        if (frames_fault)
#endif
        {
            fprintf (stderr, "fs-doom: WD_LEVELS_FAULT is glass, save or twosided, in a LEAN_LEVELS build\n");
            return 1;
        }
        if (getenv ("WD_FREE_AT"))
            sscanf (getenv ("WD_FREE_AT"), "%d:%d", &frames_free_at, &frames_free_scrn);
#ifndef LEAN_SCREENS
        if (frames_free_at >= 0)
        {
            fprintf (stderr, "fs-doom: WD_FREE_AT needs a LEAN_SCREENS build\n");
            return 1;
        }
#endif
    }

    if (setjmp (fs_demo_jmp) != 0)
        goto done;

    D_DoomMain (); // init + loads WAD via fs_register_wad/W_WebFile; no disk
                   // I/O

    // WD_DETAIL=1: opt-in low-detail mode for bare-metal/freestanding.
    // Routes through the vanilla R_SetViewSize mechanism so
    // R_ExecuteSetViewSize rebuilds view tables with detailshift=1 on the first
    // D_DoomFrame. Do NOT poke detailshift directly (view tables must be
    // rebuilt vanilla's way).
    // WD_VIEW=<3..11> picks the view size the same way (11 = the full
    // 320x200 view with no status bar; the goldens are screenblocks 10).
    fs_view_blocks = screenblocks;
    fs_view_detail = detailLevel;
    if (getenv ("WD_VIEW") && atoi (getenv ("WD_VIEW")) >= 3 && atoi (getenv ("WD_VIEW")) <= 11)
        fs_view_blocks = atoi (getenv ("WD_VIEW"));
    if (getenv ("WD_DETAIL") && getenv ("WD_DETAIL")[0] == '1')
        fs_view_detail = 1;
    if (fs_view_blocks != screenblocks || fs_view_detail != detailLevel)
    {
        R_SetViewSize (fs_view_blocks, fs_view_detail);
        fprintf (stderr, "fs-doom: view %d, %s detail\n", fs_view_blocks,
                 fs_view_detail ? "low" : "high");
    }

    // WD_LUMP_WRITE_PROBE=1 (ro-wad-check.sh): write one byte of the lump
    // W_CacheLumpName hands the engine for PLAYPAL back over itself, then
    // exit 3.  Under WD_RO_WAD=1 a build that reads lumps in place
    // (fs-doom-zc) must fault here, inside the blob (exit 2, from the
    // handler); a copying build writes its own zone copy and gets here.
    if (getenv ("WD_LUMP_WRITE_PROBE") && getenv ("WD_LUMP_WRITE_PROBE")[0] == '1')
    {
        volatile byte* p = (volatile byte*) W_CacheLumpName ("PLAYPAL", PU_CACHE);
        int in = (const byte*) p >= wad_data && (const byte*) p < wad_data + wad_len;
        fprintf (stderr, "fs-doom: lump-write probe: PLAYPAL at %p, %s the WAD blob\n",
                 (void*) p, in ? "inside" : "outside");
        *p = *p;
        fprintf (stderr, "fs-doom: lump-write probe: wrote PLAYPAL[0], no fault\n");
        return 3;
    }

    // Disable smooth render interpolation (non-deterministic wall-clock drift).
    smoothrender = false;
    last_tic = -1;
    // D_DoomMain's own WAD reads (R_InitTextures alone reads every patch) are
    // init, not tic 0: left in, they made tic 0 claim 5,017,670 B of doom.wad
    // that no tic copied.  They are still the evidence that the memcpy hook is
    // linked when no tic copies a byte (a build that reads every lump in place
    // and keeps its composites const): tools/floor/run-x86.sh reads this line.
    fprintf (stderr, "fs-doom: init copied %u B out of the WAD\n", fs_floor_mbytes);
    fs_floor_load = 0;
    fs_floor_mbytes = 0;

    if (frames_out)
        frames_run (); /* returns only through the demo's end (fs_demo_jmp) */

    // Enable the instruction counter after init, before the demo loop.
    // Read the initial cumulative value so the first per-tic delta is correct.
    if (wd_cycles_fd >= 0)
    {
        ioctl (wd_cycles_fd, PERF_EVENT_IOC_RESET, 0);
        ioctl (wd_cycles_fd, PERF_EVENT_IOC_ENABLE, 0);
        wd_last_count = wd_perf_read (wd_cycles_fd);
    }

    for (;;)
    {
        wipeactive = 0; // suppress non-deterministic melt wipes
        D_DoomFrame ();

        if (gametic != last_tic)
        {
            // The tic's count is read first, so the harness's own work below
            // (hashing, bookkeeping) is charged to no tic: wd_last_count is
            // re-read once it is done.
            long long now = wd_cycles_fd >= 0 ? wd_perf_read (wd_cycles_fd) : 0;
            unsigned flags = fs_floor_load ? FLOOR_TIC_LOAD : 0;
            unsigned mbytes = fs_floor_mbytes;
            fs_floor_load = 0;
            fs_floor_mbytes = 0;

            // Mode B (floor timing) hashes nothing per tic; the final state
            // hash on the END line stands in for the trace.
            if (trace_len < MAX_TRACE && !(floor_out && floor_mode == 'B'))
                sim_trace[trace_len++] = fs_state_hash ();
            if ((floor_out || tictrace_out) && floor_n < MAX_TRACE)
            {
                tic_peaks_t* pk = &tic_peaks[floor_n];
                pk->visplanes = (unsigned short) (lastvisplane ? lastvisplane - visplanes : 0);
                pk->drawsegs = (unsigned short) (ds_p ? ds_p - drawsegs : 0);
                pk->vissprites = (unsigned short) (vissprite_p ? vissprite_p - vissprites : 0);
                pk->openings = (unsigned) (lastopening ? lastopening - openings : 0);
#ifdef FS_FIXED_COUNT
                {
                    static unsigned long long m0, d0, c0;
                    pk->fixedmul = (unsigned) (fs_fixedmul_n - m0);
                    pk->fixeddiv = (unsigned) (fs_fixeddiv_n - d0);
                    pk->fixeddiv_clamped = (unsigned) (fs_fixeddiv_clamped_n - c0);
                    m0 = fs_fixedmul_n;
                    d0 = fs_fixeddiv_n;
                    c0 = fs_fixeddiv_clamped_n;
                }
#endif
                tic_flags[floor_n] = (unsigned char) flags;
                tic_mbytes[floor_n] = mbytes;
                tic_gametic[floor_n] = gametic;
                tic_elapsed[floor_n] = wd_cycles_fd >= 0 ? now - wd_last_count : 0;
                tic_render[floor_n] = floor_mode == 'A' ? fs_render_hash () : 0;
                floor_n++;
            }

            // Record per-tic instruction deltas at the tic boundary (13.1a/b).
            // All arrays share the same tic_instr_len index.
            if (wd_cycles_fd >= 0 && tic_instr_len < MAX_TRACE)
            {
                int n = tic_instr_len;
                tic_instr[n] = now - wd_last_count;
                // stage deltas from accumulator snapshots.
                // web_perf_*_us accumulate instruction deltas (not µs) when
                // web_perf_now() reads fs_perf_instr_fd (same fd as
                // wd_cycles_fd).
                tic_sim_instr[n] = (long long) (web_perf_sim_us - snap_sim);
                tic_bsp_instr[n] = (long long) (web_perf_bsp_us - snap_bsp);
                tic_planes_instr[n] =
                    (long long) (web_perf_planes_us - snap_planes);
                tic_masked_instr[n] =
                    (long long) (web_perf_masked_us - snap_masked);
                tic_frame_instr[n] =
                    (long long) (web_perf_frame_us - snap_frame);
                wd_last_count = now;
                snap_sim = web_perf_sim_us;
                snap_bsp = web_perf_bsp_us;
                snap_planes = web_perf_planes_us;
                snap_masked = web_perf_masked_us;
                snap_frame = web_perf_frame_us;
                tic_instr_len = n + 1;
            }
            if (wd_cycles_fd >= 0)
                wd_last_count = wd_perf_read (wd_cycles_fd);

            last_tic = gametic;
        }
    }

done:
    fs_timedemo_active = 0;
    if (frames_file)
    {
        fprintf (frames_file, "END frames=%d gametics=%d\n", frames_n, fs_timedemo_gametics);
        fclose (frames_file);
        frames_file = NULL;
        if (getenv ("WD_SAVE_OUT") && !frames_save_out (getenv ("WD_SAVE_OUT")))
            return 1;
    }
    wd_cycles_fd_was_open = wd_cycles_fd >= 0;
    // Stop and close the instruction counter before emitting output.
    if (wd_cycles_fd >= 0)
    {
        ioctl (wd_cycles_fd, PERF_EVENT_IOC_DISABLE, 0);
        close (wd_cycles_fd);
        wd_cycles_fd = -1;
    }
    {
        int tics = fs_timedemo_gametics;

        if (tictrace_out)
            emit_tictrace (tictrace_out);

        // The floor log first: emit_attrib_json and emit_cycles_json sort the
        // instruction arrays in place.  The END line's final hashes are taken
        // here, on the state the demo ended in, the same point in both modes.
        if (floor_out)
        {
            char name[64];
            // WD_FLOOR_NAME names the demo when the WAD is presented under
            // another name (doom.wad as doomu.wad for demo4's retail mode)
            if (getenv ("WD_FLOOR_NAME"))
            {
                strncpy (name, getenv ("WD_FLOOR_NAME"), sizeof (name) - 1);
                name[sizeof (name) - 1] = 0;
            }
            else
                floor_demo_name (name, (int) sizeof (name), wad_path, timedemo);
            if (!emit_floor_log (floor_out, floor_mode, name, wd_cycles_fd_was_open,
                                 (unsigned) fs_state_hash (), fs_render_hash ()))
                return 1;
        }

        // (b) BYTE-OUT: stream JSON via fs_putc (write(1,...)).
        // Redirect stdout to a .json file for compare.py compatibility.
        stream_sim_json (tics, sim_trace, trace_len);

        // Also write to -sim file if requested (shim convenience for
        // compare.py).
        if (sim_out)
        {
            FILE* f = fopen (sim_out, "w");
            if (f)
            {
                fprintf (f, "{\"tics\":%d,\"trace\":[", tics);
                for (i = 0; i < trace_len; i++)
                {
                    fprintf (f, "%u", (unsigned) sim_trace[i]);
                    if (i + 1 < trace_len)
                        fputc (',', f);
                }
                fputs ("]}", f);
                fclose (f);
            }
        }

        // Emit per-subsystem attribution if -attrib was given.
        // MUST be called before emit_cycles_json: both sort tic_instr in-place,
        // and emit_attrib_json needs the original per-tic order to compute
        // per-tic "other = whole - sum(stages)" before any sort.
        if (attrib_out)
            emit_attrib_json (attrib_out, tics, tic_instr_len);

        // Emit per-tic instruction stats if WD_CYCLES=1 and -cycles was given.
        // If emit_attrib_json already ran, tic_instr is sorted; qsort on a
        // sorted array is O(n log n) but harmless (stats are the same).
        if (cycles_out)
            emit_cycles_json (cycles_out, tics, tic_instr, tic_instr_len);

        // emit zone HWM + purge-pressure stats if -zonestats given.
        // Available only when built with -DWEB_PERF_ZONE_STATS.
#ifdef WEB_PERF_ZONE_STATS
        if (zonestats_out)
            emit_zonestats_json (zonestats_out, tics, FS_ZONE_SIZE);
#endif

        fprintf (stderr, "fs-doom: %d gametics, %d trace entries\n", tics,
                 trace_len);
#ifdef WEB_PERF_PLANE_STATS
        fprintf (stderr, "visplane_peak: %ld\n", web_perf_visplane_peak);
#endif
#ifdef WEB_PERF_DRAWSEG_STATS
        fprintf (stderr, "drawseg_peak: %ld\n", web_perf_drawseg_peak);
#endif
#ifdef WEB_PERF_OPENINGS_STATS
        fprintf (stderr, "opening_peak: %ld\n", web_perf_opening_peak);
#endif
        return 0;
    }
}
