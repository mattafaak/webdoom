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
//           -name DEMO -build ID -stats FILE [-zone KB] [-audio 1]
// -zone hands the engine only the first KB KiB of the zone arena (as fs-doom's
// WD_ZONE_KB does), so one binary can bisect the smallest zone that works.
// -audio 1 runs the sound in every tic, as fs-doom does by default: the OPL
// synth and the 8-channel mixer (tools/freestanding/fs_audio.c), and the
// floor log's AUDIO line is theirs.  Without it (the Makefile's
// FS_AUDIO_DEFAULT=0) the sound is off and the AUDIO line reads 0.
// The AUDIO line's two hashes are the harness's work: fs_audio.c calls
// cm_audio_pause around them (FS_AUDIO_PAUSE), and the timer steps between
// are taken off the tic, as fs-doom pauses its counter.
//
// The play mode (tools/floor/play-set.mjs's runCm, run by
// tools/floor/ram-floor.mjs) is fs-doom's -frames mode on the board:
//   cm-doom ... -frames REC [-exit-at T] [-lmp DEMO] [-audio 1]
//               [-save-at T -load-at T -end-at T]
// every frame recorded in fs-doom's F-line layout (frame, gametic, gamestate,
// wipe, render, sim, six fields fs-doom fills and this leaves 0, episode, map,
// instructions, wiping), wipes run to their end on the wipe clock, a level
// exit at the first frame whose gametic is >= T, DEMO's bytes played as the
// -timedemo lump (wad_semi.c's cm_wad_demo), an L line after every level load
// (what the zone holds), and at the end a MEM line: the peak stack (from the
// top of the stack region, init and play together) and newlib's heap
// high-water.  -audio 1 runs the sound (the OPL synth and the mixer) as fs-doom
// does, as in the floor log mode.  -save-at, -load-at and -end-at are
// fs-doom's WD_SAVE_AT, WD_LOAD_AT and WD_END_AT in slot 0: the game saved
// (an S line: frame, gametic, slot, the save's bytes), kept by files.c in a
// buffer in .big (fs_keep_alloc), loaded back, the run ended.  No floor log
// is written.
//
// The zero-copy build (Makefile ZC=1, CM_ZERO_COPY) reads lumps in place
// (WEB_LUMPS_IN_PLACE): the WAD is put in guest memory before the engine
// starts (wad_semi.c's cm_wad_load) instead of being read through the window.
//
// Units.  qemu runs with -icount shift=0: one guest instruction is 1 ns of
// virtual time.  A tic's instructions are (timer steps) x CM_INSN_PER_TICK, to
// within one step (40 instructions on the an385, 50 on the an505); selftest.c
// is the proof.  With -audio 1 the hashes' span is read with the same timer,
// so such a tic is within two steps.
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
#include "z_zone.h"
#include "d_event.h" /* gameaction */

#include "board.h"
#include "semihost.h"

extern int detailLevel;         /* m_menu.c */
extern int screenblocks;        /* m_menu.c */
unsigned fs_render_hash (void); /* tools/freestanding/i_video.c */
unsigned cm_wad_open (const char* path, const char* present_as);
extern unsigned cm_wad_reads;
#ifdef CM_ZERO_COPY
unsigned cm_wad_load (const char* path, const char* present_as);
extern unsigned cm_wad_image, cm_wad_tail;
#endif
extern int fs_zone_bytes;     /* tools/freestanding/i_system.c */
unsigned cm_heap_peak (void); /* syscalls.c */
void cm_wad_demo (const char* path, const char* lump); /* wad_semi.c */
extern void (*fs_floor_setup_hook) (void);             /* floor_wrap.c */
void G_ExitLevel (void);                               /* g_game.c */
void G_LoadGame (char* name);
extern int savegameslot;
extern char savedescription[32];
extern char** environ;
void G_DoSaveGame (void);
extern void* (*fs_keep_alloc) (size_t n);
extern void (*fs_keep_release) (void* p);
void fs_audio_floor (floor_audio_t* a); /* fs_audio.c: the AUDIO line */

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

// ── the AUDIO line's hashes, charged to no tic ───────────────────────────────
// fs_audio.c hashes every tic's samples for the AUDIO line (synthhash,
// mixhash) between cm_audio_pause (0) and cm_audio_pause (1), the Makefile's
// FS_AUDIO_PAUSE: the timer steps between are added up here and taken off the
// tic (or the play mode's frame) they fell in.  Not called with the sound off.
static unsigned audio_pause_t0, audio_paused;
void cm_audio_pause (int run);
void cm_audio_pause (int run)
{
    if (!run)
        audio_pause_t0 = cm_ticks ();
    else
        audio_paused += cm_ticks () - audio_pause_t0;
}

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

// ── the play mode ────────────────────────────────────────────────────────────
// The zone's own header, as z_zone.c declares it (i_main.c walks it the same
// way, and checks the walk adds up; so does this one).
typedef struct
{
    int size;
    memblock_t blocklist;
    memblock_t* rover;
} cm_memzone_t;
extern cm_memzone_t* mainzone;
static int play_frame;

static void out_kv (const char* k, unsigned v)
{
    out_putc (' ');
    out_puts (k);
    out_putc ('=');
    out_putu (v);
}

// After every level load: L <frame> <episode> <map> static= level= cache=
// free= run= (i_main.c's frames_zone, the same classes)
static void play_level (void)
{
    memblock_t* b;
    unsigned st = 0, lv = 0, ca = 0, fr = 0, run = 0, best = 0, total = 0;
    for (b = mainzone->blocklist.next; b != &mainzone->blocklist; b = b->next)
    {
        if (b->next->prev != b || b->size < (int) sizeof (memblock_t))
            break;
        total += (unsigned) b->size;
        if (!b->user)
            fr += (unsigned) b->size;
        else if (b->tag < PU_LEVEL)
            st += (unsigned) b->size;
        else if (b->tag < PU_PURGELEVEL)
            lv += (unsigned) b->size;
        else
            ca += (unsigned) b->size;
        run = (!b->user || b->tag >= PU_PURGELEVEL) ? run + (unsigned) b->size
                                                    : 0;
        if (run > best)
            best = run;
    }
    if (b != &mainzone->blocklist ||
        total != (unsigned) mainzone->size - sizeof (cm_memzone_t))
    {
        cm_uart_puts ("FAIL cm-doom: the zone walk does not add up\n");
        sh_exit (8);
    }
    out_puts ("L ");
    out_putu ((unsigned) play_frame);
    out_putc (' ');
    out_putu ((unsigned) gameepisode);
    out_putc (' ');
    out_putu ((unsigned) gamemap);
    out_kv ("static", st);
    out_kv ("level", lv);
    out_kv ("cache", ca);
    out_kv ("free", fr);
    out_kv ("run", best);
    out_putc ('\n');
}

// The kept savegames' memory (files.c's fs_keep_alloc): a buffer in .big,
// handed out in order, so a kept save is never newlib's heap (it stands for a
// port's file system); the last block handed out can be taken back
#define KEEP_MAX (256 * 1024) /* the largest save measured: 158,166 B */
static unsigned char keep_buf[KEEP_MAX] BIG (keep);
static unsigned keep_used, keep_last;
static void* keep_alloc (size_t n)
{
    unsigned at = (keep_used + 7u) & ~7u;
    if (n > KEEP_MAX - at)
    {
        cm_uart_puts ("cm-doom: a kept savegame larger than its buffer\n");
        return 0;
    }
    keep_last = at;
    keep_used = at + (unsigned) n;
    return keep_buf + at;
}
static void keep_release (void* p)
{
    if (p && (unsigned char*) p == keep_buf + keep_last)
        keep_used = keep_last;
}

// Every frame, wipe frames included, until the demo's end longjmps out (or
// -end-at does).
static void play_run (int exit_at, int save_at, int load_at, int end_at)
{
    int exited = exit_at < 0, saved = save_at < 0, loaded = load_at < 0;
    unsigned k = CM_INSN_PER_TICK;
    out_puts ("FRAMES zone=");
    out_putu ((unsigned) fs_zone_bytes);
    out_puts (" wipes=1 poison=0 lean_screens=");
#ifdef LEAN_SCREENS
    out_putc ('1');
#else
    out_putc ('0');
#endif
    out_putc ('\n');
    for (;;)
    {
        unsigned t0, t1;
        int wiping;
        if (!exited && gametic >= exit_at && !wipeactive)
        {
            exited = 1;
            G_ExitLevel ();
        }
        // as fs-doom's -frames does (i_main.c: WD_SAVE_AT, WD_LOAD_AT): the
        // save done there and then, the load by the next tic, slot 0
        if (!saved && gametic >= save_at && !wipeactive)
        {
            int len = 0;
            saved = 1;
            savegameslot = 0;
            strcpy (savedescription, "fs-doom");
            G_DoSaveGame ();
            fs_kept_file ("doomsav0.dsg", &len);
            out_puts ("S ");
            out_putu ((unsigned) play_frame);
            out_putc (' ');
            out_putu ((unsigned) gametic);
            out_puts (" 0 ");
            out_putu ((unsigned) len);
            out_puts (" 0\n");
        }
        if (!loaded && gametic >= load_at && !wipeactive)
        {
            loaded = 1;
            G_LoadGame ("doomsav0.dsg");
        }
        if (end_at >= 0 && gametic >= end_at && !wipeactive)
        {
            fs_timedemo_gametics = gametic;
            longjmp (fs_demo_jmp, 1);
        }
        if (wipeactive)
            fs_wipe_clock++;
        wiping = wipeactive ? 1 : 0;
        audio_paused = 0;
        t0 = cm_ticks ();
        D_DoomFrame ();
        t1 = cm_ticks ();
        out_puts ("F ");
        out_putu ((unsigned) play_frame);
        out_putc (' ');
        out_putu ((unsigned) gametic);
        out_putc (' ');
        out_putu ((unsigned) gamestate);
        out_putc (' ');
        out_putu (wipeactive ? 1 : 0);
        out_putc (' ');
        out_putu (fs_render_hash ());
        out_putc (' ');
        out_putu ((unsigned) fs_state_hash ());
        out_puts (" 0 0 0 0 0 0 "); /* fs-doom's held..write hash: unused */
        out_putu ((unsigned) gameepisode);
        out_putc (' ');
        out_putu ((unsigned) gamemap);
        out_putc (' ');
        out_putu ((t1 - t0 - audio_paused) * k);
        out_putc (' ');
        out_putu ((unsigned) wiping);
        out_putc ('\n');
        play_frame++;
    }
}

void cm_start (void)
{
    static char* argv[32];
    int argc = 0;
    char* p;
    const char *wad, *as, *demo, *floor_path, *mode_s, *name, *build, *stats;
    const char* zone_kb;
    const char *play, *exit_at_s, *lmp, *audio, *save_at_s, *load_at_s,
        *end_at_s;
    static char* audio_env[] = {"WD_AUDIO=1", 0};
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
    play = arg (argc, argv, "-frames");
    exit_at_s = arg (argc, argv, "-exit-at");
    lmp = arg (argc, argv, "-lmp");
    audio = arg (argc, argv, "-audio");
    save_at_s = arg (argc, argv, "-save-at");
    load_at_s = arg (argc, argv, "-load-at");
    end_at_s = arg (argc, argv, "-end-at");
    if (!play && (exit_at_s || lmp || save_at_s || load_at_s || end_at_s))
        need (NULL, "-frames (-exit-at, -lmp, -save-at, -load-at and -end-at "
                    "are the play mode's)");
    if (play)
    {
        floor_path = mode_s = name = build = stats = 0;
        mode = 'A';
    }
    else
    {
        need (floor_path = arg (argc, argv, "-floor"), "-floor");
        need (mode_s = arg (argc, argv, "-mode"), "-mode");
        need (name = arg (argc, argv, "-name"), "-name");
        need (build = arg (argc, argv, "-build"), "-build");
        need (stats = arg (argc, argv, "-stats"), "-stats");
        // exactly A or B: a typo must not quietly run the other mode
        if ((mode_s[0] != 'A' && mode_s[0] != 'B') || mode_s[1])
            need (NULL, "-mode A or -mode B");
        mode = mode_s[0];
    }
    // -audio 1: the sound on, through the environment fs_audio.c reads (a
    // static one: no heap)
    if (audio && !strcmp (audio, "1"))
        environ = audio_env;
    else if (audio)
        need (NULL, "-audio 1");
    zone_kb = arg (argc, argv, "-zone");
    if (zone_kb)
    {
        int kb = atoi (zone_kb);
        if (kb <= 0 || (long) kb * 1024 > (long) FS_ZONE_SIZE)
        {
            cm_uart_puts ("FAIL cm-doom: -zone ");
            cm_uart_puts (zone_kb);
            cm_uart_puts (" is not inside the arena (Makefile ZONE_KB)\n");
            sh_exit (2);
        }
        fs_zone_bytes = kb * 1024;
    }

    cm_uart_puts ("cm-doom: " CM_TARGET " on " CM_BOARD_NAME ", ");
    cm_uart_puts (play ? "play mode" : name);
    cm_uart_puts (" mode ");
    cm_uart_putc (mode);
    cm_uart_puts ("\n");

#ifdef CM_ZERO_COPY
    cm_wad_load (wad, as);
#else
    cm_wad_open (wad, as);
#endif
    if (lmp)
        cm_wad_demo (lmp, demo);
    if (play)
    {
        if (!out_open (play))
            need (NULL, "writable -frames path");
        fs_wipe_clock = 0; /* the wipes run, on the wipe clock */
        fs_floor_setup_hook = play_level;
        fs_keep_alloc = keep_alloc;
        fs_keep_release = keep_release;
    }

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
    if (play)
        play_run (exit_at_s ? atoi (exit_at_s) : -1,
                  save_at_s ? atoi (save_at_s) : -1,
                  load_at_s ? atoi (load_at_s) : -1,
                  end_at_s ? atoi (end_at_s) : -1);

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
    audio_paused = 0;
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
                t_elapsed[n] = (now - last - audio_paused) * k;
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
            audio_paused = 0;
            last = cm_ticks ();
        }
    }

done:
    fs_timedemo_active = 0;
    stack_demo = cm_stack_peak ();
    if (play)
    {
        out_puts ("MEM stack_peak=");
        out_putu (stack_init > stack_demo ? stack_init : stack_demo);
        out_kv ("stack_init", stack_init);
        out_kv ("stack_play", stack_demo);
        out_kv ("heap_peak", cm_heap_peak ());
        out_kv ("zone", (unsigned) fs_zone_bytes);
        out_kv ("region",
                (unsigned) ((char*) _stack_top - (char*) _stack_bottom));
        out_puts ("\nEND frames=");
        out_putu ((unsigned) play_frame);
        out_puts (" gametics=");
        out_putu ((unsigned) fs_timedemo_gametics);
        out_putc ('\n');
        out_close ();
        if (stack_init >=
                (unsigned) ((char*) _stack_top - (char*) _stack_bottom) ||
            stack_demo >=
                (unsigned) ((char*) _stack_top - (char*) _stack_bottom))
        {
            cm_uart_puts ("FAIL cm-doom: the stack region was exhausted\n");
            sh_exit (6);
        }
        cm_uart_puts ("cm-doom: play mode, ");
        cm_uart_dec ((unsigned) play_frame);
        cm_uart_puts (" frames\n");
        sh_exit (0);
    }
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
        h.zone = (unsigned) fs_zone_bytes;
        h.precache = 0;
        h.mode = mode;
        floor_header (&h);
        floor_demo_begin (name, (unsigned) ntics);
        for (i = 0; i < ntics; i++)
            floor_tic ((unsigned) i, t_gametic[i], t_elapsed[i], t_flags[i],
                       t_mbytes[i], mode == 'A', t_sim[i], t_render[i]);
        fs_audio_floor (&a); /* all 0 unless -audio 1 */
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
#ifdef CM_ZERO_COPY
        out_puts (" in_place=1 image=");
        out_putu (cm_wad_image);
        out_puts (" tail=");
        out_putu (cm_wad_tail);
#else
        out_puts (" in_place=0");
#endif
        out_puts ("\nMEM zone=");
        out_putu ((unsigned) fs_zone_bytes);
        out_puts (" heap_peak=");
        out_putu (cm_heap_peak ());
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
