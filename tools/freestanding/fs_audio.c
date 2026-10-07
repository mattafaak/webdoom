// tools/freestanding/fs_audio.c — the freestanding platform's audio, run
// inside the tic so the floor's timed tics carry it.
//
// Every tic I_UpdateSound renders 1/35 s at 49,716 Hz, the OPL chip's own
// rate: 1,420 or 1,421 frames, the remainder of 49,716 / 35 carried, so
// N tics are exactly floor(N * 49716 / 35) frames.  Per tic:
//   music  web_music_render (engine/web/mus_opl.c + opl3.c, unchanged), its
//          f32 output times 16384 back to the chip's int16 (exact);
//   sfx    sfx_mix_render, 8 channels (sfx_mix.c);
//   out    music + sfx, clamped to int16, into fs_audio_dac[]: the buffer a
//          port hands its DAC.
// All of that is the platform's work and is counted.  The two hashes are this
// harness's: when fs-doom counts instructions (WD_CYCLES=1) the counter is
// paused around them, so a tic's count is the audio a target would run.
//
// The AUDIO line (tools/floor/floor_log.h):
//   samples       frames rendered (one frame = one L and one R sample)
//   underruns     0: the host renders synchronously, it cannot underrun
//   music_events  MUS events the sequencer ran (web_music_debug(1))
//   sfx_starts    I_StartSound calls that started a channel
//   synthhash     FNV-1a 32 over the music as little-endian int16, L R L R:
//                 the samples tools/floor/synth-ref.json's l2 pins
//   mixhash       the same over the sound-effect mix alone, before the music
//                 is added, so a port playing music another way (an OPL chip)
//                 can still prove its mixer
//   frames        tics rendered (audio blocks)
//
// WD_AUDIO=0 turns all of it off: the I_ functions behave as the old stubs,
// s_sound keeps its 3 channels, and the AUDIO line reads 0.
// WD_AUDIO_TRACE=<file> writes the demo's sound events there after the demo
// (with -floor): every sfx start and music call, with its tic.
// WD_AUDIO_STAGES=1 (with WD_CYCLES=1) reads the counter between the music,
// the mixer and the sum in every tic and prints what each cost, per tic, to
// stderr after the demo (the reads themselves are counted: not for a graded
// run).
// The trace and stage buffers are the harness's (720,896 + 212,992 B of
// .bss); a port that does not measure itself builds with -DFS_AUDIO_HARNESS=0
// and they shrink to one entry each, WD_AUDIO_TRACE and WD_AUDIO_STAGES then
// recording nothing (tools/pico's link check does; tools/floor/ram-floor.mjs
// leaves them out of the RAM floor either way).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef __linux__
#include <linux/perf_event.h>
#include <sys/ioctl.h>
#include <unistd.h>
#endif

#include "doomdef.h"
#include "doomstat.h"
#include "fs_audio.h"
#include "sfx_mix.h"
#include "sounds.h"
#include "web.h"

void web_music_render (float* out, int nframes); // mus_opl.c
int web_music_debug (int what);                  // mus_opl.c
extern int fs_perf_instr_fd;                     // perf.c (-1: not counting)

#define BLOCK_MAX (FS_AUDIO_RATE / 35 + 1)
#define FNV0 0x811c9dc5u

static int on;
static int audio_tic; // the gametic audio has been rendered up to
static unsigned carry;
static float mus_f[2 * BLOCK_MAX];
static short mus_s[2 * BLOCK_MAX];
static short sfx_s[2 * BLOCK_MAX];
short fs_audio_dac[2 * BLOCK_MAX]; // the last tic's output, music + sfx

static unsigned long long samples;
static unsigned blocks, sfx_starts;
static unsigned synthhash = FNV0, mixhash = FNV0, sfxhash = FNV0;

// ── the event trace (WD_AUDIO_TRACE) ─────────────────────────────────────────
#ifndef FS_AUDIO_HARNESS
#define FS_AUDIO_HARNESS 1
#endif
#define TRACE_MAX (FS_AUDIO_HARNESS ? 16384 : 1)
typedef struct
{
    int tic, id, vol, sep, pitch, handle;
    char what[10];
    char name[9];
} trace_t;
static trace_t trace[TRACE_MAX];
static int ntrace, trace_lost;
static const char* trace_path;

static trace_t* trace_add (const char* what)
{
    trace_t* t;
    if (!trace_path)
        return 0;
    if (ntrace == TRACE_MAX)
    {
        trace_lost++;
        return 0;
    }
    t = &trace[ntrace++];
    memset (t, 0, sizeof (*t));
    t->tic = gametic;
    strncpy (t->what, what, sizeof (t->what) - 1);
    return t;
}

static unsigned fnv (unsigned h, unsigned v, int bytes)
{
    while (bytes--)
    {
        h = (h ^ (v & 0xff)) * 0x01000193u;
        v >>= 8;
    }
    return h;
}

// ── WD_AUDIO_STAGES: what each part of a tic's audio cost ─────────────────────
#define STAGE_MAX (FS_AUDIO_HARNESS ? 16384 : 1)
static int stages;
static unsigned st_mus[STAGE_MAX], st_sfx[STAGE_MAX], st_sum[STAGE_MAX];
static unsigned char st_live[STAGE_MAX];
static int nstage;

static long long rd (void)
{
    long long v = 0;
#ifdef __linux__
    if (read (fs_perf_instr_fd, &v, sizeof (v)) != (ssize_t) sizeof (v))
        v = 0;
#endif
    return v;
}

// ── the instruction counter, paused around the harness's own work ────────────
static void count (int run)
{
#ifdef __linux__
    if (fs_perf_instr_fd >= 0)
        ioctl (fs_perf_instr_fd, run ? PERF_EVENT_IOC_ENABLE : PERF_EVENT_IOC_DISABLE, 0);
#else
    (void) run;
#endif
}

int fs_audio_on (void)
{
    return on;
}

// A port with no environment, or one where audio would swamp what is being
// measured (qemu: the synth costs more than the game), builds with
// -DFS_AUDIO_DEFAULT=0; WD_AUDIO still decides where it is set.
#ifndef FS_AUDIO_DEFAULT
#define FS_AUDIO_DEFAULT 1
#endif

void fs_audio_init (void)
{
    const char* e = getenv ("WD_AUDIO");
    on = e ? e[0] != '0' : FS_AUDIO_DEFAULT;
    trace_path = on ? getenv ("WD_AUDIO_TRACE") : 0;
    if (!on)
        return;
    sfx_mix_init (FS_AUDIO_RATE);
    audio_tic = gametic;
    e = getenv ("WD_AUDIO_STAGES");
    stages = e && e[0] == '1';
}

static void render_tic (void)
{
    int n, k, st = stages && fs_perf_instr_fd >= 0 && nstage < STAGE_MAX;
    long long t0 = 0, t1 = 0, t2 = 0;
    carry += FS_AUDIO_RATE;
    n = (int) (carry / 35);
    carry %= 35;

    if (st)
    {
        st_live[nstage] = (unsigned char) sfx_mix_live ();
        t0 = rd ();
    }
    web_music_render (mus_f, n);
    if (st)
        t1 = rd ();
    sfx_mix_render (sfx_s, n);
    if (st)
        t2 = rd ();
    for (k = 0; k < 2 * n; k++)
    {
        int m = (int) (mus_f[k] * 16384.0f), o = m + sfx_s[k];
        mus_s[k] = (short) m;
        fs_audio_dac[k] = (short) (o > 32767 ? 32767 : o < -32768 ? -32768 : o);
    }
    if (st)
    {
        long long t3 = rd ();
        st_mus[nstage] = (unsigned) (t1 - t0);
        st_sfx[nstage] = (unsigned) (t2 - t1);
        st_sum[nstage] = (unsigned) (t3 - t2);
        nstage++;
    }
    samples += (unsigned) n;
    blocks++;

    count (0);
    for (k = 0; k < 2 * n; k++)
    {
        synthhash = fnv (synthhash, (unsigned short) mus_s[k], 2);
        mixhash = fnv (mixhash, (unsigned short) sfx_s[k], 2);
    }
    count (1);
}

void fs_audio_update (void)
{
    if (!on)
        return;
    while (audio_tic < gametic)
    {
        render_tic ();
        audio_tic++;
    }
}

void fs_audio_sfx_started (int id, int vol, int sep, int pitch, int handle)
{
    trace_t* t;
    // the start stream's hash and the trace are a few dozen instructions a
    // start: left in the count (pausing would cost two syscalls each)
    sfx_starts++;
    sfxhash = fnv (sfxhash, (unsigned) gametic, 4);
    sfxhash = fnv (sfxhash, (unsigned) id, 2);
    sfxhash = fnv (sfxhash, (unsigned) vol, 1);
    sfxhash = fnv (sfxhash, (unsigned) sep, 1);
    sfxhash = fnv (sfxhash, (unsigned) pitch, 1);
    if ((t = trace_add ("sfx")))
    {
        t->id = id, t->vol = vol, t->sep = sep, t->pitch = pitch, t->handle = handle;
        strncpy (t->name, S_sfx[id].name, 8);
    }
}

void fs_audio_music_event (const char* what, const char* name, int arg)
{
    trace_t* t;
    if ((t = trace_add (what)))
    {
        t->vol = arg;
        if (name)
            strncpy (t->name, name, 8);
    }
}

void fs_audio_floor (floor_audio_t* a)
{
    memset (a, 0, sizeof (*a));
    if (!on)
        return;
    a->samples = samples;
    a->underruns = 0;
    a->music_events = (unsigned) web_music_debug (1);
    a->sfx_starts = sfx_starts;
    a->synthhash = synthhash;
    a->mixhash = mixhash;
    a->frames = blocks;
    fprintf (stderr, "fs-doom: audio %u tics, %llu frames, %u music events, %u sfx starts "
                     "(sfxhash %08x), synthhash %08x mixhash %08x\n",
             blocks, samples, a->music_events, sfx_starts, sfxhash, synthhash, mixhash);
    if (nstage)
    {
        // per tic: music, mixer, sum; the mixer also by its live channels
        unsigned long long tm = 0, ts = 0, tu = 0, by[SFX_CHANNELS + 1] = {0};
        unsigned mm = 0, ms = 0, mu = 0, nby[SFX_CHANNELS + 1] = {0}, mby[SFX_CHANNELS + 1] = {0};
        int i;
        for (i = 0; i < nstage; i++)
        {
            int l = st_live[i] > SFX_CHANNELS ? SFX_CHANNELS : st_live[i];
            tm += st_mus[i], ts += st_sfx[i], tu += st_sum[i];
            mm = st_mus[i] > mm ? st_mus[i] : mm;
            ms = st_sfx[i] > ms ? st_sfx[i] : ms;
            mu = st_sum[i] > mu ? st_sum[i] : mu;
            by[l] += st_sfx[i], nby[l]++;
            mby[l] = st_sfx[i] > mby[l] ? st_sfx[i] : mby[l];
        }
        fprintf (stderr, "AUDIOSTAGES tics=%d music_mean=%llu music_max=%u sfx_mean=%llu sfx_max=%u "
                         "sum_mean=%llu sum_max=%u\n",
                 nstage, tm / nstage, mm, ts / nstage, ms, tu / nstage, mu);
        for (i = 0; i <= SFX_CHANNELS; i++)
            if (nby[i])
                fprintf (stderr, "AUDIOSTAGES live=%d tics=%u sfx_mean=%llu sfx_max=%u\n", i, nby[i],
                         by[i] / nby[i], mby[i]);
    }
    if (trace_path)
    {
        FILE* f = fopen (trace_path, "w");
        int i;
        if (!f)
        {
            fprintf (stderr, "fs-doom: cannot write the audio trace %s\n", trace_path);
            return;
        }
        fprintf (f, "AUDIOTRACE 1 rate=%d events=%d lost=%d sfx_starts=%u sfxhash=%08x\n",
                 FS_AUDIO_RATE, ntrace, trace_lost, sfx_starts, sfxhash);
        for (i = 0; i < ntrace; i++)
        {
            const trace_t* t = &trace[i];
            if (!strcmp (t->what, "sfx"))
                fprintf (f, "%d sfx %s id=%d vol=%d sep=%d pitch=%d handle=%d\n", t->tic,
                         t->name, t->id, t->vol, t->sep, t->pitch, t->handle);
            else
                fprintf (f, "%d music %s%s%s arg=%d\n", t->tic, t->what, t->name[0] ? " " : "",
                         t->name, t->vol);
        }
        fclose (f);
    }
}
