// tools/n64/i_sound_n64.c — N64 audio stub.
//
// Audio is out of scope for 20.4b (software render boot).
// All stubs return silently; the engine compiles and runs without sound.
// Future task: wire libdragon's audio subsystem for OPL/MUS playback.
//
// Engine/core: 0-diff.  Only tools/n64/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include "doomtype.h"
#include "i_sound.h"

void I_InitSound(void) {}
void I_SetChannels(void) {}
void I_ShutdownSound(void) {}
void I_ShutdownMusic(void) {}
int  I_GetSfxLumpNum(sfxinfo_t* sfx) { (void)sfx; return -1; }
void I_UpdateSound(void) {}
void I_SubmitSound(void) {}
void I_UpdateSoundParams(int handle, int vol, int sep, int pitch)
    { (void)handle; (void)vol; (void)sep; (void)pitch; }
int  I_StartSound(int id, int vol, int sep, int pitch, int priority)
    { (void)id; (void)vol; (void)sep; (void)pitch; (void)priority; return -1; }
void I_StopSound(int handle) { (void)handle; }
int  I_SoundIsPlaying(int handle) { (void)handle; return 0; }
void I_InitMusic(void) {}
void I_PlaySong(int handle, int looping) { (void)handle; (void)looping; }
void I_PauseSong(int handle) { (void)handle; }
void I_ResumeSong(int handle) { (void)handle; }
void I_StopSong(int handle) { (void)handle; }
void I_UnRegisterSong(int handle) { (void)handle; }
int  I_RegisterSong(void* data, int len) { (void)data; (void)len; return 0; }
int  I_QrySongPlaying(int handle) { (void)handle; return 0; }
void I_SetMusicVolume(int volume) { (void)volume; }

// mus_* stubs (web.h interface used by i_sound.c in engine):
void mus_init(int samplerate)        { (void)samplerate; }
void mus_play(void* d, int l, int p) { (void)d; (void)l; (void)p; }
void mus_stop(void)                  {}
void mus_pause(int p)                { (void)p; }
void mus_setvolume(int v)            { (void)v; }
