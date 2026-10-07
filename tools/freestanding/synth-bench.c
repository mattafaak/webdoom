// tools/freestanding/synth-bench.c — the OPL music synth, native, measured.
//
// Links engine/web/mus_opl.c (through fs_mus.c, unchanged), engine/web/opl3.c
// and engine/web/synth_main.c, all unchanged, and drives them through the
// entry points build/synth.wasm exports: synth_boot, then web_music_render in
// blocks.  So one song, one rate and one OPL mode render here exactly what the
// AudioWorklet's synth renders, and tools/synth-native-test.mjs holds the two
// to it byte for byte.
//
// What it reports, on one line (SYNTH ...):
//   frames      output frames rendered (stereo pairs)
//   l2          FNV-1a 32 over the output as little-endian int16, L R L R ...
//               (web_music_render's f32 times 16384, which is exact)
//   writes, l1  the OPL register stream, in --regs mode: one record per write
//               the sequencer issues, [frame u32][reg u16][value u8] little
//               endian, FNV-1a 32 over the records.  frame = the output frame
//               being rendered when the write was issued (0 before the first).
//               It opens with synth_boot's: each of its two mus_init calls
//               resets the chip (OPL3_Reset) and writes 0x001 = 0x20, plus
//               0x105 = 0x01 in OPL3 mode.  --regs FILE (or -) lists them as
//               "frame reg value" in hex.
//   events      MUS events the sequencer ran (web_music_debug(1))
//   instr       user-space x86 instructions in web_music_render (--count): the
//               sum over blocks, each read straight around its render call, so
//               this harness's hashing is not in it; per_s (per second of
//               audio), per_tic (per 1/35 s) and the worst block
//
// usage: synth-bench --wad W --song LUMP [--mode 0|1] [--rate HZ]
//                    [--frames N | --tics N] [--block N] [--regs [FILE]]
//                    [--raw FILE] [--count] [--profile FILE] [--clock]
//                    [--perturb-reg K] [--perturb-sample K] [--x87-pc53]
//   --tics N     render the samples N tics of a demo carry: the per-tic block
//                pattern fs-doom uses (rate/35 frames, the remainder carried),
//                and floor(N * rate / 35) frames in all.  The default block.
//   --block N    a fixed block size instead (1 in --regs and --clock mode)
//   --count      count instructions; refuses to report a block that read 0
//                (on a hybrid CPU only the P-cores count: pin with taskset)
//   --profile F  sample the instruction pointer every 100,003 instructions and
//                write "ip count" lines to F (tools/freestanding/synth-profile.py
//                names them); the binary is linked -no-pie for that
//   --clock      check the sequencer's double-precision clock against exact
//                integer arithmetic: prints the first frame at which an event
//                group fires on a different frame than ceil(rate*W/140)-1
//   --perturb-*  red-proof hooks: xor 0xff into the value of register write
//                number K, or 1 into frame K's left sample
//   --x87-pc53   set the x87 precision control to 53 bits first (for the
//                synth-bench-x87 build: see "THE CLOCK IS IEEE DOUBLE" below)
//
// THE CLOCK IS IEEE DOUBLE
// ------------------------
// mus_opl.c's sequencer clock is a double (tick_accum, samples_per_tick =
// rate / 140.0).  At 49,716 Hz samples_per_tick is inexact, and wherever an
// event group is due on an exact frame boundary (rate * W / 140 an integer,
// i.e. W a multiple of 35 MUS ticks) the sum lands one rounding error away
// from 0 and its sign picks the frame.  wasm's f64 is IEEE double; gcc -m32's
// default x87 code keeps 64-bit mantissas and lands on the other side: D_STLKS2
// (doom2-demo1) then fires a group at frame 37,286 where synth.wasm fires it at
// 37,287 (measured), and every sample after differs.  So the synth's objects
// are built -msse2 -mfpmath=sse, which is IEEE double; synth-bench-x87 is the
// default-x87 build, kept to show the trap and that a 53-bit precision control
// word removes it.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <errno.h>
#include <fcntl.h>
#include <linux/perf_event.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#include "opl3.h"

typedef unsigned char byte;

// engine/web/synth_main.c and mus_opl.c
void synth_boot (int rate, byte* gm, int gmlen, byte* s, int slen, int looping,
                 int paused, int vol127, int oplmode);
void web_music_render (float* out, int nframes);
int web_music_debug (int what);
void fs_mus_preinit (void); // fs_mus.c

// The volume the engine's S_Init leaves: I_SetMusicVolume(snd_MusicVolume=8)
// -> 8 * 127 / 15 (engine/web/i_sound.c), the value synth_boot is handed.
#define BOOT_VOLUME 67

static void die (const char* m)
{
    fprintf (stderr, "synth-bench: %s\n", m);
    exit (1);
}

// ── the WAD: whole file in memory, lumps by name ─────────────────────────────
static byte* wad;
static long wadlen;

static unsigned rd32 (const byte* p)
{
    return p[0] | (p[1] << 8) | (p[2] << 16) | ((unsigned) p[3] << 24);
}

static int lump (const char* name, byte** data, int* len)
{
    unsigned n, dir, i;
    if (wadlen < 12)
        return 0;
    n = rd32 (wad + 4);
    dir = rd32 (wad + 8);
    for (i = 0; i < n; i++)
    {
        const byte* e = wad + dir + 16 * i;
        char nm[9];
        memcpy (nm, e + 8, 8);
        nm[8] = 0;
        if (dir + 16 * (i + 1) > (unsigned long) wadlen)
            break;
        if (!strcasecmp (nm, name))
        {
            unsigned pos = rd32 (e), sz = rd32 (e + 4);
            if (pos + sz > (unsigned long) wadlen)
                die ("lump runs past the end of the WAD");
            *data = wad + pos;
            *len = (int) sz;
            return 1;
        }
    }
    return 0;
}

static void load_wad (const char* path)
{
    FILE* f = fopen (path, "rb");
    if (!f)
        die ("cannot open the WAD");
    fseek (f, 0, SEEK_END);
    wadlen = ftell (f);
    fseek (f, 0, SEEK_SET);
    wad = malloc ((size_t) wadlen);
    if (!wad || fread (wad, 1, (size_t) wadlen, f) != (size_t) wadlen)
        die ("cannot read the WAD");
    fclose (f);
}

// ── FNV-1a 32 ────────────────────────────────────────────────────────────────
static unsigned fnv_byte (unsigned h, unsigned b)
{
    return (h ^ (b & 0xff)) * 0x01000193u;
}

// ── the register-stream tap (--wrap=OPL3_WriteRegBuffered) ────────────────────
// mus_opl.c's opl_write is the sequencer's one door to the chip; the link
// redirects its calls here and this forwards every one.
static int tap_on;
static FILE* tap_file;
static unsigned tap_frame; // the frame being rendered (block size 1)
static unsigned tap_writes;
static unsigned tap_hash = 0x811c9dc5u;
static long tap_perturb = -1; // write number to corrupt
static long tap_perturb_frame = -1; // the frame it was issued in

void __real_OPL3_WriteRegBuffered (opl3_chip* chip, Bit16u reg, Bit8u v);
void __wrap_OPL3_WriteRegBuffered (opl3_chip* chip, Bit16u reg, Bit8u v)
{
    if (tap_on)
    {
        unsigned f = tap_frame, i;
        if ((long) tap_writes == tap_perturb)
        {
            v ^= 0xff;
            tap_perturb_frame = (long) f;
        }
        for (i = 0; i < 4; i++)
            tap_hash = fnv_byte (tap_hash, f >> (8 * i));
        tap_hash = fnv_byte (tap_hash, reg);
        tap_hash = fnv_byte (tap_hash, reg >> 8);
        tap_hash = fnv_byte (tap_hash, v);
        if (tap_file)
            fprintf (tap_file, "%u %03x %02x\n", f, reg, v);
        tap_writes++;
    }
    __real_OPL3_WriteRegBuffered (chip, reg, v);
}

// ── instruction counting, as tools/freestanding/i_main.c does it ─────────────
static int perf_open (int sample_period)
{
    struct perf_event_attr pe;
    memset (&pe, 0, sizeof (pe));
    pe.type = PERF_TYPE_HARDWARE;
    pe.size = 0; // the kernel default; needed for -m32 (i_main.c)
    pe.config = PERF_COUNT_HW_INSTRUCTIONS;
    pe.disabled = 1;
    pe.exclude_kernel = 1;
    pe.exclude_hv = 1;
    if (sample_period)
    {
        pe.sample_period = (unsigned) sample_period;
        pe.sample_type = PERF_SAMPLE_IP;
    }
    return (int) syscall (__NR_perf_event_open, &pe, (pid_t) 0, -1, -1, 0UL);
}

static long long perf_read (int fd)
{
    long long v = 0;
    if (read (fd, &v, sizeof (v)) != (ssize_t) sizeof (v))
        die ("reading the instruction counter failed");
    return v;
}

// ── the sampling profile (--profile) ─────────────────────────────────────────
#define PROF_PAGES 256 // data pages, a power of two
#define PROF_SLOTS (1 << 16)
static struct perf_event_mmap_page* prof_page;
static long prof_pagesz;
static unsigned prof_ip[PROF_SLOTS];
static unsigned prof_n[PROF_SLOTS];
static unsigned long long prof_lost, prof_samples;

static void prof_add (unsigned ip)
{
    unsigned h = (ip * 2654435761u) >> 16;
    while (prof_n[h] && prof_ip[h] != ip)
        h = (h + 1) & (PROF_SLOTS - 1);
    prof_ip[h] = ip;
    prof_n[h]++;
    prof_samples++;
}

static void prof_drain (void)
{
    unsigned long long head = prof_page->data_head, tail = prof_page->data_tail;
    const byte* data = (const byte*) prof_page + prof_pagesz;
    unsigned long long size = (unsigned long long) PROF_PAGES * prof_pagesz;
    __sync_synchronize ();
    while (tail < head)
    {
        struct perf_event_header hd;
        unsigned long long off = tail % size, ip = 0;
        unsigned k;
        for (k = 0; k < sizeof hd; k++)
            ((byte*) &hd)[k] = data[(off + k) % size];
        if (hd.type == PERF_RECORD_SAMPLE)
        {
            for (k = 0; k < 8; k++)
                ((byte*) &ip)[k] = data[(off + sizeof hd + k) % size];
            prof_add ((unsigned) ip);
        }
        else if (hd.type == PERF_RECORD_LOST)
            prof_lost++;
        if (!hd.size)
            die ("profile ring buffer: a zero-length record");
        tail += hd.size;
    }
    __sync_synchronize ();
    prof_page->data_tail = head;
}

// ── --clock: the sequencer's double clock against exact integer arithmetic ───
// mus_opl.c steps tick_accum -= 1.0 per frame and fires event groups while it
// is <= 0, adding wait * (rate / 140.0).  Exactly, group k (W_k MUS ticks into
// the score) fires on frame ceil(rate * W_k / 140) - 1.  The two can only
// disagree where rate * W_k / 140 is an integer, where the double sum lands a
// rounding error away from 0 and its sign decides the frame.  This walks the
// score the way run_event_group does (looping restarts with wait 1) to get
// each group's W_k and event count, and compares the frame on which the real
// synth's event counter moved.
typedef struct
{
    const byte* p;
    const byte* start;
    const byte* end;
} musrd_t;

// one event group: returns its delay (ticks), -1 at the score's end; *events
// gets the events it ran (as dbg_events counts them)
static int mus_group (musrd_t* r, int* events)
{
    int b, type, n = 0;
#define NEXT() (r->p < r->end ? *r->p++ : (r->p++, 0))
    for (;;)
    {
        if (r->p >= r->end)
        {
            *events = n;
            return -1;
        }
        b = NEXT ();
        type = (b >> 4) & 7;
        n++;
        switch (type)
        {
        case 0: case 2: case 3: case 5: case 7:
            (void) NEXT ();
            break;
        case 1:
            if (NEXT () & 0x80)
                (void) NEXT ();
            break;
        case 4:
            (void) NEXT ();
            (void) NEXT ();
            break;
        case 6:
            *events = n;
            return -1;
        }
        if (r->p > r->end)
        {
            *events = n;
            return -1;
        }
        if (b & 0x80)
        {
            int d = 0, k = 0;
            do
            {
                if (r->p >= r->end || ++k > 4)
                {
                    *events = n;
                    return -1;
                }
                b = NEXT ();
                d = (d << 7) | (b & 0x7f);
            } while (b & 0x80);
            *events = n;
            return d;
        }
    }
#undef NEXT
}

// ── main ─────────────────────────────────────────────────────────────────────
int main (int argc, char** argv)
{
    const char *wadpath = NULL, *song = NULL, *raw = NULL, *profpath = NULL;
    const char* regs = NULL;
    int mode = 0, rate = 49716, block = 0, count = 0, clock = 0, want_regs = 0;
    int x87_pc53 = 0;
    long long frames = -1, tics = -1;
    long perturb_sample = -1;
    byte *gm, *sg, *gmc, *sgc;
    int gmlen, sglen, i;
    float* fbuf;
    FILE* rawf = NULL;
    int fd = -1;
    long long done = 0, carry = 0, blocks = 0;
    long long tprev = 0, sum = 0, worst = 0, worst_at = -1, zero_blocks = 0;
    unsigned l2 = 0x811c9dc5u;
    int events0;
    // --clock state
    musrd_t mr = {0, 0, 0};
    long long W = 0;
    int clk_events_pending = 0, clk_first_bad = -1, clk_groups = 0, clk_on_int = 0;
    long long clk_fire = 0;

    for (i = 1; i < argc; i++)
    {
        const char* a = argv[i];
        const char* v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!strcmp (a, "--wad") && v) wadpath = v, i++;
        else if (!strcmp (a, "--song") && v) song = v, i++;
        else if (!strcmp (a, "--mode") && v) mode = atoi (v), i++;
        else if (!strcmp (a, "--rate") && v) rate = atoi (v), i++;
        else if (!strcmp (a, "--frames") && v) frames = atoll (v), i++;
        else if (!strcmp (a, "--tics") && v) tics = atoll (v), i++;
        else if (!strcmp (a, "--block") && v) block = atoi (v), i++;
        else if (!strcmp (a, "--raw") && v) raw = v, i++;
        else if (!strcmp (a, "--profile") && v) profpath = v, i++;
        else if (!strcmp (a, "--perturb-reg") && v) tap_perturb = atol (v), i++;
        else if (!strcmp (a, "--perturb-sample") && v) perturb_sample = atol (v), i++;
        else if (!strcmp (a, "--count")) count = 1;
        else if (!strcmp (a, "--x87-pc53")) x87_pc53 = 1;
        else if (!strcmp (a, "--clock")) clock = 1;
        else if (!strcmp (a, "--regs"))
        {
            want_regs = 1;
            if (v && (v[0] != '-' || !strcmp (v, "-")))
                regs = v, i++;
        }
        else
        {
            fprintf (stderr, "synth-bench: unknown or incomplete argument %s\n", a);
            return 2;
        }
    }
    if (!wadpath || !song)
        die ("usage: synth-bench --wad W --song LUMP [options] (see the source)");
    if (mode != 0 && mode != 1)
        die ("--mode is 0 (OPL2) or 1 (OPL3)");
    if (rate < 8000 || rate > 192000)
        die ("--rate out of range");
    if ((frames < 0) == (tics < 0))
        die ("give exactly one of --frames N and --tics N");
    if (tics >= 0)
        frames = tics * rate / 35;
    if (want_regs || clock || tap_perturb >= 0)
    {
        if (block > 1 || count || profpath)
            die ("--regs, --clock and --perturb-reg render one frame per call: "
                 "no --block, --count or --profile with them");
        block = 1;
    }

#if defined(__i386__) || defined(__x86_64__)
    if (x87_pc53)
    {
        // x87 precision control to 53 bits: every x87 add, multiply and
        // divide then rounds to a double's mantissa, as IEEE double (and wasm)
        // does.  Only meaningful in the -mfpmath=387 build (synth-bench-x87).
        unsigned short cw;
        __asm__ volatile ("fnstcw %0" : "=m"(cw));
        cw = (unsigned short) ((cw & ~0x300u) | 0x200u);
        __asm__ volatile ("fldcw %0" : : "m"(cw));
    }
#else
    if (x87_pc53)
        die ("--x87-pc53 is an x86 option");
#endif
    load_wad (wadpath);
    if (!lump ("GENMIDI", &gm, &gmlen))
        die ("no GENMIDI lump");
    if (!lump (song, &sg, &sglen))
        die ("no such song lump");
    // synth_boot keeps (and later frees) both blocks, as the worklet's are
    gmc = malloc ((size_t) gmlen);
    sgc = malloc ((size_t) sglen);
    if (!gmc || !sgc)
        die ("out of memory");
    memcpy (gmc, gm, (size_t) gmlen);
    memcpy (sgc, sg, (size_t) sglen);

    if (regs && strcmp (regs, "-"))
    {
        tap_file = fopen (regs, "w");
        if (!tap_file)
            die ("cannot write the register stream file");
    }
    else if (regs)
        tap_file = stdout;
    if (raw)
    {
        rawf = fopen (raw, "wb");
        if (!rawf)
            die ("cannot write the raw output file");
    }

    tap_on = want_regs || tap_perturb >= 0;
    tap_frame = 0;
    fs_mus_preinit ();
    synth_boot (rate, gmc, gmlen, sgc, sglen, 1, 0, BOOT_VOLUME, mode);
    if (!web_music_debug (0))
        die ("the synth did not accept the song (not a MUS lump?)");
    events0 = web_music_debug (1);

    if (clock)
    {
        unsigned scorelen = sg[4] | (sg[5] << 8), scorestart = sg[6] | (sg[7] << 8);
        mr.start = mr.p = sg + scorestart;
        mr.end = mr.start + scorelen;
        W = 0;
        clk_fire = 0; // group 0 fires on frame 0
    }

    fbuf = malloc (sizeof (float) * 2 * (size_t) (block ? block : rate / 35 + 1));
    if (!fbuf)
        die ("out of memory");

    if (count || profpath)
    {
        fd = perf_open (profpath ? 100003 : 0);
        if (fd < 0)
        {
            fprintf (stderr, "synth-bench: perf_event_open failed (errno %d); "
                             "perf_event_paranoid must be <= 2\n", errno);
            return 1;
        }
        if (profpath)
        {
            prof_pagesz = sysconf (_SC_PAGESIZE);
            prof_page = mmap (NULL, (size_t) (PROF_PAGES + 1) * prof_pagesz,
                              PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
            if (prof_page == MAP_FAILED)
                die ("cannot map the profile ring buffer");
        }
        ioctl (fd, PERF_EVENT_IOC_RESET, 0);
        ioctl (fd, PERF_EVENT_IOC_ENABLE, 0);
        tprev = perf_read (fd);
    }

    while (done < frames)
    {
        int n, k;
        if (block)
            n = block;
        else
        {
            n = (int) ((carry + rate) / 35);
            carry = (carry + rate) % 35;
        }
        if (n > frames - done)
            n = (int) (frames - done);
        if (clock)
        {
            int before = web_music_debug (1);
            web_music_render (fbuf, n);
            k = web_music_debug (1) - before;
            if (k)
            {
                // the real synth ran groups this frame: as many as the walk
                // says fire on it, and they must be due exactly now
                while (k > 0)
                {
                    int ev = 0, d;
                    if (clk_events_pending == 0)
                    {
                        // the next group due: is it due on this frame?  A
                        // group that ran no event (a score that ends without
                        // its end marker) moves no counter, so it is walked
                        // past unchecked and the group after it is checked.
                        do
                        {
                            long long due = clk_fire;
                            d = mus_group (&mr, &ev);
                            clk_groups++;
                            if (d < 0)
                            {
                                mr.p = mr.start;
                                d = 1;
                            }
                            if (ev > 0 && due != done && clk_first_bad < 0)
                                clk_first_bad = (int) done;
                            W += d;
                            // exact: the first frame f with f + 1 >= rate * W / 140
                            clk_fire = ((long long) rate * W + 139) / 140 - 1;
                            if ((long long) rate * W % 140 == 0)
                                clk_on_int++;
                        } while (ev == 0);
                        clk_events_pending = ev;
                    }
                    if (k >= clk_events_pending)
                    {
                        k -= clk_events_pending;
                        clk_events_pending = 0;
                    }
                    else
                    {
                        clk_events_pending -= k;
                        k = 0;
                    }
                }
            }
        }
        else
            web_music_render (fbuf, n);
        // The block's count is read straight after the render: the hashing
        // below, and a profile's drain, are this harness's work and are
        // charged to no block (tprev is re-read once they are done).
        if (fd >= 0)
        {
            long long now = perf_read (fd), d = now - tprev;
            if (d <= 0)
                zero_blocks++;
            if (d > worst)
                worst = d, worst_at = blocks;
            sum += d;
            if (profpath)
                prof_drain ();
        }
        for (k = 0; k < 2 * n; k++)
        {
            int s = (int) (fbuf[k] * 16384.0f);
            if (perturb_sample >= 0 && done + k / 2 == perturb_sample && !(k & 1))
                s ^= 1;
            l2 = fnv_byte (l2, (unsigned) s);
            l2 = fnv_byte (l2, (unsigned) s >> 8);
            if (rawf)
            {
                short v = (short) s;
                fwrite (&v, 2, 1, rawf);
            }
        }
        done += n;
        blocks++;
        tap_frame = (unsigned) done;
        if (fd >= 0)
            tprev = perf_read (fd);
    }

    printf ("SYNTH song=%s mode=%s rate=%d frames=%lld blocks=%lld l2=%08x events=%d",
            song, mode ? "OPL3" : "OPL2", rate, frames, blocks, l2,
            web_music_debug (1) - events0);
    if (tap_on)
        printf (" writes=%u l1=%08x", tap_writes, tap_hash);
    if (tap_perturb >= 0)
        printf (" perturbed_frame=%ld", tap_perturb_frame);
    if (fd >= 0)
    {
        long long total;
        ioctl (fd, PERF_EVENT_IOC_DISABLE, 0);
        total = sum;
        if (profpath)
            total = -1; // a sampled run pays for its interrupts: not a count
        if (count)
        {
            double secs = (double) frames / rate;
            if (total <= 0 || zero_blocks)
            {
                printf ("\n");
                fprintf (stderr, "synth-bench: FAIL the instruction counter read 0 "
                                 "(%lld of %lld blocks): on a hybrid CPU pin to a "
                                 "P-core (taskset -c <cpu in /sys/devices/cpu_core/cpus>)\n",
                         zero_blocks, blocks);
                return 1;
            }
            printf (" instr=%lld per_s=%.0f per_tic=%.0f worst_block=%lld worst_at=%lld",
                    total, total / secs, total / secs / 35.0, worst, worst_at);
        }
    }
    if (clock)
        printf (" clock_groups=%d clock_on_integer=%d clock_first_diff=%d",
                clk_groups, clk_on_int, clk_first_bad);
    printf ("\n");

    if (profpath)
    {
        FILE* pf = fopen (profpath, "w");
        if (!pf)
            die ("cannot write the profile");
        fprintf (pf, "# samples=%llu lost=%llu period=100003\n", prof_samples, prof_lost);
        for (i = 0; i < PROF_SLOTS; i++)
            if (prof_n[i])
                fprintf (pf, "%08x %u\n", prof_ip[i], prof_n[i]);
        fclose (pf);
    }
    if (rawf)
        fclose (rawf);
    if (tap_file && tap_file != stdout)
        fclose (tap_file);
    return 0;
}
