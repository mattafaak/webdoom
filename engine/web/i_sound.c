// webdoom i_sound: SFX lumps are handed to JS (WebAudio decodes DMX PCM
// once per lump and plays per-channel with vanilla vol/sep/pitch);
// music goes through the MUS+OPL sequencer in mus_opl.c, pulled by an
// AudioWorklet via web_music_render.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stddef.h>
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

// clang-format off
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
// what: 0 stop, 1 play(data,len,looping), 2 pause, 3 resume, 4 volume(arg).
// Round 11 widened this from (int what) -- it carried play and stop only, so a
// JS-side synth could not learn about pause, resume or a volume change at all.
EM_JS (void, js_music_event, (int what, void* data, int len, int arg), {
    if (Module["musicEvent"]) Module["musicEvent"](what, data, len, arg);
});
// clang-format on

void I_InitSound (void)
{
    I_InitMusic ();
}
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
        return 0; // lump absent in this wad
    len = W_LumpLength (sfx->lumpnum);
    data = W_CacheLumpNum (sfx->lumpnum, PU_STATIC); // stays; JS decodes once

    js_sfx_start (++soundhandle, id, data, len, vol, sep, pitch);
    return soundhandle;
}

void I_StopSound (int handle)
{
    js_sfx_stop (handle);
}
int I_SoundIsPlaying (int handle)
{
    return js_sfx_playing (handle);
}
void I_UpdateSoundParams (int handle, int vol, int sep, int pitch)
{
    js_sfx_update (handle, vol, sep, pitch);
}

// --- music ---------------------------------------------------------------

// The engine registers/plays lumps; actual sample generation happens in
// mus_opl.c when JS pulls. One song at a time (matches the game).
static void* songdata;
static int songlen;
// What JS would have to reconstruct otherwise.  client/js/audio.js is created
// AFTER callMain, so it never saw the boot-time I_SetMusicVolume and
// I_PlaySong; it reads the state instead of replaying events it missed.
static int songlooping;
static int songpaused;
static int songvol = 127;

void I_InitMusic (void)
{
    mus_init (44100); // JS re-inits with the real AudioContext rate
}

EMSCRIPTEN_KEEPALIVE void web_music_init (int samplerate)
{
    mus_init (samplerate);
}

void I_ShutdownMusic (void)
{
    mus_stop ();
}

void I_SetMusicVolume (int volume) // menu slider 0..15
{
    songvol = volume * 127 / 15;
    mus_setvolume (songvol);
    js_music_event (4, 0, 0, songvol);
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
    songlooping = looping;
    songpaused = 0;
    mus_play (songdata, songlen, looping);
    js_music_event (1, songdata, songlen, looping);
}

void I_PauseSong (int handle)
{
    (void) handle;
    songpaused = 1;
    mus_pause (1);
    js_music_event (2, 0, 0, 0);
}
void I_ResumeSong (int handle)
{
    (void) handle;
    songpaused = 0;
    mus_pause (0);
    js_music_event (3, 0, 0, 0);
}

void I_StopSong (int handle)
{
    (void) handle;
    mus_stop ();
    js_music_event (0, 0, 0, 0);
}

// The music state a second synth needs to reach this one's: seven ints into
// `out`, which must have room for them.  GENMIDI comes back as a pointer into
// the zone (load_bank already cached it PU_STATIC), and the song as the
// pointer I_RegisterSong was handed -- valid until I_UnRegisterSong, i.e.
// while the lump is still PU_MUSIC.
//   0 genmidi ptr   1 genmidi len   2 song ptr   3 song len
//   4 looping       5 paused        6 volume (0..127)
EMSCRIPTEN_KEEPALIVE void web_music_state (int* out)
{
    int lump = W_CheckNumForName ("GENMIDI");
    out[0] =
        lump >= 0 ? (int) (size_t) W_CacheLumpName ("GENMIDI", PU_STATIC) : 0;
    out[1] = lump >= 0 ? W_LumpLength (lump) : 0;
    out[2] = (int) (size_t) songdata;
    out[3] = songlen;
    out[4] = songlooping;
    out[5] = songpaused;
    out[6] = songvol;
}

void I_UnRegisterSong (int handle)
{
    (void) handle;
    songdata = 0;
}
