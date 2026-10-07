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
//	Refresh/render internal state variables (global).
//
//-----------------------------------------------------------------------------


#ifndef __R_STATE__
#define __R_STATE__

// Need data structure definitions.
#include "d_player.h"
#include "r_data.h"



#ifdef __GNUG__
#pragma interface
#endif



//
// Refresh internal data structures,
//  for rendering.
//

// needed for texture pegging
extern fixed_t*		textureheight;

// needed for pre rendering (fracs)
extern fixed_t*		spritewidth;

extern fixed_t*		spriteoffset;
extern fixed_t*		spritetopoffset;

extern lighttable_t*	colormaps;

extern int		viewwidth;
extern int		scaledviewwidth;
extern int		viewheight;

extern int		firstflat;

// for global animation
extern int*		flattranslation;	
extern int*		texturetranslation;	


// Sprite....
extern int		firstspritelump;
extern int		lastspritelump;
extern int		numspritelumps;



//
// Lookup tables for map data.
//
extern int		numsprites;
extern spritedef_t*	sprites;

extern int		numvertexes;
extern vertex_t*	vertexes;

extern int		numsegs;
extern seg_t*		segs;

extern int		numsectors;
extern sector_t*	sectors;

extern int		numsubsectors;
extern subsector_t*	subsectors;

extern int		numnodes;
extern node_t*		nodes;

extern int		numlines;
extern line_t*		lines;

extern int		numsides;
extern side_t*		sides;

#ifdef LEAN_LEVELS
// webdoom LEAN_LEVELS (r_defs.h): a seg's back sector as vanilla's P_LoadSegs
// set it.  One-sided by the map: none.  Two-sided: the linedef's other side's
// sector, and a seg on side 0 of a line with no side 1 gets P_NullSector's
// (p_setup.c, set up by every P_LoadSegs).  A side 1 implies a side 0, which
// P_LoadLineDefs requires.
extern sector_t*	p_nullsector;

static __inline__ sector_t* P_SegBackSector (seg_t* s)
{
    line_t*	l = &lines[s->linedefi];

    if (!l->twosided)
	return NULL;
    if (s->side)
	return l->frontsector;
    return l->backsector ? l->backsector : p_nullsector;
}

// A line's bounding box, from its vertices as P_LoadLineDefs fills vanilla's
// (the lesser and greater of each coordinate).  i is a constant at every use.
#include "m_bbox.h"

static __inline__ fixed_t P_LineBBox (line_t* l, int i)
{
    vertex_t*	a = LINE_V1 (l);
    vertex_t*	b = LINE_V2 (l);
    short	p = i == BOXLEFT || i == BOXRIGHT ? a->x16 : a->y16;
    short	q = i == BOXLEFT || i == BOXRIGHT ? b->x16 : b->y16;

    if (i == BOXLEFT || i == BOXBOTTOM)
	return (fixed_t) (p < q ? p : q) << FRACBITS;
    return (fixed_t) (p < q ? q : p) << FRACBITS;
}
#endif


//
// POV data.
//
extern fixed_t		viewx;
extern fixed_t		viewy;
extern fixed_t		viewz;

extern angle_t		viewangle;
extern player_t*	viewplayer;


// ?
extern angle_t		clipangle;

extern int		viewangletox[FINEANGLES/2];
extern angle_t		xtoviewangle[SCREENWIDTH+1];
//extern fixed_t		finetangent[FINEANGLES/2];

extern fixed_t		rw_distance;
extern angle_t		rw_normalangle;



// angle to line origin
extern int		rw_angle1;

// Segs count?
extern int		sscount;

extern visplane_t*	floorplane;
extern visplane_t*	ceilingplane;


#endif
//-----------------------------------------------------------------------------
//
// $Log:$
//
//-----------------------------------------------------------------------------
