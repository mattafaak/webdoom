// tools/freestanding/sfx_mix.h — the reference sound-effect mixer for the
// freestanding platform: 8 channels of 8-bit DMX samples, integer only.
// See sfx_mix.c for the arithmetic, which is the contract.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef FS_SFX_MIX_H
#define FS_SFX_MIX_H

#define SFX_CHANNELS 8

// out_rate: the output rate in Hz (49,716 on the floor: the OPL chip's own)
void sfx_mix_init (int out_rate);

// Start a DMX lump (format 3: u16 3, u16 rate, u32 length, 16 pad bytes,
// samples, 16 pad bytes) at vanilla 1.9 volume (0..127) and separation
// (0..255, 128 centre).  The lump is read in place for as long as the sound
// plays, never written.  Returns a handle > 0, or 0 when the lump is not a
// sound DMX would play.
int sfx_mix_start (const unsigned char* lump, int lumplen, int vol, int sep);
void sfx_mix_stop (int handle);
int sfx_mix_playing (int handle);
void sfx_mix_update (int handle, int vol, int sep);
int sfx_mix_live (void); // channels playing now

// Mix the next `frames` frames into out[] (interleaved L R, int16, written,
// not added); channels whose sound ends are freed.
void sfx_mix_render (short* out, int frames);

#endif
