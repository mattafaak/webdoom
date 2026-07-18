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
// $Log:$
//
// DESCRIPTION:
//	Endianess handling, swapping 16bit and 32bit.
//
//-----------------------------------------------------------------------------

static const char
rcsid[] = "$Id: m_bbox.c,v 1.1 1997/02/03 22:45:10 b1 Exp $";


#ifdef __GNUG__
#pragma implementation "m_swap.h"
#endif
#include "m_swap.h"


// Not needed with big endian.
#ifndef __BIG_ENDIAN__

// Swap 16bit, that is, MSB and LSB byte.
unsigned short SwapSHORT(unsigned short x)
{
    // No masking with 0xFF should be necessary.
    return (x>>8) | (x<<8);
}

// Swapping 32bit.
unsigned long SwapLONG( unsigned long x)
{
    return
	(x>>24)
	| ((x>>8) & 0xff00)
	| ((x<<8) & 0xff0000)
	| (x<<24);
}


#else /* __BIG_ENDIAN__ — byte-swap WAD LE data to native BE order */

/* WAD data is stored little-endian.  On a big-endian CPU the C compiler
 * reads multi-byte fields with the byte order reversed, so we must swap
 * them to recover the true LE value.  These functions are called via the
 * SHORT()/LONG() macros defined in m_swap.h whenever __BIG_ENDIAN__ is set.
 * Dead code on LE: the macros expand to identity there (9.2b verified). */
short SwapSHORT(short x)
{
    unsigned short v = (unsigned short)x;
    return (short)((v >> 8) | (v << 8));
}

long SwapLONG(long x)
{
    unsigned long v = (unsigned long)x;
    return (long)(  ((v >> 24) & 0xffUL)
                  | ((v >>  8) & 0xff00UL)
                  | ((v <<  8) & 0xff0000UL)
                  | ((v << 24) & 0xff000000UL));
}

#endif /* __BIG_ENDIAN__ */


