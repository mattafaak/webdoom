// tools/freestanding/synth-exact.c — the OPL synth against its reference,
// frame by frame.
//
// Links engine/web/opl3.c (the synth every build ships, with the floor's exact
// savings) beside the reference core (opl3-ref-wrap.c: tools/floor/opl3-ref,
// Nuked 1.8 as it was before them), and drives both with the same calls.
// --wrap puts this file between every caller and the five entry points of the
// shipped core (OPL3_Reset, OPL3_WriteReg, OPL3_WriteRegBuffered,
// OPL3_Generate, OPL3_GenerateResampled): each call runs on the shipped chip
// and again on the reference chip, and every frame either produces is compared,
// both channels, as is the noise LFSR's state after it.  There is one chip of
// each.
//
// Two ways to drive them:
//   song   engine/web/mus_opl.c (through fs_mus.c) and synth_main.c, unchanged,
//          brought up as synth.wasm is (synth_boot) and rendered with
//          web_music_render in fs-doom's per-tic blocks: the register streams
//          the game actually writes, and its rate.
//   fuzz   a random register stream from a seed: every register (both banks,
//          holes and junk addresses included), rhythm mode switched on after
//          long stretches off, bank-1 writes arriving after long stretches
//          without them in OPL2 and OPL3 mode, 4-op, NEW toggled, resets at
//          random rates (the chip's own rate and rates whose ratio rounds to
//          it among them), buffered and direct writes, resampled and direct
//          generation.
//
// It reports one line (EXACT ...):
//   frames      generate calls compared (song: output frames)
//   differ      frames on which either channel differed; first_diff, ch, opt
//               and ref locate the first one (-1: none)
//   noise_diff  the first frame after which the LFSR states differed (-1: none)
//   skipped     frames generated with bank 1 unwritten, i.e. skipped
//   rhythm      frames generated in rhythm mode
//   loud        frames the reference made louder than +-64 in either channel
//   wakes_opl2  times bank 1 was first written while NEW=0 (fuzz coverage)
//   rhythm_on   times rhythm mode came on after 1 s or more off
//   resets, writes, l2 (FNV-1a 32 over the shipped core's frames, L R ...)
//
// usage: synth-exact --wad W --song LUMP [--mode 0|1] [--rate HZ] --frames N
//                    [--flip K]
//        synth-exact --fuzz SEED --frames N [--flip K]
//   --flip K   red-proof hook: xor 1 into the shipped core's left sample on
//              frame K before it is compared (it must be reported there)
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "opl3.h"

typedef unsigned char byte;

// opl3-ref-wrap.c: the reference chip
void ref_reset (unsigned rate);
void ref_write (unsigned reg, unsigned v);
void ref_write_buffered (unsigned reg, unsigned v);
void ref_generate (short* buf);
void ref_generate_resampled (short* buf);
unsigned ref_noise (void);

// engine/web/synth_main.c and mus_opl.c, fs_mus.c
void synth_boot (int rate, byte* gm, int gmlen, byte* s, int slen, int looping,
                 int paused, int vol127, int oplmode);
void web_music_render (float* out, int nframes);
int web_music_debug (int what);
void fs_mus_preinit (void);

#define BOOT_VOLUME 67 // synth-bench.c: S_Init's I_SetMusicVolume(8)

static void die (const char* m)
{
    fprintf (stderr, "synth-exact: %s\n", m);
    exit (1);
}

// ── the comparison ───────────────────────────────────────────────────────────
static long long frames, differ, first_diff = -1, noise_diff = -1;
static int diff_ch, diff_opt, diff_ref;
static long long skipped, rhythm, loud, wakes_opl2, rhythm_on, resets, writes;
static long long flip_at = -1;
static long long rhythm_off_since; // frame rhythm mode was last seen off
static int rhythm_was_on;
static unsigned l2 = 0x811c9dc5u;

static unsigned fnv_byte (unsigned h, unsigned b)
{
    return (h ^ (b & 0xff)) * 0x01000193u;
}

// what the frame about to be generated covers
static void tally (const opl3_chip* c)
{
    if (!c->bank1_live)
        skipped++;
    if (c->rhy & 0x20)
    {
        if (!rhythm_was_on && frames - rhythm_off_since >= 49716)
            rhythm_on++;
        rhythm_was_on = 1;
        rhythm++;
    }
    else
    {
        if (rhythm_was_on)
            rhythm_off_since = frames;
        rhythm_was_on = 0;
    }
}

static void compare (const opl3_chip* c, Bit16s* opt, const short* ref)
{
    int k;
    if (frames == flip_at)
        opt[0] ^= 1;
    if (opt[0] != ref[0] || opt[1] != ref[1])
    {
        if (first_diff < 0)
        {
            k = opt[0] != ref[0] ? 0 : 1;
            first_diff = frames;
            diff_ch = k;
            diff_opt = opt[k];
            diff_ref = ref[k];
        }
        differ++;
    }
    if (ref[0] > 64 || ref[0] < -64 || ref[1] > 64 || ref[1] < -64)
        loud++;
    if (noise_diff < 0 && c->noise != ref_noise ())
        noise_diff = frames;
    for (k = 0; k < 2; k++)
    {
        l2 = fnv_byte (l2, (unsigned) opt[k]);
        l2 = fnv_byte (l2, (unsigned) opt[k] >> 8);
    }
    frames++;
}

// ── the five entry points, wrapped ───────────────────────────────────────────
void __real_OPL3_Reset (opl3_chip* chip, Bit32u samplerate);
void __real_OPL3_WriteReg (opl3_chip* chip, Bit16u reg, Bit8u v);
void __real_OPL3_WriteRegBuffered (opl3_chip* chip, Bit16u reg, Bit8u v);
void __real_OPL3_Generate (opl3_chip* chip, Bit16s* buf);
void __real_OPL3_GenerateResampled (opl3_chip* chip, Bit16s* buf);

void __wrap_OPL3_Reset (opl3_chip* chip, Bit32u samplerate)
{
    __real_OPL3_Reset (chip, samplerate);
    ref_reset (samplerate);
    resets++;
}

void __wrap_OPL3_WriteReg (opl3_chip* chip, Bit16u reg, Bit8u v)
{
    __real_OPL3_WriteReg (chip, reg, v);
    ref_write (reg, v);
    writes++;
}

void __wrap_OPL3_WriteRegBuffered (opl3_chip* chip, Bit16u reg, Bit8u v)
{
    __real_OPL3_WriteRegBuffered (chip, reg, v);
    ref_write_buffered (reg, v);
    writes++;
}

// a bank-1 wake in OPL2 mode: the case a skip keyed to NEW would get wrong
static void watch_wake (const opl3_chip* c, int was_live)
{
    if (!was_live && c->bank1_live && !c->newm)
        wakes_opl2++;
}

void __wrap_OPL3_Generate (opl3_chip* chip, Bit16s* buf)
{
    short r[2];
    int was = chip->bank1_live;
    tally (chip);
    __real_OPL3_Generate (chip, buf);
    ref_generate (r);
    watch_wake (chip, was);
    compare (chip, buf, r);
}

void __wrap_OPL3_GenerateResampled (opl3_chip* chip, Bit16s* buf)
{
    short r[2];
    int was = chip->bank1_live;
    tally (chip);
    __real_OPL3_GenerateResampled (chip, buf);
    ref_generate_resampled (r);
    watch_wake (chip, was);
    compare (chip, buf, r);
}

// ── song mode: the WAD in memory, lumps by name (synth-bench.c's reader) ─────
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
        if (dir + 16 * (i + 1) > (unsigned long) wadlen)
            break;
        memcpy (nm, e + 8, 8);
        nm[8] = 0;
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

static void run_song (const char* wadpath, const char* song, int mode, int rate,
                      long long nframes)
{
    byte *gm, *sg, *gmc, *sgc;
    int gmlen, sglen;
    long long done = 0, carry = 0;
    float* fbuf;

    load_wad (wadpath);
    if (!lump ("GENMIDI", &gm, &gmlen))
        die ("no GENMIDI lump");
    if (!lump (song, &sg, &sglen))
        die ("no such song lump");
    // synth_boot keeps (and later frees) both blocks, as synth-bench's
    gmc = malloc ((size_t) gmlen);
    sgc = malloc ((size_t) sglen);
    fbuf = malloc (sizeof (float) * 2 * (size_t) (rate / 35 + 1));
    if (!gmc || !sgc || !fbuf)
        die ("out of memory");
    memcpy (gmc, gm, (size_t) gmlen);
    memcpy (sgc, sg, (size_t) sglen);

    fs_mus_preinit ();
    synth_boot (rate, gmc, gmlen, sgc, sglen, 1, 0, BOOT_VOLUME, mode);
    if (!web_music_debug (0))
        die ("the synth did not accept the song (not a MUS lump?)");
    while (done < nframes)
    {
        int n = (int) ((carry + rate) / 35);
        carry = (carry + rate) % 35;
        if (n > nframes - done)
            n = (int) (nframes - done);
        web_music_render (fbuf, n);
        done += n;
    }
    if (frames != nframes)
        die ("web_music_render did not generate one frame per output frame");
    printf ("EXACT what=song song=%s mode=%s rate=%d events=%d", song,
            mode ? "OPL3" : "OPL2", rate, web_music_debug (1));
}

// ── fuzz mode ────────────────────────────────────────────────────────────────
static unsigned rng;

static unsigned rnd (void)
{
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}

// one in n
static int chance (unsigned n)
{
    return rnd () % n == 0;
}

static unsigned fuzz_rate (void)
{
    static const unsigned rates[] = {49716, 49716, 49716, 44100, 48000,
                                     22050, 32000, 96000, 49740};
    if (chance (8))
        return 8000 + rnd () % 88001;
    return rates[rnd () % (sizeof rates / sizeof rates[0])];
}

// a register.  Rhythm mode (0xbd) and the bank-1 slot and channel registers
// (0x120 and up) are drawn only once their segment has opened them, so each
// segment runs long stretches without either and then switches them on.
static unsigned fuzz_reg (int bank1_open, int rhythm_open)
{
    static const unsigned slotbase[] = {0x20, 0x40, 0x60, 0x80, 0xe0};
    unsigned r = rnd () % 1000, reg;
    if (r < 500)
        reg = slotbase[rnd () % 5] + rnd () % 0x16; // holes 0x06, 0x07, ... too
    else if (r < 720)
        reg = (chance (2) ? 0xa0 : 0xb0) + rnd () % 9; // f-number, block, key
    else if (r < 800)
        reg = 0xc0 + rnd () % 9;
    else if (r < 860)
        reg = rhythm_open ? 0xbd : 0xb0 + rnd () % 9;
    else if (r < 880)
        reg = chance (2) ? 0x08 : 0x01;
    else if (r < 895)
        reg = 0x104; // 4-op pairs
    else if (r < 897)
        reg = 0x105; // NEW, flipped now and then
    else if (r < 907)
    {
        reg = rnd () % 0x200; // any address at all
        if (!bank1_open && reg >= 0x120)
            reg &= 0xff;
    }
    else
        reg = fuzz_reg (bank1_open, rhythm_open) | (bank1_open ? 0x100 : 0);
    return reg;
}

// rhythm mode on most of the time once it is open, with random drums keyed
static unsigned fuzz_val (unsigned reg)
{
    if (reg == 0xbd)
        return chance (4) ? rnd () & 0xdf : 0x20 | (rnd () & 0xdf);
    return rnd () & 0xff;
}

static void run_fuzz (unsigned seed, long long nframes)
{
    static opl3_chip chip;
    long long f = 0;
    int nseg = 0;
    rng = seed * 2654435761u + 0x9e3779b9u;
    if (!rng)
        rng = 1;
    while (f < nframes)
    {
        // one segment: a reset at a random rate, then bank-1 writes and rhythm
        // mode allowed only from random points onwards
        long long len = 50000 + rnd () % 400000, end = f + len;
        long long b1_from = f + rnd () % len, rh_from = f + rnd () % len;
        unsigned rate = fuzz_rate ();
        if (end > nframes)
            end = nframes;
        OPL3_Reset (&chip, rate);
        nseg++;
        if (chance (2))
            OPL3_WriteReg (&chip, 0x105, 0x01); // OPL3 mode for this segment
        if (chance (2))
            OPL3_WriteReg (&chip, 0x01, 0x20);
        for (; f < end; f++)
        {
            Bit16s buf[2];
            if (chance (24))
            {
                int k, n = 1 + rnd () % 4;
                for (k = 0; k < n; k++)
                {
                    unsigned reg = fuzz_reg (f >= b1_from, f >= rh_from);
                    unsigned v = fuzz_val (reg);
                    if (chance (5))
                        OPL3_WriteReg (&chip, (Bit16u) reg, (Bit8u) v);
                    else
                        OPL3_WriteRegBuffered (&chip, (Bit16u) reg, (Bit8u) v);
                }
            }
            if (chance (64))
                OPL3_Generate (&chip, buf);
            else
                OPL3_GenerateResampled (&chip, buf);
        }
    }
    if (frames != nframes)
        die ("the fuzz loop generated a different number of frames");
    printf ("EXACT what=fuzz seed=%u segments=%d", seed, nseg);
}

int main (int argc, char** argv)
{
    const char *wadpath = NULL, *song = NULL;
    int mode = 0, rate = 49716, fuzz = 0, i;
    unsigned seed = 0;
    long long nframes = -1;

    for (i = 1; i < argc; i++)
    {
        const char* a = argv[i];
        const char* v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!strcmp (a, "--wad") && v) wadpath = v, i++;
        else if (!strcmp (a, "--song") && v) song = v, i++;
        else if (!strcmp (a, "--mode") && v) mode = atoi (v), i++;
        else if (!strcmp (a, "--rate") && v) rate = atoi (v), i++;
        else if (!strcmp (a, "--frames") && v) nframes = atoll (v), i++;
        else if (!strcmp (a, "--flip") && v) flip_at = atoll (v), i++;
        else if (!strcmp (a, "--fuzz") && v) fuzz = 1, seed = (unsigned) strtoul (v, NULL, 0), i++;
        else
        {
            fprintf (stderr, "synth-exact: unknown or incomplete argument %s\n", a);
            return 2;
        }
    }
    if (nframes <= 0)
        die ("--frames N (N > 0) is required");
    if (fuzz == !!(wadpath || song))
        die ("usage: synth-exact --wad W --song LUMP [...] | --fuzz SEED (see the source)");
    if (mode != 0 && mode != 1)
        die ("--mode is 0 (OPL2) or 1 (OPL3)");
    if (rate < 8000 || rate > 192000)
        die ("--rate out of range");
    if (fuzz)
        run_fuzz (seed, nframes);
    else
    {
        if (!wadpath || !song)
            die ("song mode needs --wad and --song");
        run_song (wadpath, song, mode, rate, nframes);
    }
    printf (" frames=%lld differ=%lld first_diff=%lld ch=%s opt=%d ref=%d "
            "noise_diff=%lld skipped=%lld rhythm=%lld loud=%lld wakes_opl2=%lld "
            "rhythm_on=%lld resets=%lld writes=%lld l2=%08x\n",
            frames, differ, first_diff, first_diff < 0 ? "-" : diff_ch ? "R" : "L",
            diff_opt, diff_ref, noise_diff, skipped, rhythm, loud, wakes_opl2, rhythm_on,
            resets, writes, l2);
    return 0;
}
