// tools/freestanding/sfx_mix.c — the reference sound-effect mixer for the
// freestanding platform.  Integer only, no tables, no allocation, and
// deterministic: the same starts at the same frames give the same samples on
// any target, which is what the AUDIO line's mixhash pins.
//
// THE ARITHMETIC (the contract a port reproduces)
//   lump      DMX format 3: u16 3, u16 rate, u32 length, then `length` bytes:
//             16 pad, the samples, 16 pad.  A lump whose length runs past the
//             lump or is <= 48 is not played, and the pads are skipped -- as
//             DMX does, in Chocolate Doom's reading (i_sdlsound.c CacheSFX,
//             which client/js/audio.js also follows).  The lump is read IN
//             PLACE, never copied or written: on a target whose WAD is
//             executed in place the samples stay in flash.
//   volume    vanilla 1.9's 0..127 (the caller maps the engine's 0..15).
//   pan       left = (254 - sep) * vol / 127, right = sep * vol / 127, each
//             clamped to 0..255: Chocolate Doom's I_SDL_UpdateSoundParams.
//   resample  zero-order hold by an exact rational step: each output frame
//             takes the current source sample, then the source advances by
//             rate / out_rate (an accumulator in out_rate units, no rounding).
//             No pitch shift: vanilla's pitch is not applied.
//   mix       per frame and side: sum over channels of (sample - 128) * gain,
//             in 32 bits, clamped to int16.  8 channels at most; a start with
//             all 8 busy takes the channel of the oldest sound.
//   end       a channel frees itself after its last sample is mixed.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include "sfx_mix.h"

typedef struct
{
    const unsigned char* data; // the first sample, inside the lump
    unsigned len;              // samples
    unsigned pos;              // the source sample the next frame takes
    unsigned acc;              // fractional position, in out_rate units
    unsigned rate;             // the lump's rate, Hz
    int gl, gr;                // gains, 0..255
    int handle;                // 0: free
} sfx_chan_t;

static sfx_chan_t chan[SFX_CHANNELS];
static unsigned out_rate = 49716;
static int last_handle;

// One render pass at most this many frames; longer calls loop.
#define MIX_BLOCK 2048
static int acc[2 * MIX_BLOCK];

void sfx_mix_init (int rate)
{
    memset (chan, 0, sizeof (chan));
    out_rate = (unsigned) rate;
    last_handle = 0;
}

static int clamp255 (int v)
{
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

static void set_gains (sfx_chan_t* c, int vol, int sep)
{
    if (vol < 0)
        vol = 0;
    if (vol > 127)
        vol = 127;
    c->gl = clamp255 (((254 - sep) * vol) / 127);
    c->gr = clamp255 ((sep * vol) / 127);
}

static sfx_chan_t* find (int handle)
{
    int i;
    if (handle <= 0)
        return 0;
    for (i = 0; i < SFX_CHANNELS; i++)
        if (chan[i].handle == handle)
            return &chan[i];
    return 0;
}

int sfx_mix_start (const unsigned char* lump, int lumplen, int vol, int sep)
{
    unsigned rate, len;
    sfx_chan_t* c = 0;
    int i;

    if (!lump || lumplen < 8 || lump[0] != 3 || lump[1] != 0)
        return 0;
    rate = lump[2] | (lump[3] << 8);
    len = lump[4] | (lump[5] << 8) | ((unsigned) lump[6] << 16) |
          ((unsigned) lump[7] << 24);
    if (len > (unsigned) (lumplen - 8) || len <= 48 || !rate)
        return 0;

    for (i = 0; i < SFX_CHANNELS && !c; i++)
        if (!chan[i].handle)
            c = &chan[i];
    if (!c) // all busy: the oldest sound gives way
    {
        c = &chan[0];
        for (i = 1; i < SFX_CHANNELS; i++)
            if (chan[i].handle < c->handle)
                c = &chan[i];
    }
    c->data = lump + 8 + 16;
    c->len = len - 32;
    c->pos = 0;
    c->acc = 0;
    c->rate = rate;
    set_gains (c, vol, sep);
    if (++last_handle <= 0) // handles stay positive, and wrap far past a demo
        last_handle = 1;
    c->handle = last_handle;
    return c->handle;
}

void sfx_mix_stop (int handle)
{
    sfx_chan_t* c = find (handle);
    if (c)
        c->handle = 0;
}

int sfx_mix_playing (int handle)
{
    return find (handle) != 0;
}

void sfx_mix_update (int handle, int vol, int sep)
{
    sfx_chan_t* c = find (handle);
    if (c)
        set_gains (c, vol, sep);
}

int sfx_mix_live (void)
{
    int i, n = 0;
    for (i = 0; i < SFX_CHANNELS; i++)
        n += chan[i].handle != 0;
    return n;
}

void sfx_mix_render (short* out, int frames)
{
    while (frames > 0)
    {
        int n = frames < MIX_BLOCK ? frames : MIX_BLOCK, i, k, live = 0;
        for (k = 0; k < SFX_CHANNELS; k++)
        {
            sfx_chan_t* c = &chan[k];
            const unsigned char* d;
            unsigned pos, a, rate, len;
            int gl, gr, *p;
            if (!c->handle)
                continue;
            if (!live++)
                memset (acc, 0, sizeof (int) * 2 * n);
            d = c->data, pos = c->pos, a = c->acc, rate = c->rate, len = c->len;
            gl = c->gl, gr = c->gr, p = acc;
            for (i = 0; i < n; i++)
            {
                int s = (int) d[pos] - 128;
                p[0] += s * gl;
                p[1] += s * gr;
                p += 2;
                a += rate;
                while (a >= out_rate)
                    a -= out_rate, pos++;
                if (pos >= len)
                    break;
            }
            if (pos >= len)
                c->handle = 0; // its last sample is mixed
            c->pos = pos;
            c->acc = a;
        }
        if (!live)
            memset (out, 0, sizeof (short) * 2 * n);
        else
            for (i = 0; i < 2 * n; i++)
                out[i] = (short) (acc[i] > 32767 ? 32767 : acc[i] < -32768 ? -32768 : acc[i]);
        out += 2 * n;
        frames -= n;
    }
}
