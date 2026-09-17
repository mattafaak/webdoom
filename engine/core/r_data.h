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
//  Refresh module, data I/O, caching, retrieval of graphics
//  by name.
//
//-----------------------------------------------------------------------------


#ifndef __R_DATA__
#define __R_DATA__

#include "w_wad.h"
#include "z_zone.h"
#include "r_defs.h"
#include "r_state.h"

#ifdef __GNUG__
#pragma interface
#endif

// Retrieve column data for span blitting.
//
// NC3 (round 11): the single-patch case -- the common one -- is inlined here
// so the per-column call in R_RenderSegLoop becomes three array loads and a
// W_CacheLumpNum.  The multi-patch case stays out of line because
// R_GenerateComposite is private to r_data.c.
extern int*             texturewidthmask;
extern short**          texturecolumnlump;
extern unsigned short** texturecolumnofs;

byte* R_GetColumnComposite (int tex, int ofs);

static inline byte* R_GetColumn (int tex, int col)
{
    int lump, ofs;
    col &= texturewidthmask[tex];
    lump = texturecolumnlump[tex][col];
    ofs  = texturecolumnofs[tex][col];
    if (lump > 0)
        return (byte*) W_CacheLumpNum (lump, PU_CACHE) + ofs;
    return R_GetColumnComposite (tex, ofs);
}


// I/O, setting up the stuff.
void R_InitData (void);
void R_PrecacheLevel (void);


// Retrieval.
// Floor/ceiling opaque texture tiles,
// lookup by name. For animation?
int R_FlatNumForName (char* name);


// Called by P_Ticker for switches and animations,
// returns the texture number for the texture name.
int R_TextureNumForName (char *name);
int R_CheckTextureNumForName (char *name);

#endif
//-----------------------------------------------------------------------------
//
// $Log:$
//
//-----------------------------------------------------------------------------
