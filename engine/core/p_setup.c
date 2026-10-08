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
//	Do all the WAD I/O, get map description,
//	set up initial state and misc. LUTs.
//
//-----------------------------------------------------------------------------

static const char
rcsid[] = "$Id: p_setup.c,v 1.5 1997/02/03 22:45:12 b1 Exp $";


#include <math.h>

#include "z_zone.h"

#include "m_swap.h"
#include "m_bbox.h"

#include "g_game.h"

#include "i_system.h"
#include "w_wad.h"

#include "doomdef.h"
#include "p_local.h"

#include "s_sound.h"

#include "doomstat.h"


void	P_SpawnMapThing (mapthing_t*	mthing);


//
// MAP related Lookup tables.
// Store VERTEXES, LINEDEFS, SIDEDEFS, etc.
//
int		numvertexes;
vertex_t*	vertexes;

int		numsegs;
seg_t*		segs;

int		numsectors;
sector_t*	sectors;

int		numsubsectors;
subsector_t*	subsectors;

int		numnodes;
node_t*		nodes;

int		numlines;
line_t*		lines;

int		numsides;
side_t*		sides;


// BLOCKMAP
// Created from axis aligned bounding box
// of the map, a rectangular array of
// blocks of size ...
// Used to speed up collision detection
// by spatial subdivision in 2D.
//
// Blockmap size.
int		bmapwidth;
int		bmapheight;	// size in mapblocks
short*		blockmap;	// int for larger maps
// offsets in blockmap are from here
short*		blockmaplump;		
// origin of block map
fixed_t		bmaporgx;
fixed_t		bmaporgy;
// for thing chains
mobj_t**	blocklinks;		


// REJECT
// For fast sight rejection.
// Speeds up enemy AI by skipping detailed
//  LineOf Sight calculation.
// Without special effect, this could be
//  used as a PVS lookup as well.
//
byte*		rejectmatrix;


// Maintain single and multi player starting spots.
#define MAX_DEATHMATCH_STARTS	10

mapthing_t	deathmatchstarts[MAX_DEATHMATCH_STARTS];
mapthing_t*	deathmatch_p;
mapthing_t	playerstarts[MAXPLAYERS];


#ifdef LEAN_LEVELS
//
// P_LevelShorts
// webdoom LEAN_LEVELS (r_defs.h): a map lump made of 16-bit fields (VERTEXES,
// SEGS, NODES) as an array of them in host order, which nothing writes: the
// lump itself where it lies in place (w_wad.h) at an even address on a host
// whose SHORT() changes nothing, else a PU_LEVEL copy, swapped.  The in-RAM
// types are the records' own layouts (checked here).
//
typedef char p_vertex_is_its_record[sizeof(vertex_t) == sizeof(mapvertex_t) ? 1 : -1];
typedef char p_seg_is_its_record[sizeof(seg_t) == sizeof(mapseg_t) ? 1 : -1];
typedef char p_node_is_its_record[sizeof(node_t) == sizeof(mapnode_t) ? 1 : -1];

static void* P_LevelShorts (int lump)
{
    short*	p;
    int		i;
    int		len = W_LumpLength (lump);

#ifdef WEB_LUMPS_IN_PLACE
    p = W_LumpInPlace (lump);
    if (p && !((size_t) p & 1) && SHORT ((short) 0x0102) == 0x0102)
	return p;
#endif
    p = Z_Malloc (len, PU_LEVEL, 0);
    W_ReadLump (lump, p);
    for (i=0 ; i<len/2 ; i++)
	p[i] = SHORT (p[i]);
    return p;
}

sector_t*	p_nullsector;	// SEG_BACK's (r_state.h), set by P_LoadSegs
#endif


//
// P_LoadVertexes
//
void P_LoadVertexes (int lump)
{
    byte*		data;
    int			i;
    mapvertex_t*	ml;
    vertex_t*		li;

    // Determine number of lumps:
    //  total lump length / vertex record length.
    numvertexes = W_LumpLength (lump) / sizeof(mapvertex_t);
#ifdef LEAN_LEVELS
    vertexes = P_LevelShorts (lump);	// read as they lie
#else

    // Allocate zone memory for buffer.
    vertexes = Z_Malloc (numvertexes*sizeof(vertex_t),PU_LEVEL,0);	

    // Load data into cache.
    data = W_CacheLumpNum (lump,PU_STATIC);
	
    ml = (mapvertex_t *)data;
    li = vertexes;

    // Copy and convert vertex coordinates,
    // internal representation as fixed.
    for (i=0 ; i<numvertexes ; i++, li++, ml++)
    {
	li->x = SHORT(ml->x)<<FRACBITS;
	li->y = SHORT(ml->y)<<FRACBITS;
    }

    // Free buffer memory.
    Z_Free (data);
#endif
}



//
// P_NullSector
// The back of a two-sided linedef with no back side, the "glass hack"
// impassable window (OTTAWAU.WAD).  Vanilla read sides[-1].sector, which in
// DOS was memory at address 0; this is the sector Chocolate Doom builds from
// that memory under DOS 6.22, its default: zero but for the two heights.
// webdoom: segs get it here, and a hitscan or aim crossing such a line reads
// it as the line's back sector (PTR_AimTraverse, PTR_ShootTraverse).
//
sector_t* P_NullSector (void)
{
    static sector_t	null_sector;

    memset (&null_sector, 0, sizeof(null_sector));
    null_sector.floorheight = null_sector.oldfloorheight = 0x00199257;
    null_sector.ceilingheight = null_sector.oldceilingheight = 0x007006f4;
    return &null_sector;
}


//
// P_LoadSegs
//
void P_LoadSegs (int lump)
{
    byte*		data;
    int			i;
    mapseg_t*		ml;
    seg_t*		li;
    line_t*		ldef;
    int			linedef;
    int			side;
	
    numsegs = W_LumpLength (lump) / sizeof(mapseg_t);
#ifdef LEAN_LEVELS
    // read as they lie: the checks below, then nothing to convert
    segs = P_LevelShorts (lump);
    p_nullsector = P_NullSector ();
    for (i=0, li = segs ; i<numsegs ; i++, li++)
    {
	if (li->v1i < 0 || li->v1i >= numvertexes
	    || li->v2i < 0 || li->v2i >= numvertexes)
	    I_Error ("P_LoadSegs: seg %d has an out-of-range vertex", i);
	linedef = li->linedefi;
	if (linedef < 0 || linedef >= numlines)
	    I_Error ("P_LoadSegs: seg %d has out-of-range linedef %d", i, linedef);
	side = li->side;
	if (side != 0 && side != 1)
	    I_Error ("P_LoadSegs: seg %d has side %d", i, side);
	if (lines[linedef].sidenum[side] == -1)
	    I_Error ("P_LoadSegs: seg %d is on a missing side of linedef %d",
		     i, linedef);
    }
#else
    segs = Z_Malloc (numsegs*sizeof(seg_t),PU_LEVEL,0);	
    memset (segs, 0, numsegs*sizeof(seg_t));
    data = W_CacheLumpNum (lump,PU_STATIC);
	
    ml = (mapseg_t *)data;
    li = segs;
    for (i=0 ; i<numsegs ; i++, li++, ml++)
    {
	/* tenet-4 fail-soft: every index below selects an array element, and
	   a hostile map can name any short; refuse before the first use. */
	if (SHORT(ml->v1) < 0 || SHORT(ml->v1) >= numvertexes
	    || SHORT(ml->v2) < 0 || SHORT(ml->v2) >= numvertexes)
	    I_Error ("P_LoadSegs: seg %d has an out-of-range vertex", i);
	li->v1 = &vertexes[SHORT(ml->v1)];
	li->v2 = &vertexes[SHORT(ml->v2)];
					
	li->angle = (SHORT(ml->angle))<<16;
	li->offset = (SHORT(ml->offset))<<16;
	linedef = SHORT(ml->linedef);
	if (linedef < 0 || linedef >= numlines)
	    I_Error ("P_LoadSegs: seg %d has out-of-range linedef %d", i, linedef);
	ldef = &lines[linedef];
	li->linedef = ldef;
	side = SHORT(ml->side);
	if (side != 0 && side != 1)
	    I_Error ("P_LoadSegs: seg %d has side %d", i, side);
	if (ldef->sidenum[side] == -1)
	    I_Error ("P_LoadSegs: seg %d is on a missing side of linedef %d",
		     i, linedef);
	li->sidedef = &sides[ldef->sidenum[side]];
	li->frontsector = sides[ldef->sidenum[side]].sector;
	if (ldef-> flags & ML_TWOSIDED)
	    li->backsector = ldef->sidenum[side^1] == -1 ? P_NullSector ()
			     : sides[ldef->sidenum[side^1]].sector;
	else
	    li->backsector = 0;
    }
	
    Z_Free (data);
#endif

    // Subsectors load first, so their ranges are checked once segs exist.
    // P_GroupLines reads segs[firstline] even of an empty subsector.
    for (i=0 ; i<numsubsectors ; i++)
	if (subsectors[i].firstline < 0 || subsectors[i].numlines < 0
	    || subsectors[i].firstline >= numsegs
	    || subsectors[i].firstline + subsectors[i].numlines > numsegs)
	    I_Error ("P_LoadSegs: subsector %d has out-of-range segs %d+%d (0..%d)",
		     i, subsectors[i].firstline, subsectors[i].numlines,
		     numsegs - 1);
}


//
// P_LoadSubsectors
//
void P_LoadSubsectors (int lump)
{
    byte*		data;
    int			i;
    mapsubsector_t*	ms;
    subsector_t*	ss;
	
    numsubsectors = W_LumpLength (lump) / sizeof(mapsubsector_t);
    // a map with no nodes renders and locates everything in subsector 0
    if (numsubsectors < 1)
	I_Error ("P_LoadSubsectors: no subsectors");
    subsectors = Z_Malloc (numsubsectors*sizeof(subsector_t),PU_LEVEL,0);	
    data = W_CacheLumpNum (lump,PU_STATIC);
	
    ms = (mapsubsector_t *)data;
    memset (subsectors,0, numsubsectors*sizeof(subsector_t));
    ss = subsectors;
    
    for (i=0 ; i<numsubsectors ; i++, ss++, ms++)
    {
	ss->numlines = SHORT(ms->numsegs);
	ss->firstline = SHORT(ms->firstseg);
    }
	
    Z_Free (data);
}



//
// P_LoadSectors
//
void P_LoadSectors (int lump)
{
    byte*		data;
    int			i;
    mapsector_t*	ms;
    sector_t*		ss;
	
    numsectors = W_LumpLength (lump) / sizeof(mapsector_t);
    sectors = Z_Malloc (numsectors*sizeof(sector_t),PU_LEVEL,0);	
    memset (sectors, 0, numsectors*sizeof(sector_t));
    data = W_CacheLumpNum (lump,PU_STATIC);
	
    ms = (mapsector_t *)data;
    ss = sectors;
    for (i=0 ; i<numsectors ; i++, ss++, ms++)
    {
	ss->floorheight = SHORT(ms->floorheight)<<FRACBITS;
	ss->ceilingheight = SHORT(ms->ceilingheight)<<FRACBITS;
	ss->oldfloorheight = ss->floorheight;		// webdoom: no lerp streak
	ss->oldceilingheight = ss->ceilingheight;
	ss->floorpic = R_FlatNumForName(ms->floorpic);
	ss->ceilingpic = R_FlatNumForName(ms->ceilingpic);
	ss->lightlevel = SHORT(ms->lightlevel);
	ss->special = SHORT(ms->special);
	ss->tag = SHORT(ms->tag);
	ss->thinglist = NULL;
    }
	
    Z_Free (data);
}


//
// P_LoadNodes
//
void P_LoadNodes (int lump)
{
    byte*	data;
    int		i;
    int		j;
    int		k;
    mapnode_t*	mn;
    node_t*	no;
	
    numnodes = W_LumpLength (lump) / sizeof(mapnode_t);
#ifdef LEAN_LEVELS
    // read as they lie: the children's checks below, nothing to convert
    nodes = P_LevelShorts (lump);
    for (i=0, no = nodes ; i<numnodes ; i++, no++)
    {
	for (j=0 ; j<2 ; j++)
	{
#else
    nodes = Z_Malloc (numnodes*sizeof(node_t),PU_LEVEL,0);	
    data = W_CacheLumpNum (lump,PU_STATIC);
	
    mn = (mapnode_t *)data;
    no = nodes;
    
    for (i=0 ; i<numnodes ; i++, no++, mn++)
    {
	no->x = SHORT(mn->x)<<FRACBITS;
	no->y = SHORT(mn->y)<<FRACBITS;
	no->dx = SHORT(mn->dx)<<FRACBITS;
	no->dy = SHORT(mn->dy)<<FRACBITS;
	for (j=0 ; j<2 ; j++)
	{
	    no->children[j] = SHORT(mn->children[j]);
#endif
	    if (no->children[j] & NF_SUBSECTOR
		? (no->children[j] & ~NF_SUBSECTOR) >= numsubsectors
		: no->children[j] >= numnodes)
		I_Error ("P_LoadNodes: node %d has out-of-range child %d",
			 i, no->children[j]);
	    // webdoom: node builders write a node after its children, so a
	    // child node always has a lower index (true of every map in the
	    // library); a child at or above its parent can close a loop, which
	    // R_PointInSubsector would spin in and the BSP walks recurse into
	    if (!(no->children[j] & NF_SUBSECTOR) && no->children[j] >= i)
		I_Error ("P_LoadNodes: node %d has child node %d at or above it",
			 i, no->children[j]);
#ifndef LEAN_LEVELS
	    for (k=0 ; k<4 ; k++)
		no->bbox[j][k] = SHORT(mn->bbox[j][k])<<FRACBITS;
#endif
	}
    }
	
#ifndef LEAN_LEVELS
    Z_Free (data);
#endif
}


//
// P_LoadThings
//
void P_LoadThings (int lump)
{
    byte*		data;
    int			i;
    mapthing_t*		mt;
    int			numthings;
    boolean		spawn;
#ifdef WEB_LUMPS_IN_PLACE
    mapthing_t*		rec;
    mapthing_t		thing;
#endif
	
    data = W_CacheLumpNum (lump,PU_STATIC);
    numthings = W_LumpLength (lump) / sizeof(mapthing_t);
	
#ifdef WEB_LUMPS_IN_PLACE
    // webdoom: the lump may be the WAD itself (w_wad.h), which is never
    // written and can put a record at any offset: each thing is read
    // byte-safely into a copy, already in host byte order, and spawned from
    // that.  (Vanilla swapped each record over itself.)
    rec = (mapthing_t *)data;
    mt = &thing;
    for (i=0 ; i<numthings ; i++, rec++)
    {
	thing.x = read_le16 (&rec->x);
	thing.y = read_le16 (&rec->y);
	thing.angle = read_le16 (&rec->angle);
	thing.type = read_le16 (&rec->type);
	thing.options = read_le16 (&rec->options);
#else
    mt = (mapthing_t *)data;
    for (i=0 ; i<numthings ; i++, mt++)
    {
#endif
	spawn = true;

	// Do not spawn cool, new monsters if !commercial
	if ( gamemode != commercial)
	{
	    switch(mt->type)
	    {
	      case 68:	// Arachnotron
	      case 64:	// Archvile
	      case 88:	// Boss Brain
	      case 89:	// Boss Shooter
	      case 69:	// Hell Knight
	      case 67:	// Mancubus
	      case 71:	// Pain Elemental
	      case 65:	// Former Human Commando
	      case 66:	// Revenant
	      case 84:	// Wolf SS
		spawn = false;
		break;
	    }
	}
	if (spawn == false)
	    break;

	// Do spawn all other stuff. 
#ifndef WEB_LUMPS_IN_PLACE
	mt->x = SHORT(mt->x);
	mt->y = SHORT(mt->y);
	mt->angle = SHORT(mt->angle);
	mt->type = SHORT(mt->type);
	mt->options = SHORT(mt->options);
#endif
	
	P_SpawnMapThing (mt);
    }
	
    Z_Free (data);
}


//
// P_LoadLineDefs
// Also counts secret lines for intermissions.
//
void P_LoadLineDefs (int lump)
{
    byte*		data;
    int			i;
    maplinedef_t*	mld;
    line_t*		ld;
    vertex_t*		v1;
    vertex_t*		v2;
	
    numlines = W_LumpLength (lump) / sizeof(maplinedef_t);
    lines = Z_Malloc (numlines*sizeof(line_t),PU_LEVEL,0);	
    memset (lines, 0, numlines*sizeof(line_t));
    data = W_CacheLumpNum (lump,PU_STATIC);
	
    mld = (maplinedef_t *)data;
    ld = lines;
    for (i=0 ; i<numlines ; i++, mld++, ld++)
    {
	ld->flags = SHORT(mld->flags);
	ld->special = SHORT(mld->special);
	ld->tag = SHORT(mld->tag);
	if (SHORT(mld->v1) < 0 || SHORT(mld->v1) >= numvertexes
	    || SHORT(mld->v2) < 0 || SHORT(mld->v2) >= numvertexes)
	    I_Error ("P_LoadLineDefs: linedef %d has an out-of-range vertex", i);
#ifdef LEAN_LEVELS
	// dx, dy and bbox are derived from the vertices where they are used
	// (r_defs.h); the slope type is vanilla's, from the same dx and dy
	ld->v1i = SHORT(mld->v1);
	ld->v2i = SHORT(mld->v2);
	ld->twosided = (ld->flags & ML_TWOSIDED) != 0;
	
	if (LINE_DX (ld) == 0)
	    ld->slopetype = ST_VERTICAL;
	else if (LINE_DY (ld) == 0)
	    ld->slopetype = ST_HORIZONTAL;
	else
	{
	    if (FixedDiv (LINE_DY (ld) , LINE_DX (ld)) > 0)
		ld->slopetype = ST_POSITIVE;
	    else
		ld->slopetype = ST_NEGATIVE;
	}
		
#else
	v1 = ld->v1 = &vertexes[SHORT(mld->v1)];
	v2 = ld->v2 = &vertexes[SHORT(mld->v2)];
	ld->dx = v2->x - v1->x;
	ld->dy = v2->y - v1->y;
	
	if (!ld->dx)
	    ld->slopetype = ST_VERTICAL;
	else if (!ld->dy)
	    ld->slopetype = ST_HORIZONTAL;
	else
	{
	    if (FixedDiv (ld->dy , ld->dx) > 0)
		ld->slopetype = ST_POSITIVE;
	    else
		ld->slopetype = ST_NEGATIVE;
	}
		
	if (v1->x < v2->x)
	{
	    ld->bbox[BOXLEFT] = v1->x;
	    ld->bbox[BOXRIGHT] = v2->x;
	}
	else
	{
	    ld->bbox[BOXLEFT] = v2->x;
	    ld->bbox[BOXRIGHT] = v1->x;
	}

	if (v1->y < v2->y)
	{
	    ld->bbox[BOXBOTTOM] = v1->y;
	    ld->bbox[BOXTOP] = v2->y;
	}
	else
	{
	    ld->bbox[BOXBOTTOM] = v2->y;
	    ld->bbox[BOXTOP] = v1->y;
	}
#endif

	ld->sidenum[0] = SHORT(mld->sidenum[0]);
	ld->sidenum[1] = SHORT(mld->sidenum[1]);

	/* tenet-4 fail-soft: reject adversarial WADs with out-of-range sidedef
	   indices before they cause a heap-buffer-overflow in sides[]. The check
	   runs after P_LoadSideDefs so numsides is valid. */
	if (ld->sidenum[0] != -1)
	{
	    /* < 0 too: only -1 means "no side"; any other negative is a
	       malformed index that would read sides[] out of bounds. */
	    if (ld->sidenum[0] < 0 || ld->sidenum[0] >= numsides)
		I_Error ("P_LoadLineDefs: linedef %d has out-of-range front sidenum %d (0..%d)",
			 i, ld->sidenum[0], numsides - 1);
	    ld->frontsector = SIDE_SECTOR (&sides[ld->sidenum[0]]);
	}
	else	/* P_GroupLines counts into frontsector; Chocolate crashes too */
	    I_Error ("P_LoadLineDefs: linedef %d has no front side", i);

	if (ld->sidenum[1] != -1)
	{
	    if (ld->sidenum[1] < 0 || ld->sidenum[1] >= numsides)
		I_Error ("P_LoadLineDefs: linedef %d has out-of-range back sidenum %d (0..%d)",
			 i, ld->sidenum[1], numsides - 1);
	    ld->backsector = SIDE_SECTOR (&sides[ld->sidenum[1]]);
	}
	else
	    ld->backsector = 0;
    }
	
    Z_Free (data);
}


//
// P_LoadSideDefs
//
void P_LoadSideDefs (int lump)
{
    byte*		data;
    int			i;
    mapsidedef_t*	msd;
    side_t*		sd;
	
    numsides = W_LumpLength (lump) / sizeof(mapsidedef_t);
    sides = Z_Malloc (numsides*sizeof(side_t),PU_LEVEL,0);	
    memset (sides, 0, numsides*sizeof(side_t));
    data = W_CacheLumpNum (lump,PU_STATIC);
	
    msd = (mapsidedef_t *)data;
    sd = sides;
    for (i=0 ; i<numsides ; i++, msd++, sd++)
    {
	int sectoridx;
#ifdef LEAN_LEVELS
	sd->textureoffset16 = SHORT(msd->textureoffset);
	sd->rowoffset16 = SHORT(msd->rowoffset);
#else
	sd->textureoffset = SHORT(msd->textureoffset)<<FRACBITS;
	sd->rowoffset = SHORT(msd->rowoffset)<<FRACBITS;
#endif
	sd->toptexture = R_TextureNumForName(msd->toptexture);
	sd->bottomtexture = R_TextureNumForName(msd->bottomtexture);
	sd->midtexture = R_TextureNumForName(msd->midtexture);
	/* tenet-4 fail-soft: reject adversarial WADs with out-of-range sector
	   indices before they cause a heap-buffer-overflow (F5c unguarded-index
	   surface). Valid WADs always have sector < numsectors. */
	sectoridx = (short)SHORT(msd->sector);
	if (sectoridx < 0 || sectoridx >= numsectors)
	    I_Error ("P_LoadSideDefs: sidedef %d references out-of-range sector %d (0..%d)",
		     i, sectoridx, numsectors - 1);
#ifdef LEAN_LEVELS
	sd->sectori = sectoridx;
#else
	sd->sector = &sectors[sectoridx];
#endif
    }
	
    Z_Free (data);
}


//
// P_LoadBlockMap
//
void P_LoadBlockMap (int lump)
{
    int		i;
    int		count;
    int		p;
#ifdef WEB_LUMPS_IN_PLACE
    boolean	inplace;
#endif
	
#ifdef WEB_LUMPS_IN_PLACE
    // webdoom: the playsim reads the blockmap as shorts, in its hottest
    // loops, and vanilla swaps it in place below.  Read in place (w_wad.h) it
    // must be usable exactly as it lies: at an even address, on a host whose
    // SHORT() changes nothing.  Otherwise it gets a zone copy of its own.
    blockmaplump = W_LumpInPlace (lump);
    inplace = blockmaplump && !((size_t) blockmaplump & 1)
	      && SHORT ((short) 0x0102) == 0x0102;
    if (!inplace)
    {
	blockmaplump = Z_Malloc (W_LumpLength (lump), PU_LEVEL, 0);
	W_ReadLump (lump, blockmaplump);
    }
#else
    blockmaplump = W_CacheLumpNum (lump,PU_LEVEL);
#endif
    blockmap = blockmaplump+4;
    count = W_LumpLength (lump)/2;
    if (count < 4)
	I_Error ("P_LoadBlockMap: BLOCKMAP has no header");

#ifdef WEB_LUMPS_IN_PLACE
    if (!inplace)	// in place, the swap is the identity
#endif
    for (i=0 ; i<count ; i++)
	blockmaplump[i] = SHORT(blockmaplump[i]);
		
    bmaporgx = blockmaplump[0]<<FRACBITS;
    bmaporgy = blockmaplump[1]<<FRACBITS;
    bmapwidth = blockmaplump[2];
    bmapheight = blockmaplump[3];

    /* tenet-4 fail-soft: the iterators trust every offset and list in the
       lump (offsets are signed shorts, as in vanilla); the line numbers are
       checked by P_CheckBlockMapLines once the linedefs are loaded. */
    if (bmapwidth <= 0 || bmapheight <= 0
	|| count - 4 < bmapwidth*bmapheight)
	I_Error ("P_LoadBlockMap: BLOCKMAP is too short for %dx%d blocks",
		 bmapwidth, bmapheight);
    for (i=0 ; i<bmapwidth*bmapheight ; i++)
    {
	p = blockmap[i];
	if (p < 0 || p >= count)
	    I_Error ("P_LoadBlockMap: block %d has out-of-range offset %d",
		     i, p);
	while (p < count && blockmaplump[p] != -1)
	    p++;
	if (p >= count)
	    I_Error ("P_LoadBlockMap: block %d has an unterminated list", i);
    }
	
    // clear out mobj chains
    count = sizeof(*blocklinks)* bmapwidth*bmapheight;
    blocklinks = Z_Malloc (count,PU_LEVEL, 0);
    memset (blocklinks, 0, count);
}



//
// P_CheckBlockMapLines
// Every line number in the blockmap lists must name a linedef.
//
void P_CheckBlockMapLines (void)
{
    int		i;
    short*	list;

    for (i=0 ; i<bmapwidth*bmapheight ; i++)
	for (list = blockmaplump+blockmap[i] ; *list != -1 ; list++)
	    if (*list < 0 || *list >= numlines)
		I_Error ("P_CheckBlockMapLines: block %d lists out-of-range "
			 "line %d", i, *list);
}


//
// P_LoadReject
// A REJECT lump shorter than numsectors^2 bits is padded as Chocolate Doom
// pads it.  Vanilla read on past the lump into the next zone block, P_GroupLines'
// line buffer, and these are that block's header fields: its size, an
// owner, PU_LEVEL and the zone id.  Anything past them is zero.
//
void P_LoadReject (int lump)
{
    int		minlength;
    int		lumplen;
    int		totallines;
    int		i;
    unsigned	pad[4];
    line_t*	li;

    minlength = (int) (((long long) numsectors * numsectors + 7) / 8);
    lumplen = W_LumpLength (lump);
    if (lumplen >= minlength)
    {
	rejectmatrix = W_CacheLumpNum (lump,PU_LEVEL);
	return;
    }

    // as P_GroupLines will count them
    totallines = 0;
    for (i=0, li = lines ; i<numlines ; i++, li++)
	totallines += 1 + (li->backsector && li->backsector != li->frontsector);

    pad[0] = ((totallines * 4 + 3) & ~3) + 24;
    pad[1] = 0;
    pad[2] = PU_LEVEL;
    pad[3] = 0x1d4a11;

    rejectmatrix = Z_Malloc (minlength, PU_LEVEL, 0);
    W_ReadLump (lump, rejectmatrix);
    for (i=lumplen ; i<minlength ; i++)
	rejectmatrix[i] = i - lumplen < 16
	    ? (pad[(i - lumplen) / 4] >> ((i - lumplen) % 4 * 8)) & 0xff : 0;
}


//
// P_GroupLines
// Builds sector line lists and subsector sector numbers.
// Finds block bounding boxes for sectors.
//
void P_GroupLines (void)
{
    line_t**		linebuffer;
    int			i;
    int			j;
    int			total;
    line_t*		li;
    sector_t*		sector;
    subsector_t*	ss;
    seg_t*		seg;
    fixed_t		bbox[4];
    int			block;
	
    // look up sector number for each subsector
    ss = subsectors;
    for (i=0 ; i<numsubsectors ; i++, ss++)
    {
	seg = &segs[ss->firstline];
	ss->sector = SIDE_SECTOR (SEG_SIDEDEF (seg));
    }

    // count number of lines in each sector
    li = lines;
    total = 0;
    for (i=0 ; i<numlines ; i++, li++)
    {
	total++;
	li->frontsector->linecount++;

	if (li->backsector && li->backsector != li->frontsector)
	{
	    li->backsector->linecount++;
	    total++;
	}
    }
	
    // build line tables for each sector	
    linebuffer = Z_Malloc (total*4, PU_LEVEL, 0);
    sector = sectors;
    for (i=0 ; i<numsectors ; i++, sector++)
    {
	M_ClearBox (bbox);
	sector->lines = linebuffer;
	li = lines;
	for (j=0 ; j<numlines ; j++, li++)
	{
	    if (li->frontsector == sector || li->backsector == sector)
	    {
		*linebuffer++ = li;
		M_AddToBox (bbox, VX (LINE_V1 (li)), VY (LINE_V1 (li)));
		M_AddToBox (bbox, VX (LINE_V2 (li)), VY (LINE_V2 (li)));
	    }
	}
	if (linebuffer - sector->lines != sector->linecount)
	    I_Error ("P_GroupLines: miscounted");
			
	// set the degenmobj_t to the middle of the bounding box
	sector->soundorg.x = (bbox[BOXRIGHT]+bbox[BOXLEFT])/2;
	sector->soundorg.y = (bbox[BOXTOP]+bbox[BOXBOTTOM])/2;
		
	// adjust bounding box to map blocks
	block = (bbox[BOXTOP]-bmaporgy+MAXRADIUS)>>MAPBLOCKSHIFT;
	block = block >= bmapheight ? bmapheight-1 : block;
	sector->blockbox[BOXTOP]=block;

	block = (bbox[BOXBOTTOM]-bmaporgy-MAXRADIUS)>>MAPBLOCKSHIFT;
	block = block < 0 ? 0 : block;
	sector->blockbox[BOXBOTTOM]=block;

	block = (bbox[BOXRIGHT]-bmaporgx+MAXRADIUS)>>MAPBLOCKSHIFT;
	block = block >= bmapwidth ? bmapwidth-1 : block;
	sector->blockbox[BOXRIGHT]=block;

	block = (bbox[BOXLEFT]-bmaporgx-MAXRADIUS)>>MAPBLOCKSHIFT;
	block = block < 0 ? 0 : block;
	sector->blockbox[BOXLEFT]=block;
    }
	
}


//
// P_SetupLevel
//
void
P_SetupLevel
( int		episode,
  int		map,
  int		playermask,
  skill_t	skill)
{
    int		i;
    char	lumpname[9];
    int		lumpnum;
	
    totalkills = totalitems = totalsecret = wminfo.maxfrags = 0;
    wminfo.partime = 180;
    for (i=0 ; i<MAXPLAYERS ; i++)
    {
	players[i].killcount = players[i].secretcount 
	    = players[i].itemcount = 0;
    }

    // Initial height of PointOfView
    // will be set by player think.
    players[consoleplayer].viewz = 1; 

    // Make sure all sounds are stopped before Z_FreeTags.
    S_Start ();			

    
#if 0 // UNUSED
    if (debugfile)
    {
	Z_FreeTags (PU_LEVEL, MAXINT);
	Z_FileDumpHeap (debugfile);
    }
    else
#endif
	Z_FreeTags (PU_LEVEL, PU_PURGELEVEL-1);


    // UNUSED W_Profile ();
    P_InitThinkers ();

    // if working with a devlopment map, reload it
    W_Reload ();			
	   
    // find map name
    if ( gamemode == commercial)
    {
	if (map<10)
	    sprintf (lumpname,"map0%i", map);
	else
	    sprintf (lumpname,"map%i", map);
    }
    else
    {
	lumpname[0] = 'E';
	lumpname[1] = '0' + episode;
	lumpname[2] = 'M';
	lumpname[3] = '0' + map;
	lumpname[4] = 0;
    }

    lumpnum = W_GetNumForName (lumpname);
	
    leveltime = 0;
	
    // note: most of this ordering is important	
    P_LoadBlockMap (lumpnum+ML_BLOCKMAP);
    P_LoadVertexes (lumpnum+ML_VERTEXES);
    P_LoadSectors (lumpnum+ML_SECTORS);
    P_LoadSideDefs (lumpnum+ML_SIDEDEFS);

    P_LoadLineDefs (lumpnum+ML_LINEDEFS);
    P_CheckBlockMapLines ();
    P_LoadSubsectors (lumpnum+ML_SSECTORS);
    P_LoadNodes (lumpnum+ML_NODES);
    P_LoadSegs (lumpnum+ML_SEGS);
	
    P_LoadReject (lumpnum+ML_REJECT);
    P_GroupLines ();

    bodyqueslot = 0;
    deathmatch_p = deathmatchstarts;
    /* tenet-4 fail-soft: zero playerstarts so a level transition cannot carry
       over starts from the previous map and mask a missing-start in this one. */
    memset (playerstarts, 0, sizeof(playerstarts));
    // webdoom: the previous level's mobjs went with Z_FreeTags.  A player in
    // the game gets a new one below; a slot that is not in the game (one a
    // player left, which a drop-in may take later) must not keep a pointer
    // into freed zone memory for G_DoReborn and G_CheckSpot to follow.
    for (i=0 ; i<MAXPLAYERS ; i++)
	players[i].mo = NULL;
    P_LoadThings (lumpnum+ML_THINGS);

    // if deathmatch, randomly spawn the active players
    if (deathmatch)
    {
	for (i=0 ; i<MAXPLAYERS ; i++)
	    if (playeringame[i])
	    {
		players[i].mo = NULL;
		G_DeathMatchSpawnPlayer (i);
	    }

    }
    else
    {
	/* webdoom: an in-game player the map has no start for (playerstarts[i]
	   is zeroed above) is spawned at another player's start, so
	   P_PlayerThink never meets a NULL mo; a map with no player start at
	   all is refused before the sim begins. */
	for (i=0 ; i<MAXPLAYERS ; i++)
	    if (playeringame[i] && playerstarts[i].type == 0
		&& !G_SpawnAtAnyStart (i))
		I_Error ("no player %d start in %s", i+1, lumpname);
    }

    // clear special respawning que
    iquehead = iquetail = 0;		
	
    // set up world state
    P_SpawnSpecials ();
	
    // build subsector connect matrix
    //	UNUSED P_ConnectSubsectors ();

    // preload graphics
    if (precache)
	R_PrecacheLevel ();

    //printf ("free memory: 0x%x\n", Z_FreeMemory());

}



//
// P_Init
//
void P_Init (void)
{
    P_InitSwitchList ();
    P_InitPicAnims ();
    R_InitSprites (sprnames);
}



