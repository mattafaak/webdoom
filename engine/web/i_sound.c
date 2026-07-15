// webdoom i_sound: SFX lumps are handed to JS (WebAudio decodes DMX PCM
// once per lump and plays per-channel with vanilla vol/sep/pitch);
// music goes through the MUS+OPL sequencer in mus_opl.c, pulled by an
// AudioWorklet via web_music_render.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stdio.h>

#include <emscripten.h>

#include "doomdef.h"
#include "doomstat.h"
#include "w_wad.h"
#include "z_zone.h"
#include "sounds.h"
#include "i_sound.h"
#include "web.h"

// --- JS bridge (no-ops until client/js/audio.js installs the hooks) ----

EM_JS (void, js_sfx_start, (int handle, int id, void* data, int len,
                            int vol, int sep, int pitch), {
    if (Module["sfxStart"]) Module["sfxStart"](handle, id, data, len, vol, sep, pitch);
});
EM_JS (void, js_sfx_stop, (int handle), {
    if (Module["sfxStop"]) Module["sfxStop"](handle);
});
EM_JS (int, js_sfx_playing, (int handle), {
    return Module["sfxPlaying"] ? Module["sfxPlaying"](handle) : 0;
});
EM_JS (void, js_sfx_update, (int handle, int vol, int sep, int pitch), {
    if (Module["sfxUpdate"]) Module["sfxUpdate"](handle, vol, sep, pitch);
});
EM_JS (void, js_music_event, (int what), {   // 1 play, 0 stop
    if (Module["musicEvent"]) Module["musicEvent"](what);
});

void I_InitSound (void) { I_InitMusic (); }
void I_UpdateSound (void) {}
void I_SubmitSound (void) {}
void I_ShutdownSound (void) {}
void I_SetChannels (void) {}

int I_GetSfxLumpNum (sfxinfo_t* sfx)
{
    char namebuf[9];
    sprintf (namebuf, "ds%s", sfx->name);
    // total conversions may omit sounds; -1 = play nothing
    return W_CheckNumForName (namebuf);
}

static int soundhandle;

int I_StartSound (int id, int vol, int sep, int pitch, int priority)
{
    sfxinfo_t* sfx = &S_sfx[id];
    void* data;
    int len;

    if (sfx->lumpnum < 0)
        sfx->lumpnum = I_GetSfxLumpNum (sfx);
    if (sfx->lumpnum < 0)
        return 0;               // lump absent in this wad
    len = W_LumpLength (sfx->lumpnum);
    data = W_CacheLumpNum (sfx->lumpnum, PU_STATIC);   // stays; JS decodes once

    js_sfx_start (++soundhandle, id, data, len, vol, sep, pitch);
    return soundhandle;
}

void I_StopSound (int handle)                  { js_sfx_stop (handle); }
int  I_SoundIsPlaying (int handle)             { return js_sfx_playing (handle); }
void I_UpdateSoundParams (int handle, int vol, int sep, int pitch)
{
    js_sfx_update (handle, vol, sep, pitch);
}

// --- music ---------------------------------------------------------------

// The engine registers/plays lumps; actual sample generation happens in
// mus_opl.c when JS pulls. One song at a time (matches the game).
static void* songdata;
static int   songlen;

void I_InitMusic (void)
{
    mus_init (44100);   // JS re-inits with the real AudioContext rate
}

EMSCRIPTEN_KEEPALIVE
void web_music_init (int samplerate)
{
    mus_init (samplerate);
}

void I_ShutdownMusic (void) { mus_stop (); }

void I_SetMusicVolume (int volume)      // menu slider 0..15
{
    mus_setvolume (volume * 127 / 15);
}

int I_RegisterSong (void* data, int len)
{
    songdata = data;
    songlen = len;
    return 1;
}

void I_PlaySong (int handle, int looping)
{
    (void) handle;
    mus_play (songdata, songlen, looping);
    js_music_event (1);
}

void I_PauseSong (int handle)  { (void) handle; mus_pause (1); }
void I_ResumeSong (int handle) { (void) handle; mus_pause (0); }

void I_StopSong (int handle)
{
    (void) handle;
    mus_stop ();
    js_music_event (0);
}

void I_UnRegisterSong (int handle) { (void) handle; songdata = 0; }
