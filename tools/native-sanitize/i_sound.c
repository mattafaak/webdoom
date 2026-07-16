// native-sanitize i_sound.c — all-no-op sound/music stubs for headless runs.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <string.h>

#include "doomdef.h"
#include "sounds.h"
#include "i_sound.h"
#include "w_wad.h"

// ── MUS+OPL sequencer stubs (declared in web.h) ──────────────────────────────
void mus_init      (int samplerate) { (void) samplerate; }
void mus_play      (void* data, int len, int loop) { (void) data; (void) len; (void) loop; }
void mus_stop      (void) {}
void mus_pause     (int pause) { (void) pause; }
void mus_setvolume (int vol127) { (void) vol127; }

// ── I_Sound interface ─────────────────────────────────────────────────────────
void I_InitSound   (void) { I_InitMusic (); }
void I_UpdateSound (void) {}
void I_SubmitSound (void) {}
void I_ShutdownSound (void) {}
void I_SetChannels  (void) {}

int I_GetSfxLumpNum (sfxinfo_t* sfx)
{
    char namebuf[9];
    sprintf (namebuf, "ds%s", sfx->name);
    return W_CheckNumForName (namebuf);
}

int I_StartSound (int id, int vol, int sep, int pitch, int priority)
{
    (void) id; (void) vol; (void) sep; (void) pitch; (void) priority;
    return 0;
}

void I_StopSound  (int handle)       { (void) handle; }
int  I_SoundIsPlaying (int handle)   { (void) handle; return 0; }
void I_UpdateSoundParams (int handle, int vol, int sep, int pitch)
{
    (void) handle; (void) vol; (void) sep; (void) pitch;
}

// ── I_Music interface ─────────────────────────────────────────────────────────
void I_InitMusic     (void)   {}
void I_ShutdownMusic (void)   {}
void I_SetMusicVolume (int v) { (void) v; }
void I_PauseSong  (int handle) { (void) handle; }
void I_ResumeSong (int handle) { (void) handle; }

int I_RegisterSong (void* data, int len) { (void) data; (void) len; return 0; }
void I_PlaySong   (int handle, int looping) { (void) handle; (void) looping; }
void I_StopSong   (int handle)    { (void) handle; }
void I_UnRegisterSong (int handle){ (void) handle; }
