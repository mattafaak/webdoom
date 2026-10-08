// tools/freestanding/i_sound.c — sound and music for the freestanding core.
//
// Sound effects go to sfx_mix.c, 8 channels, read in place from the WAD blob
// (lumpinfo's handle is the lump's byte pointer: w_wad.c).  Music goes to the
// web build's own sequencer and OPL synth (engine/web/mus_opl.c through
// fs_mus.c, and opl3.c), driven as engine/web/i_sound.c drives it.  Both are
// rendered once per tic by fs_audio.c, from I_UpdateSound.
//
// The volumes: this engine's s_sound.c passes snd_SfxVolume on its 0..15
// scale (S_Init's and M_SfxVol's "* 8" are commented out, as in linuxdoom);
// vanilla 1.9 hands DMX that times 8, so the mixer gets vol * 8.  Music volume
// is engine/web/i_sound.c's mapping, 0..15 -> volume * 127 / 15.
//
// s_sound.c gets 8 channels (I_SetChannels), vanilla setup's maximum; the
// config default it would otherwise use is 3.
//
// WD_AUDIO=0: every function is the old no-op stub again (fs_audio.c).
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>
#include <string.h>

#include "doomdef.h"
#include "sounds.h"
#include "i_sound.h"
#include "w_wad.h"
#include "web.h"
#include "fs_audio.h"
#include "sfx_mix.h"

extern int numChannels; // s_sound.c, read when S_Init allocates its channels
void fs_mus_preinit (void);     // fs_mus.c
void fs_mus_bank_endian (void); // fs_mus.c

// ── I_Sound interface ─────────────────────────────────────────────────────────
void I_InitSound (void)
{
    fs_audio_init ();
    I_InitMusic ();
}
void I_UpdateSound (void)
{
    fs_audio_update ();
}
void I_SubmitSound (void) {} // no device: fs_audio_dac[] holds the output
void I_ShutdownSound (void) {}
void I_SetChannels (void)
{
    if (fs_audio_on ())
        numChannels = SFX_CHANNELS;
}

int I_GetSfxLumpNum (sfxinfo_t* sfx)
{
    char namebuf[9];
    sprintf (namebuf, "ds%s", sfx->name);
    return W_CheckNumForName (namebuf);
}

int I_StartSound (int id, int vol, int sep, int pitch, int priority)
{
    sfxinfo_t* sfx = &S_sfx[id];
    const lumpinfo_t* l;
    int h;
    (void) priority;
    if (!fs_audio_on ())
        return 0;
    if (sfx->lumpnum < 0)
        sfx->lumpnum = I_GetSfxLumpNum (sfx);
    if (sfx->lumpnum < 0)
        return 0; // total conversions may omit sounds
    l = &lumpinfo[sfx->lumpnum];
    h = sfx_mix_start ((const unsigned char*) (size_t) l->handle, l->size, vol * 8, sep);
    if (h)
        fs_audio_sfx_started (id, vol, sep, pitch, h);
    return h;
}

void I_StopSound (int handle)
{
    sfx_mix_stop (handle);
}
int I_SoundIsPlaying (int handle)
{
    return sfx_mix_playing (handle);
}
void I_UpdateSoundParams (int handle, int vol, int sep, int pitch)
{
    (void) pitch;
    sfx_mix_update (handle, vol * 8, sep);
}

// ── I_Music interface ─────────────────────────────────────────────────────────
static void* songdata;
static int songlen;

void I_InitMusic (void)
{
    if (!fs_audio_on ())
        return;
    fs_mus_preinit (); // see fs_mus.c: every voice free before the first call
    mus_init (FS_AUDIO_RATE);
    fs_mus_bank_endian (); // and a big-endian target's GENMIDI (fs_mus.c)
}

void I_ShutdownMusic (void)
{
    if (fs_audio_on ())
        mus_stop ();
}

void I_SetMusicVolume (int v) // menu slider 0..15
{
    if (!fs_audio_on ())
        return;
    mus_setvolume (v * 127 / 15);
    fs_audio_music_event ("volume", 0, v * 127 / 15);
}

void I_PauseSong (int handle)
{
    (void) handle;
    if (!fs_audio_on ())
        return;
    mus_pause (1);
    fs_audio_music_event ("pause", 0, 0);
}

void I_ResumeSong (int handle)
{
    (void) handle;
    if (!fs_audio_on ())
        return;
    mus_pause (0);
    fs_audio_music_event ("resume", 0, 0);
}

int I_RegisterSong (void* data, int len)
{
    int i;
    const char* name = 0;
    if (!fs_audio_on ())
        return 0;
    songdata = data;
    songlen = len;
    for (i = 1; i < NUMMUSIC; i++) // the trace's name for it (S_ChangeMusic set data)
        if (S_music[i].data == data)
            name = S_music[i].name;
    fs_audio_music_event ("register", name, len);
    return 1;
}

void I_PlaySong (int handle, int looping)
{
    (void) handle;
    if (!fs_audio_on ())
        return;
    mus_play (songdata, songlen, looping);
    fs_audio_music_event ("play", 0, looping);
}

void I_StopSong (int handle)
{
    (void) handle;
    if (!fs_audio_on ())
        return;
    mus_stop ();
    fs_audio_music_event ("stop", 0, 0);
}

void I_UnRegisterSong (int handle)
{
    (void) handle;
    songdata = 0;
}
