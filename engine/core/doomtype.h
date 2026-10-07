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
//	Simple basic typedefs, isolated here to make it easier
//	 separating modules.
//    
//-----------------------------------------------------------------------------


#ifndef __DOOMTYPE__
#define __DOOMTYPE__


#ifndef __BYTEBOOL__
#define __BYTEBOOL__
// Fixed to use builtin bool type with C++.
#ifdef __cplusplus
typedef bool boolean;
#else
// webdoom: <stdbool.h> may already be in scope via system headers.
#undef false
#undef true
typedef enum {false, true} boolean;
#endif
typedef unsigned char byte;
#endif

// webdoom: the structs that are read straight out of a lump (a patch, the map
// records, the WAD header and directory).  With WEB_LUMPS_IN_PLACE a lump is
// read where it lies in the WAD, at whatever offset the WAD gave it, so these
// are byte-aligned and the compiler reads their fields in a way a
// strict-alignment CPU (Cortex-M0+) accepts.  Their layout is unchanged: every
// field already sits at its natural offset.  Off, this is nothing at all.
#ifdef WEB_LUMPS_IN_PLACE
#define LUMP_PACKED	__attribute__ ((packed))
#else
#define LUMP_PACKED
#endif


// Predefined with some OS.
#ifdef LINUX
/* webdoom: <values.h> is obsolete; MAXINT defined below */
#else
#define MAXCHAR		((char)0x7f)
#define MAXSHORT	((short)0x7fff)

// Max pos 32-bit int.
#define MAXINT		((int)0x7fffffff)	
#define MAXLONG		((long)0x7fffffff)
#define MINCHAR		((char)0x80)
#define MINSHORT	((short)0x8000)

// Max negative 32-bit integer.
#define MININT		((int)0x80000000)	
#define MINLONG		((long)0x80000000)
#endif




#endif
//-----------------------------------------------------------------------------
//
// $Log:$
//
//-----------------------------------------------------------------------------
