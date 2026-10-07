// tools/freestanding/fs_audio.h — the freestanding platform's audio: the OPL
// music synth and the sound-effect mixer rendered inside every tic, and the
// floor log's AUDIO line.  See fs_audio.c.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef FS_AUDIO_H
#define FS_AUDIO_H

#include "floor_log.h"

#define FS_AUDIO_RATE 49716 // the OPL chip's own rate: no resampling of music

int fs_audio_on (void);      // 0 when WD_AUDIO=0 (or before fs_audio_init)
void fs_audio_init (void);   // I_InitSound: reads WD_AUDIO, arms the synth
void fs_audio_update (void); // I_UpdateSound: render the tics gametic passed

// what the platform's I_ functions report, for the counts and the trace
void fs_audio_sfx_started (int id, int vol, int sep, int pitch, int handle);
void fs_audio_music_event (const char* what, const char* name, int arg);

// The AUDIO line (all zero with audio off), and WD_AUDIO_TRACE's file.  Called
// after the demo, from i_main.c's floor log.
void fs_audio_floor (floor_audio_t* a);

#endif
