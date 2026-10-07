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
//      Refresh/rendering module, shared data struct definitions.
//
//-----------------------------------------------------------------------------


#ifndef __R_DEFS__
#define __R_DEFS__


// Screenwidth.
#include "doomdef.h"

// Some more or less basic data types
// we depend on.
#include "m_fixed.h"

// We rely on the thinker data struct
// to handle sound origins in sectors.
#include "d_think.h"
// SECTORS do store MObjs anyway.
#include "p_mobj.h"



#ifdef __GNUG__
#pragma interface
#endif



// Silhouette, needed for clipping Segs (mainly)
// and sprites representing things.
#define SIL_NONE		0
#define SIL_BOTTOM		1
#define SIL_TOP			2
#define SIL_BOTH		3

#define MAXDRAWSEGS		256	// vanilla's value; measured peak 205 (doom-demo4), a thin 1.25× margin





//
// INTERNAL MAP TYPES
//  used by play and refresh
//

//
// webdoom: LEAN_LEVELS (off unless a port sets it; tools/freestanding's
// LEAN_LEVELS=1) keeps the level in less RAM, exactly:
// - VERTEXES, SEGS and NODES are records of 16-bit fields the game never
//   writes.  Their in-RAM types are those records, in host order, and
//   P_LevelShorts (p_setup.c) hands them out where they lie in a WAD read in
//   place (w_wad.h), else as one PU_LEVEL copy each.
// - A fixed_t that P_SetupLevel makes as a short << FRACBITS, and that only
//   ever moves by whole units, is kept as that short.  (fixed_t) s << FRACBITS
//   is then the same 32 bits vanilla holds, wrapping included: only the low
//   16 bits of the integer part survive the shift either way.
// - A pointer into a level array is a 16-bit index where the map record's
//   own field is one (it is checked against the array at load).
// - What vanilla derives at load and never changes is derived where it is
//   used instead: a line's dx, dy and bounding box from its vertices, a
//   seg's sidedef and sectors from its linedef (its back sector from the
//   linedef's ML_TWOSIDED as the map set it, line_t's twosided, since
//   vanilla fixes it at load).
// Every access goes through the macros beside each type, which are the plain
// field in the vanilla layout.  The lean fields have other names, so a use
// that bypasses its macro does not compile.
//

//
// Your plain vanilla vertex.
// Note: transformed values not buffered locally,
//  like some DOOM-alikes ("wt", "WebView") did.
//
#ifdef LEAN_LEVELS
typedef struct
{
    short	x16;	// the VERTEXES record: x >> FRACBITS
    short	y16;

} vertex_t;
#define VX(v)	((fixed_t) (v)->x16 << FRACBITS)
#define VY(v)	((fixed_t) (v)->y16 << FRACBITS)
#else
typedef struct
{
    fixed_t	x;
    fixed_t	y;
    
} vertex_t;
#define VX(v)	((v)->x)
#define VY(v)	((v)->y)
#endif


// Forward of LineDefs, for Sectors.
struct line_s;

// Each sector has a degenmobj_t in its center
//  for sound origin purposes.
// I suppose this does not handle sound from
//  moving objects (doppler), because
//  position is prolly just buffered, not
//  updated.
typedef struct
{
    thinker_t		thinker;	// not used for anything
    fixed_t		x;
    fixed_t		y;
    fixed_t		z;

} degenmobj_t;

//
// The SECTORS record, at runtime.
// Stores things/mobjs.
//
typedef	struct
{
    fixed_t	floorheight;
    fixed_t	ceilingheight;
    // webdoom: previous-tic heights + render-swap scratch, interpolation only
    fixed_t	oldfloorheight;
    fixed_t	oldceilingheight;
    fixed_t	savedfloorheight;
    fixed_t	savedceilingheight;
    short	floorpic;
    short	ceilingpic;
    short	lightlevel;
    short	special;
    short	tag;

    // 0 = untraversed, 1,2 = sndlines -1
    int		soundtraversed;

    // thing that made a sound (or null)
    mobj_t*	soundtarget;

    // mapblock bounding box for height changes
    int		blockbox[4];

    // origin for any sounds played by the sector
    degenmobj_t	soundorg;

    // if == validcount, already checked
    int		validcount;

    // list of mobjs in sector
    mobj_t*	thinglist;

    // thinker_t for reversable actions
    void*	specialdata;

    int			linecount;
    struct line_s**	lines;	// [linecount] size
    
} sector_t;




//
// The SideDef.
//

typedef struct
{
#ifdef LEAN_LEVELS
    // >> FRACBITS: loaded as shorts, scrolled by FRACUNIT, saved as shorts
    short	textureoffset16;
    short	rowoffset16;
#else
    // add this to the calculated texture column
    fixed_t	textureoffset;
    
    // add this to the calculated texture top
    fixed_t	rowoffset;
#endif

    // Texture indices.
    // We do not maintain names here. 
    short	toptexture;
    short	bottomtexture;
    short	midtexture;

    // Sector the SideDef is facing.
#ifdef LEAN_LEVELS
    short	sectori;	// sectors[] index
#else
    sector_t*	sector;
#endif
    
} side_t;

#ifdef LEAN_LEVELS
#define SIDE_TEXOFS(s)		((fixed_t) (s)->textureoffset16 << FRACBITS)
#define SIDE_ROWOFS(s)		((fixed_t) (s)->rowoffset16 << FRACBITS)
#define SIDE_SECTOR(s)		(&sectors[(s)->sectori])
#else
#define SIDE_TEXOFS(s)		((s)->textureoffset)
#define SIDE_ROWOFS(s)		((s)->rowoffset)
#define SIDE_SECTOR(s)		((s)->sector)
#endif



//
// Move clipping aid for LineDefs.
//
typedef enum
{
    ST_HORIZONTAL,
    ST_VERTICAL,
    ST_POSITIVE,
    ST_NEGATIVE

} slopetype_t;



typedef struct line_s
{
#ifdef LEAN_LEVELS
    // vertexes[] indices; dx, dy and bbox are LINE_DX, LINE_DY, LINE_BBOX
    short	v1i;
    short	v2i;
#else
    // Vertices, from v1 to v2.
    vertex_t*	v1;
    vertex_t*	v2;

    // Precalculated v2 - v1 for side checking.
    fixed_t	dx;
    fixed_t	dy;
#endif

    // Animation related.
    short	flags;
    short	special;
    short	tag;

    // Visual appearance: SideDefs.
    //  sidenum[1] will be -1 if one sided
    short	sidenum[2];			

#ifdef LEAN_LEVELS
    unsigned char	slopetype;	// slopetype_t
    unsigned char	twosided;	// flags & ML_TWOSIDED, as loaded
#else
    // Neat. Another bounding box, for the extent
    //  of the LineDef.
    fixed_t	bbox[4];

    // To aid move clipping.
    slopetype_t	slopetype;
#endif

    // Front and back sector.
    // Note: redundant? Can be retrieved from SideDefs.
    sector_t*	frontsector;
    sector_t*	backsector;

    // if == validcount, already checked
    int		validcount;

    // thinker_t for reversable actions
    void*	specialdata;		
} line_t;

#ifdef LEAN_LEVELS
#define LINE_V1(l)		(&vertexes[(l)->v1i])
#define LINE_V2(l)		(&vertexes[(l)->v2i])
// v2 - v1 as vanilla's fixed_t subtraction leaves it: only the low 16 bits of
// the difference of the integer parts survive the shift, as they do there
#define LINE_DX(l)		((fixed_t) ((unsigned) (LINE_V2 (l)->x16 - LINE_V1 (l)->x16) << FRACBITS))
#define LINE_DY(l)		((fixed_t) ((unsigned) (LINE_V2 (l)->y16 - LINE_V1 (l)->y16) << FRACBITS))
#define LINE_BBOX(l,i)		P_LineBBox (l, i)	// r_state.h
#else
#define LINE_V1(l)		((l)->v1)
#define LINE_V2(l)		((l)->v2)
#define LINE_DX(l)		((l)->dx)
#define LINE_DY(l)		((l)->dy)
#define LINE_BBOX(l,i)		((l)->bbox[i])
#endif




//
// A SubSector.
// References a Sector.
// Basically, this is a list of LineSegs,
//  indicating the visible walls that define
//  (all or some) sides of a convex BSP leaf.
//
typedef struct subsector_s
{
    sector_t*	sector;
    short	numlines;
    short	firstline;
    
} subsector_t;



//
// The LineSeg.
//
#ifdef LEAN_LEVELS
typedef struct
{
    // the SEGS record (mapseg_t)
    short	v1i;		// vertexes[] indices
    short	v2i;
    short	angle16;	// angle >> 16
    short	linedefi;	// lines[] index
    short	side;		// sidedef: linedef's sidenum[side]
    short	offset16;	// offset >> FRACBITS

} seg_t;
#define SEG_V1(s)		(&vertexes[(s)->v1i])
#define SEG_V2(s)		(&vertexes[(s)->v2i])
#define SEG_OFFSET(s)		((fixed_t) (s)->offset16 << FRACBITS)
#define SEG_ANGLE(s)		((angle_t) (s)->angle16 << 16)
#define SEG_LINEDEF(s)		(&lines[(s)->linedefi])
#define SEG_SIDEDEF(s)		(&sides[lines[(s)->linedefi].sidenum[(s)->side]])
#define SEG_FRONT(s)		SIDE_SECTOR (SEG_SIDEDEF (s))
#define SEG_BACK(s)		P_SegBackSector (s)
#else
typedef struct
{
    vertex_t*	v1;
    vertex_t*	v2;
    
    fixed_t	offset;

    angle_t	angle;

    side_t*	sidedef;
    line_t*	linedef;

    // Sector references.
    // Could be retrieved from linedef, too.
    // backsector is NULL for one sided lines
    sector_t*	frontsector;
    sector_t*	backsector;
    
} seg_t;
#define SEG_V1(s)		((s)->v1)
#define SEG_V2(s)		((s)->v2)
#define SEG_OFFSET(s)		((s)->offset)
#define SEG_ANGLE(s)		((s)->angle)
#define SEG_LINEDEF(s)		((s)->linedef)
#define SEG_SIDEDEF(s)		((s)->sidedef)
#define SEG_FRONT(s)		((s)->frontsector)
#define SEG_BACK(s)		((s)->backsector)
#endif



//
// BSP node.
//
#ifdef LEAN_LEVELS
typedef short	nodecoord_t;
typedef struct
{
    // the NODES record (mapnode_t): partition line and child bounding
    // boxes, >> FRACBITS
    short	x16;
    short	y16;
    short	dx16;
    short	dy16;
    nodecoord_t	bbox16[2][4];
    unsigned short children[2];

} node_t;
#define NODE_X(n)		((fixed_t) (n)->x16 << FRACBITS)
#define NODE_Y(n)		((fixed_t) (n)->y16 << FRACBITS)
#define NODE_DX(n)		((fixed_t) (n)->dx16 << FRACBITS)
#define NODE_DY(n)		((fixed_t) (n)->dy16 << FRACBITS)
#define NODE_BBOX(n,c)		((n)->bbox16[c])
#define NODECOORD(b,i)		((fixed_t) (b)[i] << FRACBITS)
#else
typedef fixed_t	nodecoord_t;
typedef struct
{
    // Partition line.
    fixed_t	x;
    fixed_t	y;
    fixed_t	dx;
    fixed_t	dy;

    // Bounding box for each child.
    fixed_t	bbox[2][4];

    // If NF_SUBSECTOR its a subsector.
    unsigned short children[2];
    
} node_t;
#define NODE_X(n)		((n)->x)
#define NODE_Y(n)		((n)->y)
#define NODE_DX(n)		((n)->dx)
#define NODE_DY(n)		((n)->dy)
#define NODE_BBOX(n,c)		((n)->bbox[c])
#define NODECOORD(b,i)		((b)[i])
#endif




// posts are runs of non masked source pixels
typedef struct
{
    byte		topdelta;	// -1 is the last post in a column
    byte		length; 	// length data bytes follows
} post_t;

// column_t is a list of 0 or more post_t, (byte)-1 terminated
typedef post_t	column_t;



// PC direct to screen pointers
//B UNUSED - keep till detailshift in r_draw.c resolved
//extern byte*	destview;
//extern byte*	destscreen;





//
// OTHER TYPES
//

// This could be wider for >8 bit display.
// Indeed, true color support is posibble
//  precalculating 24bpp lightmap/colormap LUT.
//  from darkening PLAYPAL to all black.
// Could even us emore than 32 levels.
typedef byte	lighttable_t;	




//
// ?
//
typedef struct drawseg_s
{
    seg_t*		curline;
    int			x1;
    int			x2;

    fixed_t		scale1;
    fixed_t		scale2;
    fixed_t		scalestep;

    // 0=none, 1=bottom, 2=top, 3=both
    int			silhouette;

    // do not clip sprites above this
    fixed_t		bsilheight;

    // do not clip sprites below this
    fixed_t		tsilheight;
    
    // Pointers to lists for sprite clipping,
    //  all three adjusted so [x1] is first value.
    short*		sprtopclip;		
    short*		sprbottomclip;	
    short*		maskedtexturecol;
    
} drawseg_t;



// Patches.
// A patch holds one or more columns.
// Patches are used for sprites and all masked pictures,
// and we compose textures from the TEXTURE1/2 lists
// of patches.
typedef struct 
{ 
    short		width;		// bounding box size 
    short		height; 
    short		leftoffset;	// pixels to the left of origin 
    short		topoffset;	// pixels below the origin 
    int			columnofs[8];	// only [width] used
    // the [0] is &columnofs[width] 
} LUMP_PACKED patch_t;







// A vissprite_t is a thing
//  that will be drawn during a refresh.
// I.e. a sprite object that is partly visible.
typedef struct vissprite_s
{
    // Doubly linked list.
    struct vissprite_s*	prev;
    struct vissprite_s*	next;
    
    int			x1;
    int			x2;

    // for line side calculation
    fixed_t		gx;
    fixed_t		gy;		

    // global bottom / top for silhouette clipping
    fixed_t		gz;
    fixed_t		gzt;

    // horizontal position of x1
    fixed_t		startfrac;
    
    fixed_t		scale;
    
    // negative if flipped
    fixed_t		xiscale;	

    fixed_t		texturemid;
    int			patch;

    // for color translation and shadow draw,
    //  maxbright frames as well
    lighttable_t*	colormap;
   
    int			mobjflags;
    
} vissprite_t;


//	
// Sprites are patches with a special naming convention
//  so they can be recognized by R_InitSprites.
// The base name is NNNNFx or NNNNFxFx, with
//  x indicating the rotation, x = 0, 1-7.
// The sprite and frame specified by a thing_t
//  is range checked at run time.
// A sprite is a patch_t that is assumed to represent
//  a three dimensional object and may have multiple
//  rotations pre drawn.
// Horizontal flipping is used to save space,
//  thus NNNNF2F5 defines a mirrored patch.
// Some sprites will only have one picture used
// for all views: NNNNF0
//
typedef struct
{
    // If false use 0 for any position.
    // Note: as eight entries are available,
    //  we might as well insert the same name eight times.
    boolean	rotate;

    // Lump to use for view angles 0-7.
    short	lump[8];

    // Flip bit (1 = flip) to use for view angles 0-7.
    byte	flip[8];
    
} spriteframe_t;



//
// A sprite definition:
//  a number of animation frames.
//
typedef struct
{
    int			numframes;
    spriteframe_t*	spriteframes;

} spritedef_t;



//
// Now what is a visplane, anyway?
// 
typedef struct
{
  fixed_t		height;
  int			picnum;
  int			lightlevel;
  int			minx;
  int			maxx;
  
  // leave pads for [minx-1]/[maxx+1]
  
  byte		pad1;
  // Here lies the rub for all
  //  dynamic resize/change of resolution.
  byte		top[SCREENWIDTH];
  byte		pad2;
  byte		pad3;
  // See above.
  byte		bottom[SCREENWIDTH];
  byte		pad4;

} visplane_t;




#endif
//-----------------------------------------------------------------------------
//
// $Log:$
//
//-----------------------------------------------------------------------------
