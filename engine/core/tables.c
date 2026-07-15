// Emacs style mode select   -*- C++ -*-
//-----------------------------------------------------------------------------
//
// Copyright (C) 1993-1996 by id Software, Inc.
// Copyright (C) 2026 webdoom, GPL-2.0-or-later
//
// DESCRIPTION:
//	Lookup tables — regenerated at boot instead of shipped as data.
//
//	id's 1992 table generator truncated (not rounded) and its libm
//	disagreed with modern math libraries in the last bit here and
//	there: 5,377 of the 10,240 finesine entries differ from ideal
//	round-to-nearest, and every one of those "errors" is canon —
//	demos and netplay depend on each wrong bit.
//
//	So the tables are rebuilt from the reverse-engineered recipes
//	(truncate toward zero, (i+0.5) phase for sine/tangent), then a
//	packed 2-bit delta stream (tables_fix.h, generated against this
//	exact toolchain by tools/gen-tables.mjs) replays the historical
//	error field on top, and an FNV-1a checksum proves the result is
//	bit-identical to the 1993 originals. 64KB of frozen data becomes
//	~4KB of corrections; a toolchain that computes differently fails
//	the checksum loudly at boot instead of desyncing quietly.
//
//-----------------------------------------------------------------------------

#include <math.h>

#include "tables.h"
#include "i_system.h"

fixed_t		finesine[5*FINEANGLES/4];
fixed_t		finetangent[FINEANGLES/2];
angle_t		tantoangle[SLOPERANGE+1];

#include "tables_fix.h"

//
// SlopeDiv (vanilla, untouched)
//
int
SlopeDiv
( unsigned	num,
  unsigned	den)
{
    unsigned 	ans;

    if (den < 512)
	return SLOPERANGE;

    ans = (num<<3)/(den>>8);

    return ans <= SLOPERANGE ? ans : SLOPERANGE;
}

// packed 2-bit deltas: 0 = +0, 1 = +1, 2 = -1, 3 = escape (full value
// from the escape list, for the tangent asymptote entries)
static void T_ApplyFix (int* table, int count,
			const unsigned char* packed,
			const int* escapes, int numescapes)
{
    int i, e = 0;

    for (i = 0; i < count; i++)
    {
	switch ((packed[i >> 2] >> ((i & 3) * 2)) & 3)
	{
	  case 1: table[i] += 1; break;
	  case 2: table[i] -= 1; break;
	  case 3:
	    if (e < numescapes)
		table[i] = escapes[e++];
	    break;
	}
    }
}

static unsigned T_Checksum (void)
{
    unsigned h = 0x811c9dc5u;
    int i;

    for (i = 0; i < 5*FINEANGLES/4; i++)
	h = (h ^ (unsigned) finesine[i]) * 0x01000193u;
    for (i = 0; i < FINEANGLES/2; i++)
	h = (h ^ (unsigned) finetangent[i]) * 0x01000193u;
    for (i = 0; i <= SLOPERANGE; i++)
	h = (h ^ (unsigned) tantoangle[i]) * 0x01000193u;
    return h;
}

void T_GenerateTables (void)
{
    int i;

    // sine: one and a quarter turns, truncated, (i+0.5) phase
    for (i = 0; i < 5*FINEANGLES/4; i++)
	finesine[i] = (fixed_t)
	    (sin (((double)i + 0.5) * 2.0 * M_PI / 8192.0) * 65536.0);

    // tangent: half turn centered on the asymptote
    for (i = 0; i < FINEANGLES/2; i++)
	finetangent[i] = (fixed_t)
	    (tan (((double)i - 2048.0 + 0.5) * 2.0 * M_PI / 8192.0) * 65536.0);

    // arctangent: first octant in BAM angle units
    for (i = 0; i <= SLOPERANGE; i++)
	tantoangle[i] = (angle_t) (long long)
	    (atan (((double)i) / 2048.0) / (2.0 * M_PI) * 4294967296.0);

    T_ApplyFix ((int*) finesine, 5*FINEANGLES/4,
		fix_finesine, fix_finesine_esc, FIX_FINESINE_NESC);
    T_ApplyFix ((int*) finetangent, FINEANGLES/2,
		fix_finetangent, fix_finetangent_esc, FIX_FINETANGENT_NESC);
    T_ApplyFix ((int*) tantoangle, SLOPERANGE+1,
		fix_tantoangle, fix_tantoangle_esc, FIX_TANTOANGLE_NESC);

#ifdef TABLES_CRC
    if (T_Checksum () != TABLES_CRC)
	I_Error ("T_GenerateTables: tables differ from 1993 canon "
		 "(toolchain libm changed?) — regenerate tables_fix.h");
#endif
}
