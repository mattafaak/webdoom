// webdoom music: MUS sequencer driving an emulated OPL2 (Nuked OPL3
// core in compat mode) with the IWAD's own GENMIDI instrument bank —
// the authentic AdLib sound, no external assets.
//
// The sequencer steps MUS events at 140Hz between rendered sample
// blocks; JS pulls samples through web_music_render() and feeds an
// AudioWorklet. Everything here is driven by that pull — no timers.
//
// OPL2/OPL3 mode toggle (task 17.1):
//   opl_mode=0 → authentic mono 9-voice OPL2 (NEW=0, default)
//   opl_mode=1 → stereo 18-voice OPL3 (NEW=1, second bank voices 9-17)
// Mode flag is read from config only (via M_SaveDefaults/.doomrc path).
// It never reads playsim/game-state — safe for demos and netplay determinism.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>
#include <math.h>

#include <emscripten.h>

#include "doomdef.h"
#include "doomtype.h"
#include "w_wad.h"
#include "z_zone.h"
#include "opl3.h"

#define MUS_RATE      140
#define OPL_CHANNELS  9     // OPL2 voice count (9 two-op channels)
#define OPL3_CHANNELS 18    // OPL3 voice count (18 two-op channels)
#define MUS_CHANNELS  16
#define PERCUSSION_CH 15

// 0 = OPL2 authentic mono 9-voice (default, byte-identical to pre-17.1)
// 1 = OPL3 stereo 18-voice (second addressing scheme, second bank voices 9-17)
// Mode flag is persisted by JS settings (localStorage) — no .doomrc entry.
static int opl_mode = 0;

// --- GENMIDI bank -------------------------------------------------------

typedef struct
{
    byte tremolo, attack, sustain, waveform, scale, level;
} genmidi_op_t;

typedef struct
{
    genmidi_op_t mod;
    byte feedback;
    genmidi_op_t car;
    byte unused;
    short offset; // note offset (double voice detune lives here)
} genmidi_voice_t;

typedef struct
{
    unsigned short flags;
    byte finetune;
    byte fixednote;
    genmidi_voice_t voice[2];
} genmidi_instr_t;

#define GENMIDI_FLAG_FIXED 0x01
#define GENMIDI_FLAG_2VOICE 0x04

static genmidi_instr_t bank[175];
static boolean bank_loaded;

// --- OPL voice state ----------------------------------------------------

typedef struct
{
    int muschan;  // owning MUS channel, -1 free
    int note;     // MUS note that keyed us on
    int basenote; // note after fixed/offset adjustment
    int notevol;  // 0..127
    int age;      // for oldest-voice stealing
    const genmidi_voice_t* gv;
} oplvoice_t;

static opl3_chip chip;
// Full 18-slot array: [0..8] are used in both modes; [9..17] only in OPL3.
static oplvoice_t voice[OPL3_CHANNELS];
static int dbg_events, dbg_noteons; // test-harness counters
static int samplerate = 44100;
static int agecounter;

// per-MUS-channel state
static int ch_instr[MUS_CHANNELS];
static int ch_vol[MUS_CHANNELS];
static int ch_bend[MUS_CHANNELS]; // 128 = center, 1/64 semitone units
static int ch_lastvol[MUS_CHANNELS];

// sequencer state
static byte* mus; // full lump
static int muslen;
static byte* ev; // event cursor
static byte* ev_start;
static byte* ev_end;
static boolean playing;
static boolean looping;
static double samples_per_tick;
static double tick_accum;     // samples until next event group
static int musicvolume = 127; // 0..127 master (menu music slider)

static void opl_write (int reg, int val)
{
    OPL3_WriteRegBuffered (&chip, (Bit16u) reg, (Bit8u) val);
}

// operator offsets for the 9 two-op channels (applies to both banks)
static const int op1off[OPL_CHANNELS] = {0x00, 0x01, 0x02, 0x08, 0x09,
                                         0x0a, 0x10, 0x11, 0x12};

// OPL3 second-bank helpers.
// vbank(v)  — register bank base: 0x000 for voices 0-8, 0x100 for voices 9-17
// vch(v)    — channel within bank: 0-8 for both ranges
// Used ONLY in OPL3 mode; in OPL2 mode v is always < OPL_CHANNELS so
// vbank(v)=0 and vch(v)=v, preserving identical register addresses.
static int vbank (int v) { return (v >= OPL_CHANNELS) ? 0x100 : 0x000; }
static int vch   (int v) { return (v >= OPL_CHANNELS) ? v - OPL_CHANNELS : v; }

// Active voice ceiling: 9 in OPL2, 18 in OPL3
static int opl_nvoices (void) { return opl_mode ? OPL3_CHANNELS : OPL_CHANNELS; }

// OPL frequency for a midi-ish note + bend (1/64 semitones off center).
// fnum table for one octave starting at block boundary; computed from
// 49716Hz master via freq*2^(20-block)/49716 — precomputed for C..B.
static const unsigned short fnumtab[12] = {
    0x157, 0x16b, 0x181, 0x198, 0x1b0, 0x1ca,
    0x1e5, 0x202, 0x220, 0x241, 0x263, 0x287,
};

static __attribute__((noinline)) void voice_freq (int v, boolean keyon)
{
    int note = voice[v].basenote;
    int bend = ch_bend[voice[v].muschan] - 128; // ±128 = ±2 semitones
    int cents64; // note position in 1/64 semitones
    int block, idx, fnum, frac;

    cents64 = note * 64 + bend;
    if (cents64 < 0)
        cents64 = 0;

    block = cents64 / (12 * 64) - 1; // note 12..23 => block 0
    idx = cents64 % (12 * 64);
    // linear interpolation between semitone fnums (fine enough for bends)
    frac = idx % 64;
    idx /= 64;
    fnum = fnumtab[idx];
    if (idx < 11)
        fnum += ((fnumtab[idx + 1] - fnumtab[idx]) * frac) >> 6;
    else
        fnum += ((0x2ae - fnumtab[11]) * frac) >> 6;

    if (block < 0)
    {
        block = 0;
        fnum >>= 1;
    }
    if (block > 7)
        block = 7;

    opl_write (vbank (v) | 0xa0 | vch (v), fnum & 0xff);
    opl_write (vbank (v) | 0xb0 | vch (v), (keyon ? 0x20 : 0) | (block << 2) | (fnum >> 8));
}

static int op2off (int v)
{
    return op1off[vch (v)] + 3;
}

// Combined MIDI-style volume (0..127) → extra OPL total-level steps
// (0.75 dB each). Perceptual: ~40dB span like DMX, not linear — a linear
// blend crushes quiet velocities to near-silence (Suspense's pizzicato).
static byte volatten[128];

static void init_volatten (void)
{
    int v, a;
    volatten[0] = 63;
    for (v = 1; v < 128; v++)
    {
        a = (int) (-40.0 * log10 (v / 127.0) / 0.75);
        volatten[v] = a > 63 ? 63 : (byte) a;
    }
}

static void voice_volume (int v)
{
    const genmidi_voice_t* gv = voice[v].gv;
    int bk = vbank (v);
    int ch = vch (v);
    int vol; // 0..127 combined
    int level;

    vol = (ch_vol[voice[v].muschan] * voice[v].notevol * musicvolume) /
          (127 * 127);
    if (vol > 127)
        vol = 127;

    level = (gv->car.level & 0x3f) + volatten[vol];
    if (level > 63)
        level = 63;
    opl_write (bk | 0x40 | op2off (v), (gv->car.scale & 0xc0) | level);

    // additive connection: the modulator reaches the output too
    if (gv->feedback & 1)
    {
        level = (gv->mod.level & 0x3f) + volatten[vol];
        if (level > 63)
            level = 63;
        opl_write (bk | 0x40 | op1off[ch], (gv->mod.scale & 0xc0) | level);
    }
}

static __attribute__((noinline)) void voice_program (int v)
{
    const genmidi_voice_t* gv = voice[v].gv;
    int bk = vbank (v);
    int ch = vch (v);
    int o1 = op1off[ch], o2 = op2off (v);

    opl_write (bk | 0x20 | o1, gv->mod.tremolo);
    opl_write (bk | 0x60 | o1, gv->mod.attack);
    opl_write (bk | 0x80 | o1, gv->mod.sustain);
    opl_write (bk | 0xe0 | o1, gv->mod.waveform);
    opl_write (bk | 0x40 | o1, (gv->mod.scale & 0xc0) | (gv->mod.level & 0x3f));

    opl_write (bk | 0x20 | o2, gv->car.tremolo);
    opl_write (bk | 0x60 | o2, gv->car.attack);
    opl_write (bk | 0x80 | o2, gv->car.sustain);
    opl_write (bk | 0xe0 | o2, gv->car.waveform);

    // 0xc0+ch: L/R bits 0x30 are OPL3-only (NEW=1); in OPL2 mode (NEW=0)
    // these bits are inert per OPL3 spec — OPL2 path is byte-identical.
    opl_write (bk | 0xc0 | ch, gv->feedback | 0x30); // both speakers
    voice_volume (v);
}

static void voice_off (int v)
{
    if (voice[v].muschan < 0)
        return;
    opl_write (vbank (v) | 0xb0 | vch (v), 0); // key off, keep freq bits harmless
    voice[v].muschan = -1;
}

static int voice_alloc (void)
{
    int v, oldest = 0, oldage = 0x7fffffff;
    int nv = opl_nvoices ();

    for (v = 0; v < nv; v++)
        if (voice[v].muschan < 0)
            return v;
    for (v = 0; v < nv; v++)
        if (voice[v].age < oldage)
        {
            oldage = voice[v].age;
            oldest = v;
        }
    voice_off (oldest);
    return oldest;
}

static void note_on (int muschan, int note, int notevol, boolean second)
{
    const genmidi_instr_t* in;
    int v, instr;

    instr = (muschan == PERCUSSION_CH) ? 128 + note - 35 : ch_instr[muschan];
    if (instr < 0 || instr >= 175)
        return;
    in = &bank[instr];

    v = voice_alloc ();
    dbg_noteons++;
    voice[v].muschan = muschan;
    voice[v].note = note;
    voice[v].notevol = notevol;
    voice[v].age = ++agecounter;
    voice[v].gv = &in->voice[second ? 1 : 0];

    if (in->flags & GENMIDI_FLAG_FIXED)
        note = in->fixednote;
    voice[v].basenote = note + voice[v].gv->offset;

    voice_program (v);
    voice_freq (v, true);

    if (!second && (in->flags & GENMIDI_FLAG_2VOICE))
        note_on (muschan, voice[v].note, notevol, true);
}

static void note_off (int muschan, int note)
{
    int v;
    for (v = 0; v < opl_nvoices (); v++)
        if (voice[v].muschan == muschan && voice[v].note == note)
            voice_off (v);
}

static void all_notes_off (void)
{
    int v;
    for (v = 0; v < opl_nvoices (); v++)
        voice_off (v);
}

static void channel_update (int muschan)
{
    int v;
    for (v = 0; v < opl_nvoices (); v++)
        if (voice[v].muschan == muschan)
        {
            voice_volume (v);
            voice_freq (v, true);
        }
}

// --- MUS event processing ----------------------------------------------

// returns tics to wait, or -1 on score end
static int run_event_group (void)
{
    int b, type, chan, delay;

    for (;;)
    {
        if (ev >= ev_end)
            return -1;

        b = *ev++;
        type = (b >> 4) & 7;
        chan = b & 15;
        dbg_events++;

        switch (type)
        {
        case 0: // release
            note_off (chan, *ev++ & 0x7f);
            break;
        case 1: // play
        {
            int note = *ev++;
            if (note & 0x80)
                ch_lastvol[chan] = *ev++ & 0x7f;
            note_on (chan, note & 0x7f, ch_lastvol[chan], false);
            break;
        }
        case 2: // pitch bend
            ch_bend[chan] = *ev++;
            channel_update (chan);
            break;
        case 3: // system event
            switch (*ev++ & 0x7f)
            {
            case 10:
            case 11:
                all_notes_off ();
                break; // all sounds/notes off
            default:
                break;
            }
            break;
        case 4: // controller
        {
            int ctrl = *ev++ & 0x7f;
            int val = *ev++ & 0x7f;
            switch (ctrl)
            {
            case 0:
                ch_instr[chan] = val;
                break;
            case 3:
                ch_vol[chan] = val;
                channel_update (chan);
                break;
            default:
                break;
            }
            break;
        }
        case 6: // score end
            return -1;
        default: // unknown: skip payload
            ev++;
            break;
        }

        if (b & 0x80) // delay follows
        {
            delay = 0;
            do
            {
                b = *ev++;
                delay = (delay << 7) | (b & 0x7f);
            } while (b & 0x80);
            return delay;
        }
    }
}

// --- public interface (called from i_sound.c and JS) --------------------

static void load_bank (void)
{
    byte* g;

    if (bank_loaded || W_CheckNumForName ("GENMIDI") < 0)
        return;
    g = W_CacheLumpName ("GENMIDI", PU_STATIC);
    if (memcmp (g, "#OPL_II#", 8) == 0)
    {
        memcpy (bank, g + 8, sizeof bank);
        bank_loaded = true;
    }
}

void mus_init (int rate)
{
    int v;

    samplerate = rate;
    OPL3_Reset (&chip, (Bit32u) rate);
    // OPL2 compat: leave NEW=0; enable waveform select semantics.
    // NEW=0 is the only register write done unconditionally; it keeps the
    // OPL2 output byte-identical to pre-17.1 builds when opl_mode==0.
    opl_write (0x01, 0x20);

    if (opl_mode == 1)
    {
        // OPL3 mode: enable NEW bit in secondary status register.
        // All OPL3-specific writes are inside this branch so that the
        // OPL2 path (opl_mode==0) remains byte-inert.
        opl_write (0x105, 0x01); // NEW=1: enables second bank + panning
    }

    load_bank ();
    init_volatten ();

    // The browser re-inits when the AudioContext arms, possibly mid-song:
    // the reset zeroed every operator (attack 0 = silent forever), so
    // reprogram live voices and keep the sequencer's clock consistent.
    for (v = 0; v < opl_nvoices (); v++)
        if (voice[v].muschan >= 0)
        {
            voice_program (v);
            voice_freq (v, true);
        }
    if (playing)
        samples_per_tick = (double) samplerate / MUS_RATE;
}

// web_set_opl_mode — switch between OPL2 (0) and OPL3 (1) at runtime.
// Called from JS settings UI; reads config only, never game-state.
// Mode switch goes through OPL3_Reset + full re-program to avoid live
// NEW-bit flipping (which leaves operator state inconsistent).
EMSCRIPTEN_KEEPALIVE void web_set_opl_mode (int mode)
{
    int want = mode ? 1 : 0;
    if (want == opl_mode)
        return;
    opl_mode = want;
    // OPL3_Reset zeroes everything; mus_init re-enables waveforms,
    // NEW=1 if OPL3, and reprograms any live voices.
    mus_init (samplerate);
}

void mus_play (void* data, int len, int loop)
{
    unsigned short scorestart, scorelen;
    byte* m = (byte*) data;
    int i;

    playing = false;
    all_notes_off ();
    load_bank ();

    if (!bank_loaded || !m || len < 16 || memcmp (m, "MUS\x1a", 4) != 0)
        return;

    scorelen = m[4] | (m[5] << 8);
    scorestart = m[6] | (m[7] << 8);
    if (scorestart + scorelen > len)
        return;

    mus = m;
    muslen = len;
    ev_start = m + scorestart;
    ev_end = ev_start + scorelen;
    ev = ev_start;
    looping = loop;

    for (i = 0; i < MUS_CHANNELS; i++)
    {
        ch_instr[i] = 0;
        ch_vol[i] = 127;
        ch_bend[i] = 128;
        ch_lastvol[i] = 100;
    }

    samples_per_tick = (double) samplerate / MUS_RATE;
    tick_accum = 0;
    playing = true;
}

void mus_stop (void)
{
    playing = false;
    all_notes_off ();
}

void mus_pause (int pause)
{
    if (pause)
        all_notes_off (); // sequencer position is kept
    playing = !pause && mus != NULL;
}

void mus_setvolume (int vol127)
{
    int v;
    musicvolume = vol127;
    for (v = 0; v < opl_nvoices (); v++)
        if (voice[v].muschan >= 0)
            voice_volume (v);
}

EMSCRIPTEN_KEEPALIVE int web_music_debug (int what)
{
    int v, n = 0;
    switch (what)
    {
    case 0:
        return playing;
    case 1:
        return dbg_events;
    case 2:
        return dbg_noteons;
    case 3:
        return bank_loaded;
    case 4:
        for (v = 0; v < opl_nvoices (); v++)
            if (voice[v].muschan >= 0)
                n++;
        return n;
    }
    return -1;
}

//
// web_music_render — JS pulls interleaved stereo f32 here.
//
EMSCRIPTEN_KEEPALIVE void web_music_render (float* out, int nframes)
{
    Bit16s buf[2];
    int i;

    for (i = 0; i < nframes; i++)
    {
        if (playing)
        {
            tick_accum -= 1.0;
            while (tick_accum <= 0)
            {
                int wait = run_event_group ();
                if (wait < 0)
                {
                    if (looping)
                    {
                        ev = ev_start;
                        wait = 1;
                    }
                    else
                    {
                        playing = false;
                        break;
                    }
                }
                tick_accum += wait * samples_per_tick;
            }
        }
        OPL3_GenerateResampled (&chip, buf);
        out[i * 2] = buf[0] / 16384.0f;
        out[i * 2 + 1] = buf[1] / 16384.0f;
    }
}
