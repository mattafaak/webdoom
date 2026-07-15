// Emacs style mode select   -*- C++ -*- 
//-----------------------------------------------------------------------------
//
// $Id:$
//
// Copyright (C) 1993-1996 by id Software, Inc.
//
// This source is available for distribution and/or modification
// only under the terms of the DOOM Source Code License as
// published by id Software. All rights reserved.
//
// The source is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// FITNESS FOR A PARTICULAR PURPOSE. See the DOOM Source Code License
// for more details.
//
// DESCRIPTION:
//	Fixed point arithemtics, implementation.
//
//-----------------------------------------------------------------------------


#ifndef __M_FIXED__
#define __M_FIXED__

// webdoom: FixedMul/FixedDiv are inline here, so the header carries its
// own deps (abs, MININT/MAXINT) instead of relying on include order.
#include <stdlib.h>
#include "doomtype.h"


//
// Fixed point, 32bit as 16.16.
//
#define FRACBITS		16
#define FRACUNIT		(1<<FRACBITS)

typedef int fixed_t;

// webdoom: the two hottest ops in the engine (170 call sites, densest in
// the per-column renderer loops) are static inline here so every site
// inlines — no call/return overhead, operands stay in registers. Both
// are bit-identical to vanilla:
//   FixedMul  — the linuxdoom int64 form, unchanged.
//   FixedDiv  — the integer form, PROVEN equal to linuxdoom's double path
//               over the guarded domain (docs/engine-archaeology.md §2:
//               boundary images are exactly representable, round-to-
//               nearest can't cross them; 2.5e9 samples, zero mismatches).
//               It is by construction the value the 1993 DOS exe produced,
//               and one i64 idiv instead of convert/f64-divide/convert.
//               The overflow clamp is canon behaviour and stays.

static inline fixed_t FixedMul (fixed_t a, fixed_t b)
{
    return (fixed_t) (((long long) a * (long long) b) >> FRACBITS);
}

static inline fixed_t FixedDiv (fixed_t a, fixed_t b)
{
    if ((abs(a) >> 14) >= abs(b))
	return (a ^ b) < 0 ? MININT : MAXINT;
    return (fixed_t) (((long long) a << FRACBITS) / b);
}



#endif
//-----------------------------------------------------------------------------
//
// $Log:$
//
//-----------------------------------------------------------------------------
