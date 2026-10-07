// tools/cortexm/cm_main.c — the Cortex-M demo harness: one timedemo per boot,
// measured in guest instructions, written as a floor log.
//
// Lineage: tools/baremetal/i_main.c (deleted in 6609b57), which reached
// D_DoomMain OS-less on an ARMv7-A and stopped there.  The loop and the tic
// boundary are tools/freestanding/i_main.c's (fs-doom), so the two harnesses
// measure the same thing:
//
//   - one D_DoomFrame per tic (timedemo sets singletics), wipes suppressed;
//   - at each tic boundary the timer is read FIRST, then the harness hashes and
//     books the tic, then the timer is read again: the harness's own work is
//     charged to no tic;
//   - mode A hashes every tic (fs_state_hash, fs_render_hash); mode B hashes
//     nothing per tic, and the END line's final hashes stand in;
//   - the floor log (tools/floor/floor_log.c) is written after the demo, never
//     inside a timed tic.
//
// The command line arrives by semihosting (qemu -semihosting-config ...,arg=):
//   cm-doom -wad PATH -as NAME -timedemo demoN -floor LOG -mode A|B
//           -name DEMO -build ID -stats FILE
//
// Units.  qemu runs with -icount shift=0: one guest instruction is 1 ns of
// virtual time.  A tic's instructions are (timer steps) x CM_INSN_PER_TICK, to
// within one step (40 instructions on the an385, 50 on the an505); selftest.c
// is the proof.
//
// The stats file carries what the floor log has no field for, one line per
// tic: the engine's own stage brackets (web_perf_now() returns the timer, via
// perf.c's FS_PERF_COUNTER), and in a helper-counting build the calls into each
// libgcc helper (helpers.S); plus the peak stack (the region is painted at
// reset by crt0.S).
// Copyright (C) 2026, GPL-2.0-or-later.
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "m_argv.h"
#include "r_main.h"
#include "fs_platform.h"
#include "web.h"
#include "perf.h"
#include "floor_log.h"
#include "fs_state_hash.h"

#include "board.h"
#include "semihost.h"

extern int detailLevel;         /* m_menu.c */
extern int screenblocks;        /* m_menu.c */
unsigned fs_render_hash (void); /* tools/freestanding/i_video.c */
unsigned cm_wad_open (const char* path, const char* present_as);
extern unsigned cm_wad_reads;

// ── floor_wrap.c's tic flags (it is linked with the same --wrap hooks) ───────
volatile unsigned fs_floor_load;
volatile unsigned fs_floor_mbytes;
const unsigned char* fs_floor_blob;
size_t fs_floor_blob_len;

#ifndef CM_TARGET
#error "CM_TARGET names the floor log's target (the Makefile sets it)"
#endif
#ifndef CM_BUILD_DESC
#define CM_BUILD_DESC "unknown"
#endif

// ── libgcc helper counters (helpers.S, a counting build only) ────────────────
#ifdef CM_COUNT_HELPERS
extern volatile unsigned cm_hcount[];
extern const char* const cm_hnames[];
extern const unsigned cm_nhelpers;
#define NH_MAX 32
#else
#define NH_MAX 1
#endif

// ── per-tic records, in PSRAM (sections.ld's .big) ──────────────────────────
#define CM_MAX_TICS 8192 /* the longest demo, plutonia-demo1, is 7,403 */
#define BIG(n) __attribute__ ((section (".bss.cm_big." #n)))
static unsigned t_gametic[CM_MAX_TICS] BIG (gametic);
static unsigned t_elapsed[CM_MAX_TICS] BIG (elapsed);
static unsigned t_mbytes[CM_MAX_TICS] BIG (mbytes);
static unsigned t_sim[CM_MAX_TICS] BIG (sim);
static unsigned t_render[CM_MAX_TICS] BIG (render);
static unsigned char t_flags[CM_MAX_TICS] BIG (flags);
static unsigned t_stage[CM_MAX_TICS][5] BIG (stage);
static unsigned t_helper[CM_MAX_TICS][NH_MAX] BIG (helper);
// written after setjmp and read after the longjmp that ends the demo: volatile,
// or a register copy restored by longjmp wins (stack_init read 0 that way)
static volatile int ntics;
static volatile int overflow;
static volatile unsigned stack_init;

// ── output through semihosting, buffered ─────────────────────────────────────
static int out_fd = -1;
static unsigned out_n;
static char out_buf[4096];
static void out_flush (void)
{
    if (out_n && sh_write (out_fd, out_buf, out_n) != 0)
    {
        cm_uart_puts ("FAIL cm-doom: a semihosted write was short\n");
        sh_exit (7);
    }
    out_n = 0;
}
static void out_putc (int c)
{
    out_buf[out_n++] = (char) c;
    if (out_n == sizeof (out_buf))
        out_flush ();
}
static void out_puts (const char* s)
{
    while (*s)
        out_putc ((unsigned char) *s++);
}
static void out_putu (unsigned v)
{
    char b[12];
    int n = 0;
    do
    {
        b[n++] = (char) ('0' + v % 10);
        v /= 10;
    } while (v);
    while (n--)
        out_putc (b[n]);
}
static int out_open (const char* path)
{
    out_fd = sh_open (path, 4 /* "w" */);
    out_n = 0;
    return out_fd >= 0;
}
static void out_close (void)
{
    out_flush ();
    sh_close (out_fd);
    out_fd = -1;
}

// ── the command line ─────────────────────────────────────────────────────────
static char cmdline[1024];
static const char* arg (int argc, char** argv, const char* key)
{
    int i;
    for (i = 1; i + 1 < argc; i++)
        if (!strcmp (argv[i], key))
            return argv[i + 1];
    return NULL;
}
static void need (const char* v, const char* key)
{
    if (!v)
    {
        cm_uart_puts ("FAIL cm-doom: no ");
        cm_uart_puts (key);
        cm_uart_puts (" on the semihosting command line\n");
        sh_exit (2);
    }
}

static const char* fwd[4];

void cm_start (void)
{
    static char* argv[32];
    int argc = 0;
    char* p;
    const char *wad, *as, *demo, *floor_path, *mode_s, *name, *build, *stats;
    char mode;
    unsigned stack_demo, last, k;
    int last_tic;
    double snap[5];
#ifdef CM_COUNT_HELPERS
    unsigned hlast[NH_MAX], hnow[NH_MAX];
#endif

    if (sh_cmdline (cmdline, sizeof (cmdline)) != 0)
        need (NULL, "command line");
    for (p = cmdline; *p && argc < 31;)
    {
        while (*p == ' ')
            *p++ = 0;
        if (!*p)
            break;
        argv[argc++] = p;
        while (*p && *p != ' ')
            p++;
    }
    need (wad = arg (argc, argv, "-wad"), "-wad");
    need (as = arg (argc, argv, "-as"), "-as");
    need (demo = arg (argc, argv, "-timedemo"), "-timedemo");
    need (floor_path = arg (argc, argv, "-floor"), "-floor");
    need (mode_s = arg (argc, argv, "-mode"), "-mode");
    need (name = arg (argc, argv, "-name"), "-name");
    need (build = arg (argc, argv, "-build"), "-build");
    need (stats = arg (argc, argv, "-stats"), "-stats");
    // exactly A or B: a typo must not quietly run the other mode
    if ((mode_s[0] != 'A' && mode_s[0] != 'B') || mode_s[1])
        need (NULL, "-mode A or -mode B");
    mode = mode_s[0];

    cm_uart_puts ("cm-doom: " CM_TARGET " on " CM_BOARD_NAME ", ");
    cm_uart_puts (name);
    cm_uart_puts (" mode ");
    cm_uart_putc (mode);
    cm_uart_puts ("\n");

    cm_wad_open (wad, as);

    fwd[0] = "cm-doom";
    fwd[1] = "-timedemo";
    fwd[2] = demo;
    myargc = 3;
    myargv = (char**) fwd;

    fs_timedemo_active = 1;
    fs_timedemo_gametics = 0;
    if (setjmp (fs_demo_jmp) != 0)
        goto done;

    D_DoomMain ();
    smoothrender = false;
    // the peak stack: init's (painted at reset by crt0.S), then repaint
    // below this frame so the demo loop's is measured on its own
    stack_init = cm_stack_peak ();
    cm_stack_repaint ();

    k = CM_INSN_PER_TICK;
    snap[0] = web_perf_sim_us;
    snap[1] = web_perf_frame_us;
    snap[2] = web_perf_bsp_us;
    snap[3] = web_perf_planes_us;
    snap[4] = web_perf_masked_us;
#ifdef CM_COUNT_HELPERS
    {
        unsigned h;
        for (h = 0; h < cm_nhelpers; h++)
            hlast[h] = cm_hcount[h];
    }
#endif
    last_tic = -1;
    fs_floor_load = 0;
    fs_floor_mbytes = 0;
    last = cm_ticks ();
    for (;;)
    {
        wipeactive = 0; // melt wipes are wall-clock driven: suppressed
        D_DoomFrame ();
        if (gametic != last_tic)
        {
            unsigned now = cm_ticks ();
            int n = ntics;
#ifdef CM_COUNT_HELPERS
            unsigned h;
            for (h = 0; h < cm_nhelpers; h++)
                hnow[h] = cm_hcount[h];
#endif
            if (n < CM_MAX_TICS)
            {
                double s;
                t_elapsed[n] = (now - last) * k;
                t_gametic[n] = (unsigned) gametic;
                t_flags[n] =
                    (unsigned char) (fs_floor_load ? FLOOR_TIC_LOAD : 0);
                t_mbytes[n] = fs_floor_mbytes;
                if (mode == 'A')
                {
                    t_sim[n] = (unsigned) fs_state_hash ();
                    t_render[n] = fs_render_hash ();
                }
                s = web_perf_sim_us;
                t_stage[n][0] = (unsigned) (s - snap[0]) * k;
                snap[0] = s;
                s = web_perf_frame_us;
                t_stage[n][1] = (unsigned) (s - snap[1]) * k;
                snap[1] = s;
                s = web_perf_bsp_us;
                t_stage[n][2] = (unsigned) (s - snap[2]) * k;
                snap[2] = s;
                s = web_perf_planes_us;
                t_stage[n][3] = (unsigned) (s - snap[3]) * k;
                snap[3] = s;
                s = web_perf_masked_us;
                t_stage[n][4] = (unsigned) (s - snap[4]) * k;
                snap[4] = s;
#ifdef CM_COUNT_HELPERS
                for (h = 0; h < cm_nhelpers; h++)
                    t_helper[n][h] = hnow[h] - hlast[h];
#endif
                ntics = n + 1;
            }
            else
                overflow = 1;
            fs_floor_load = 0;
            fs_floor_mbytes = 0;
            last_tic = gametic;
#ifdef CM_COUNT_HELPERS
            // the harness's own helper calls above are charged to no tic
            for (h = 0; h < cm_nhelpers; h++)
                hlast[h] = cm_hcount[h];
#endif
            last = cm_ticks ();
        }
    }

done:
    fs_timedemo_active = 0;
    stack_demo = cm_stack_peak ();
    if (overflow)
    {
        cm_uart_puts ("FAIL cm-doom: more than CM_MAX_TICS tics\n");
        sh_exit (5);
    }
    {
        floor_header_t h;
        floor_audio_t a;
        int i;
        unsigned final_sim = (unsigned) fs_state_hash ();
        unsigned final_render = fs_render_hash ();

        if (!out_open (floor_path))
            need (NULL, "writable -floor path");
        floor_log_init (out_putc);
        memset (&h, 0, sizeof (h));
        h.target = CM_TARGET;
        h.source = "emulator";
        h.unit = "instructions";
        h.unit_hz = 0; /* instructions are demand, not time */
        h.build = build;
        h.view = screenblocks;
        h.detail = detailLevel;
        h.zone = (unsigned) FS_ZONE_SIZE;
        h.precache = 0;
        h.mode = mode;
        floor_header (&h);
        floor_demo_begin (name, (unsigned) ntics);
        for (i = 0; i < ntics; i++)
            floor_tic ((unsigned) i, t_gametic[i], t_elapsed[i], t_flags[i],
                       t_mbytes[i], mode == 'A', t_sim[i], t_render[i]);
        memset (&a, 0, sizeof (a)); /* no audio in this build yet */
        floor_audio (&a);
        floor_demo_end (name, final_sim, final_render);
        out_close ();

        // the stats file: what the floor log has no field for
        if (!out_open (stats))
            need (NULL, "writable -stats path");
        out_puts ("STATS 1 target=" CM_TARGET " board=" CM_BOARD_NAME
                  " build=");
        out_puts (build);
        out_puts (" desc=" CM_BUILD_DESC " mode=");
        out_putc (mode);
        out_puts (" name=");
        out_puts (name);
        out_puts (" insn_per_tick=");
        out_putu (k);
        out_puts ("\nSTACK init=");
        out_putu (stack_init);
        out_puts (" demo=");
        out_putu (stack_demo);
        out_puts (" region=");
        out_putu ((unsigned) ((char*) _stack_top - (char*) _stack_bottom));
        out_puts ("\nWAD reads=");
        out_putu (cm_wad_reads);
        out_puts ("\nHELPERS");
#ifdef CM_COUNT_HELPERS
        {
            unsigned j;
            for (j = 0; j < cm_nhelpers; j++)
            {
                out_putc (' ');
                out_puts (cm_hnames[j]);
            }
        }
#endif
        out_puts ("\n# S <i> <sim> <frame> <bsp> <planes> <masked> [helper "
                  "calls...]\n");
        for (i = 0; i < ntics; i++)
        {
            int j;
            out_puts ("S ");
            out_putu ((unsigned) i);
            for (j = 0; j < 5; j++)
            {
                out_putc (' ');
                out_putu (t_stage[i][j]);
            }
#ifdef CM_COUNT_HELPERS
            for (j = 0; j < (int) cm_nhelpers; j++)
            {
                out_putc (' ');
                out_putu (t_helper[i][j]);
            }
#endif
            out_putc ('\n');
        }
        out_puts ("END\n");
        out_close ();
    }
    if (stack_init >= (unsigned) ((char*) _stack_top - (char*) _stack_bottom) ||
        stack_demo >= (unsigned) ((char*) _stack_top - (char*) _stack_bottom))
    {
        cm_uart_puts ("FAIL cm-doom: the stack region was exhausted\n");
        sh_exit (6);
    }
    cm_uart_puts ("cm-doom: ");
    cm_uart_dec ((unsigned) ntics);
    cm_uart_puts (" tics, peak stack init ");
    cm_uart_dec (stack_init);
    cm_uart_puts (" B, demo ");
    cm_uart_dec (stack_demo);
    cm_uart_puts (" B\n");
    sh_exit (0);
}
