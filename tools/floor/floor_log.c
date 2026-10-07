// tools/floor/floor_log.c — see floor_log.h.  C89, no libc.
// Copyright (C) 2026, GPL-2.0-or-later.
#include "floor_log.h"

static void (*out) (int c);

void floor_log_init (void (*putc_fn) (int c))
{
    out = putc_fn;
}

static void put_s (const char* s)
{
    if (!out || !s)
        return;
    while (*s)
        out ((unsigned char) *s++);
}

static void put_u64 (unsigned long long v)
{
    char buf[24];
    int n = 0;
    if (!out)
        return;
    do
    {
        buf[n++] = (char) ('0' + (int) (v % 10));
        v /= 10;
    } while (v);
    while (n--)
        out (buf[n]);
}

static void put_hex8 (unsigned v)
{
    int i;
    if (!out)
        return;
    for (i = 28; i >= 0; i -= 4)
    {
        int d = (int) ((v >> i) & 0xfu);
        out (d < 10 ? '0' + d : 'a' + d - 10);
    }
}

static void put_kv (const char* key, const char* val)
{
    put_s (" ");
    put_s (key);
    put_s ("=");
    put_s (val);
}

static void put_ku (const char* key, unsigned long long v)
{
    put_s (" ");
    put_s (key);
    put_s ("=");
    put_u64 (v);
}

void floor_header (const floor_header_t* h)
{
    char mode[2];
    mode[0] = h->mode;
    mode[1] = 0;
    put_s ("FLOOR 1");
    put_kv ("target", h->target);
    put_kv ("source", h->source);
    put_kv ("unit", h->unit);
    put_ku ("unit_hz", h->unit_hz);
    put_kv ("build", h->build);
    put_ku ("view", (unsigned long long) h->view);
    put_ku ("detail", (unsigned long long) h->detail);
    put_ku ("zone", h->zone);
    put_ku ("precache", (unsigned long long) h->precache);
    put_kv ("mode", mode);
    put_s ("\n");
}

void floor_demo_begin (const char* name, unsigned tics)
{
    put_s ("DEMO ");
    put_s (name);
    put_ku ("tics", tics);
    put_s ("\n");
}

void floor_tic (unsigned i, unsigned gametic, unsigned long long elapsed,
                unsigned flags, unsigned mbytes, int have_hash,
                unsigned simhash, unsigned renderhash)
{
    int any = 0;
    put_s ("T ");
    put_u64 (i);
    put_s (" ");
    put_u64 (gametic);
    put_s (" ");
    put_u64 (elapsed);
    put_s (" ");
    if (flags & FLOOR_TIC_LOAD)
    {
        put_s ("L");
        any = 1;
    }
    if (mbytes)
    {
        if (any)
            put_s (",");
        put_s ("M:");
        put_u64 (mbytes);
        any = 1;
    }
    if (!any)
        put_s ("-");
    if (have_hash)
    {
        put_s (" ");
        put_hex8 (simhash);
        put_s (" ");
        put_hex8 (renderhash);
    }
    put_s ("\n");
}

void floor_audio (const floor_audio_t* a)
{
    put_s ("AUDIO");
    put_ku ("samples", a->samples);
    put_ku ("underruns", a->underruns);
    put_ku ("music_events", a->music_events);
    put_ku ("sfx_starts", a->sfx_starts);
    put_s (" synthhash=");
    put_hex8 (a->synthhash);
    put_s (" mixhash=");
    put_hex8 (a->mixhash);
    put_ku ("frames", a->frames);
    put_s ("\n");
}

void floor_demo_end (const char* name, unsigned final_sim,
                     unsigned final_render)
{
    put_s ("END ");
    put_s (name);
    put_s (" final=");
    put_hex8 (final_sim);
    put_s (":");
    put_hex8 (final_render);
    put_s ("\n");
}
