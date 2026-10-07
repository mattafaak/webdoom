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
//	WAD I/O functions.
//
//-----------------------------------------------------------------------------


#ifndef __W_WAD__
#define __W_WAD__


#ifdef __GNUG__
#pragma interface
#endif

#include "doomtype.h"	// LUMP_PACKED


//
// TYPES
//
typedef struct
{
    // Should be "IWAD" or "PWAD".
    char		identification[4];		
    int			numlumps;
    int			infotableofs;
    
} LUMP_PACKED wadinfo_t;


typedef struct
{
    int			filepos;
    int			size;
    char		name[8];
    
} LUMP_PACKED filelump_t;

//
// WADFILE I/O related stuff.
//
typedef struct
{
    char	name[8];
    int		handle;
    int		position;
    int		size;
} lumpinfo_t;


extern	void**		lumpcache;
extern	lumpinfo_t*	lumpinfo;
extern	int		numlumps;

void    W_InitMultipleFiles (char** filenames);
void    W_Reload (void);

int	W_CheckNumForName (char* name);
int	W_GetNumForName (char* name);

int	W_LumpLength (int lump);
void    W_ReadLump (int lump, void *dest);

void*	W_CacheLumpNum (int lump, int tag);
void*	W_CacheLumpName (char* name, int tag);


//
// webdoom: lumps read in place (WEB_LUMPS_IN_PLACE, a compile-time opt-in).
//
// A platform whose WAD sits in memory that is mapped, readable and never
// moves -- flash on a microcontroller, a blob loaded once -- defines
// WEB_LUMPS_IN_PLACE and implements W_WebFileInPlace.  W_AddFile asks it of
// every file it adds; for a file it says yes to, W_CacheLumpNum returns a
// pointer straight into the WAD instead of a zone copy, whatever the tag.
// Such a lump never enters lumpcache[] and never costs the zone a byte:
//   - the engine never writes a lump (the ro-wad leg runs with the WAD
//     mprotect'd);
//   - Z_Free and Z_ChangeTag leave a pointer into an in-place file alone
//     (z_zone.c);
//   - a lump can start at any offset, so every multi-byte read of one is
//     byte-safe (LUMP_PACKED in doomtype.h, LUMP_LONG in m_swap.h);
//   - the few lumps that need a copy of their own still get one: COLORMAP
//     (256-byte aligned in the zone), a REJECT shorter than the map needs, a
//     BLOCKMAP the playsim cannot read as it lies (p_setup.c), GENMIDI (copied
//     into the synth's bank).
// Off (the shipped wasm build), every macro below is empty or vanilla's code.
//
#ifdef WEB_LUMPS_IN_PLACE
// The platform: nonzero if `data` (the `length` bytes W_WebFile returned for
// `filename`) and every lump its directory names stay mapped, readable and
// unmoved for the rest of the run.
int	W_WebFileInPlace (char* filename, unsigned char* data, int length);
void	W_AddInPlace (char* filename, unsigned char* data, int length,
		      filelump_t* fileinfo, int startlump);
// the lump's bytes in the WAD if its file is read in place, else NULL
void*	W_LumpInPlace (int lump);
// nonzero if p points into a file read in place
int	W_IsInPlace (const void* p);
#define W_ADD_IN_PLACE(f,d,n,fi,s)	W_AddInPlace (f, d, n, fi, s)
#define W_RETURN_IN_PLACE(lump)	\
    { void* in_place = W_LumpInPlace (lump); if (in_place) return in_place; }
#else
#define W_ADD_IN_PLACE(f,d,n,fi,s)
#define W_RETURN_IN_PLACE(lump)
#endif




#endif
//-----------------------------------------------------------------------------
//
// $Log:$
//
//-----------------------------------------------------------------------------
