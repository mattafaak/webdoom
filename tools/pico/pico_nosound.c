// tools/pico/pico_nosound.c — the sound stack stubbed out entirely, for
// tools/pico's "-nosound" variants: in place of tools/freestanding's i_sound.c,
// fs_audio.c, sfx_mix.c, fs_mus.c and engine/web/opl3.c.
//
// Every I_ function is what tools/freestanding/i_sound.c is under WD_AUDIO=0:
// a sound starts nothing, music plays nothing, and s_sound.c keeps its default
// 3 channels.  I_GetSfxLumpNum still finds the lump, as that build does.
// Copyright (C) 2026, GPL-2.0-or-later.
#include <stdio.h>

#include "doomdef.h"
#include "sounds.h"
#include "i_sound.h"
#include "w_wad.h"

void I_InitSound (void) {}
void I_UpdateSound (void) {}
void I_SubmitSound (void) {}
void I_ShutdownSound (void) {}
void I_SetChannels (void) {}

int I_GetSfxLumpNum (sfxinfo_t* sfx)
{
    char namebuf[9];
    sprintf (namebuf, "ds%s", sfx->name);
    return W_CheckNumForName (namebuf);
}

int I_StartSound (int id, int vol, int sep, int pitch, int priority)
{
    (void) id;
    (void) vol;
    (void) sep;
    (void) pitch;
    (void) priority;
    return 0;
}

void I_StopSound (int handle)
{
    (void) handle;
}

int I_SoundIsPlaying (int handle)
{
    (void) handle;
    return 0;
}

void I_UpdateSoundParams (int handle, int vol, int sep, int pitch)
{
    (void) handle;
    (void) vol;
    (void) sep;
    (void) pitch;
}

void I_InitMusic (void) {}
void I_ShutdownMusic (void) {}

void I_SetMusicVolume (int volume)
{
    (void) volume;
}

void I_PauseSong (int handle)
{
    (void) handle;
}

void I_ResumeSong (int handle)
{
    (void) handle;
}

int I_RegisterSong (void* data, int len)
{
    (void) data;
    (void) len;
    return 0;
}

void I_PlaySong (int handle, int looping)
{
    (void) handle;
    (void) looping;
}

void I_StopSong (int handle)
{
    (void) handle;
}

void I_UnRegisterSong (int handle)
{
    (void) handle;
}
