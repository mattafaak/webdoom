// tools/rp2040/i_sound_rp2040.c — RP2040 sound shim (silent headless build).
//
// All audio functions are no-ops: the RP2040 footprint build does not include
// OPL/MUS playback.  This is consistent with the freestanding rung-1 shim
// (tools/freestanding/i_sound.c) which also stubs all audio.
//
// For a real port: add PWM or I2S audio output via pico-sdk.
// Engine/core: 0-diff.  Only tools/rp2040/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include "i_sound.h"
#include "web.h"

void I_InitSound(void) {}
void I_ShutdownSound(void) {}
void I_SetChannels(void) {}
int  I_GetSfxLumpNum(sfxinfo_t* sfx) { (void)sfx; return -1; }
void I_UpdateSoundParams(int handle, int vol, int sep, int pitch) { (void)handle; (void)vol; (void)sep; (void)pitch; }
int  I_StartSound(int id, int vol, int sep, int pitch, int priority) { (void)id; (void)vol; (void)sep; (void)pitch; (void)priority; return -1; }
void I_StopSound(int handle) { (void)handle; }
int  I_SoundIsPlaying(int handle) { (void)handle; return 0; }
void I_UpdateSound(void) {}
void I_SubmitSound(void) {}
void I_InitMusic(void) {}
void I_ShutdownMusic(void) {}
void I_SetMusicVolume(int volume) { (void)volume; }
void I_PauseSong(int handle) { (void)handle; }
void I_ResumeSong(int handle) { (void)handle; }
int  I_RegisterSong(void* data, int len) { (void)data; (void)len; return -1; }
void I_PlaySong(int handle, int looping) { (void)handle; (void)looping; }
void I_StopSong(int handle) { (void)handle; }
void I_UnRegisterSong(int handle) { (void)handle; }

// MUS sequencer stubs (web.h surface)
void mus_init(int samplerate) { (void)samplerate; }
void mus_play(void* data, int len, int loop) { (void)data; (void)len; (void)loop; }
void mus_stop(void) {}
void mus_pause(int pause) { (void)pause; }
void mus_setvolume(int vol127) { (void)vol127; }
