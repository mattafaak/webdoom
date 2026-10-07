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
// Revision 1.3  1997/01/29 20:10
// DESCRIPTION:
//	Preparation of data for rendering,
//	generation of lookups, caching, retrieval by name.
//
//-----------------------------------------------------------------------------


static const char
rcsid[] = "$Id: r_data.c,v 1.4 1997/02/03 16:47:55 b1 Exp $";

#include "i_system.h"
#include "z_zone.h"

#include "m_swap.h"

#include "w_wad.h"

#include "doomdef.h"
#include "r_local.h"
#include "p_local.h"

#include "doomstat.h"
#include "r_sky.h"

#ifdef LINUX
#include  <alloca.h>
#endif


#include "r_data.h"

//
// Graphics.
// DOOM graphics for walls and sprites
// is stored in vertical runs of opaque pixels (posts).
// A column is composed of zero or more posts,
// a patch or sprite is composed of zero or more columns.
// 



//
// Texture definition.
// Each texture is composed of one or more patches,
// with patches being lumps stored in the WAD.
// The lumps are referenced by number, and patched
// into the rectangular texture space using origin
// and possibly other attributes.
//
typedef struct
{
    short	originx;
    short	originy;
    short	patch;
    short	stepdir;
    short	colormap;
} mappatch_t;


//
// Texture definition.
// A DOOM wall texture is a list of patches
// which are to be combined in a predefined order.
//
typedef struct
{
    char		name[8];
    boolean		masked;	
    short		width;
    short		height;
    void		**columndirectory;	// OBSOLETE
    short		patchcount;
    mappatch_t	patches[1];
} maptexture_t;


// A single patch from a texture definition,
//  basically a rectangular area within
//  the texture rectangle.
typedef struct
{
    // Block origin (allways UL),
    // which has allready accounted
    // for the internal origin of the patch.
    int		originx;	
    int		originy;
    int		patch;
} texpatch_t;


// A maptexturedef_t describes a rectangular texture,
//  which is composed of one or more mappatch_t structures
//  that arrange graphic patches.
typedef struct
{
    // Keep name for switch changing, etc.
    char	name[8];		
    short	width;
    short	height;
    
    // All the patches[patchcount]
    //  are drawn back to front into the cached texture.
    short	patchcount;
    texpatch_t	patches[1];		
    
} texture_t;



int		firstflat;
int		lastflat;
int		numflats;

int		firstpatch;
int		lastpatch;
int		numpatches;

int		firstspritelump;
int		lastspritelump;
int		numspritelumps;

int		numtextures;
texture_t**	textures;


int*			texturewidthmask;
// needed for texture pegging
fixed_t*		textureheight;		
int*			texturecompositesize;
short**			texturecolumnlump;
unsigned short**	texturecolumnofs;
byte**			texturecomposite;

// for global animation
int*		flattranslation;
int*		texturetranslation;

// needed for pre rendering
fixed_t*	spritewidth;	
fixed_t*	spriteoffset;
fixed_t*	spritetopoffset;

lighttable_t	*colormaps;


//
// MAPTEXTURE_T CACHING
// When a texture is first needed,
//  it counts the number of composite columns
//  required in the texture and allocates space
//  for a column directory and any new columns.
// The directory will simply point inside other patches
//  if there is only one patch in a given column,
//  but any columns with multiple patches
//  will have new column_ts generated.
//



//
// R_DrawColumnInCache
// Clip and draw a column
//  from a patch into a cached post.
//
void
R_DrawColumnInCache
( column_t*	patch,
  byte*		cache,
  int		originy,
  int		cacheheight )
{
    int		count;
    int		position;
    byte*	source;
    byte*	dest;
	
    dest = (byte *)cache + 3;
	
    while (patch->topdelta != 0xff)
    {
	source = (byte *)patch + 3;
	count = patch->length;
	position = originy + patch->topdelta;

	if (position < 0)
	{
	    count += position;
	    position = 0;
	}

	if (position + count > cacheheight)
	    count = cacheheight - position;

	if (count > 0)
	    memcpy (cache + position, source, count);
		
	patch = (column_t *)(  (byte *)patch + patch->length + 4); 
    }
}



//
// R_GenerateComposite
// Using the texture definition,
//  the composite texture is created from the patches,
//  and each column is cached.
//
void R_GenerateComposite (int texnum)
{
    byte*		block;
    texture_t*		texture;
    texpatch_t*		patch;	
    patch_t*		realpatch;
    int			x;
    int			x1;
    int			x2;
    int			i;
    column_t*		patchcol;
    short*		collump;
    unsigned short*	colofs;
	
    texture = textures[texnum];

    block = Z_Malloc (texturecompositesize[texnum],
		      PU_STATIC, 
		      &texturecomposite[texnum]);	

    collump = texturecolumnlump[texnum];
    colofs = texturecolumnofs[texnum];
    
    // Composite the columns together.
    patch = texture->patches;
		
    for (i=0 , patch = texture->patches;
	 i<texture->patchcount;
	 i++, patch++)
    {
	realpatch = W_CacheLumpNum (patch->patch, PU_CACHE);
	x1 = patch->originx;
	x2 = x1 + SHORT(realpatch->width);

	if (x1<0)
	    x = 0;
	else
	    x = x1;
	
	if (x2 > texture->width)
	    x2 = texture->width;

	for ( ; x<x2 ; x++)
	{
	    // Column does not have multiple patches?
	    if (collump[x] >= 0)
		continue;
	    
	    patchcol = (column_t *)((byte *)realpatch
				    + LONG(realpatch->columnofs[x-x1]));
	    R_DrawColumnInCache (patchcol,
				 block + colofs[x],
				 patch->originy,
				 texture->height);
	}
						
    }

    // Now that the texture has been built in column cache,
    //  it is purgable from zone memory.
    Z_ChangeTag (block, PU_CACHE);
}



//
// R_GenerateLookup
//
void R_GenerateLookup (int texnum)
{
    texture_t*		texture;
    byte*		patchcount;	// patchcount[texture->width]
    texpatch_t*		patch;	
    patch_t*		realpatch;
    int			x;
    int			x1;
    int			x2;
    int			i;
    short*		collump;
    unsigned short*	colofs;
	
    texture = textures[texnum];

    // Composited texture not created yet.
    texturecomposite[texnum] = 0;
    
    texturecompositesize[texnum] = 0;
    collump = texturecolumnlump[texnum];
    colofs = texturecolumnofs[texnum];
    
    // Now count the number of columns
    //  that are covered by more than one patch.
    // Fill in the lump / offset, so columns
    //  with only a single patch are all done.
    patchcount = (byte *)alloca (texture->width);
    memset (patchcount, 0, texture->width);
    patch = texture->patches;
		
    for (i=0 , patch = texture->patches;
	 i<texture->patchcount;
	 i++, patch++)
    {
	realpatch = W_CacheLumpNum (patch->patch, PU_CACHE);
	x1 = patch->originx;
	x2 = x1 + SHORT(realpatch->width);
	
	if (x1 < 0)
	    x = 0;
	else
	    x = x1;

	if (x2 > texture->width)
	    x2 = texture->width;
	for ( ; x<x2 ; x++)
	{
	    patchcount[x]++;
	    collump[x] = patch->patch;
	    colofs[x] = LONG(realpatch->columnofs[x-x1])+3;
	}
    }
	
    for (x=0 ; x<texture->width ; x++)
    {
	if (!patchcount[x])
	{
	    printf ("R_GenerateLookup: column without a patch (%s)\n",
		    texture->name);
	    return;
	}
	// I_Error ("R_GenerateLookup: column without a patch");
	
	if (patchcount[x] > 1)
	{
	    // Use the cached block.
	    collump[x] = -1;	
	    colofs[x] = texturecompositesize[texnum];
	    
	    if (texturecompositesize[texnum] > 0x10000-texture->height)
	    {
		I_Error ("R_GenerateLookup: texture %i is >64k",
			 texnum);
	    }
	    
	    texturecompositesize[texnum] += texture->height;
	}
    }	
}




//
// R_GetColumn
//
byte*
R_GetColumnComposite
( int		tex,
  int		ofs )
{
    if (!texturecomposite[tex])
	R_GenerateComposite (tex);

    return texturecomposite[tex] + ofs;
}


#ifdef TEXTURES_CONST
// webdoom: the texture tables as const data, checked at boot (below R_InitData)
static void	R_ConstBegin (int nummappatches);
static void	R_ConstTexture (int texnum);
static int	R_ConstEnd (void);
static void	R_ConstSprites (void);
static int	tc_redo;
#endif


//
// R_InitTextures
// Initializes the texture list
//  with the textures from the world map.
//
void R_InitTextures (void)
{
    maptexture_t*	mtexture;
    texture_t*		texture;
    mappatch_t*		mpatch;
    texpatch_t*		patch;

    int			i;
    int			j;

    int*		maptex;
    int*		maptex2;
    int*		maptex1;
    
    char		name[9];
    char*		names;
    char*		name_p;
    
    int*		patchlookup;
    
    int			totalwidth;
    int			nummappatches;
    int			offset;
    int			maxoff;
    int			maxoff2;
    int			numtextures1;
    int			numtextures2;

    int*		directory;
    
    int			temp1;
    int			temp2;
    int			temp3;

    
    // Load the patch names from pnames.lmp.
    name[8] = 0;	
    names = W_CacheLumpName ("PNAMES", PU_STATIC);
    nummappatches = LUMP_LONG ((int *)names);
    name_p = names+4;
    patchlookup = alloca (nummappatches*sizeof(*patchlookup));
    
    for (i=0 ; i<nummappatches ; i++)
    {
	strncpy (name,name_p+i*8, 8);
	patchlookup[i] = W_CheckNumForName (name);
    }
    Z_Free (names);
    
    // Load the map texture definitions from textures.lmp.
    // The data is contained in one or two lumps,
    //  TEXTURE1 for shareware, plus TEXTURE2 for commercial.
    maptex = maptex1 = W_CacheLumpName ("TEXTURE1", PU_STATIC);
    numtextures1 = LUMP_LONG(maptex);
    maxoff = W_LumpLength (W_GetNumForName ("TEXTURE1"));
    directory = maptex+1;
	
    if (W_CheckNumForName ("TEXTURE2") != -1)
    {
	maptex2 = W_CacheLumpName ("TEXTURE2", PU_STATIC);
	numtextures2 = LUMP_LONG(maptex2);
	maxoff2 = W_LumpLength (W_GetNumForName ("TEXTURE2"));
    }
    else
    {
	maptex2 = NULL;
	numtextures2 = 0;
	maxoff2 = 0;
    }
    numtextures = numtextures1 + numtextures2;
#ifdef TEXTURES_CONST
    R_ConstBegin (nummappatches);
#endif
	
    textures = Z_Malloc (numtextures*4, PU_STATIC, 0);
    texturecolumnlump = Z_Malloc (numtextures*4, PU_STATIC, 0);
    texturecolumnofs = Z_Malloc (numtextures*4, PU_STATIC, 0);
    texturecomposite = Z_Malloc (numtextures*4, PU_STATIC, 0);
    texturecompositesize = Z_Malloc (numtextures*4, PU_STATIC, 0);
    texturewidthmask = Z_Malloc (numtextures*4, PU_STATIC, 0);
    textureheight = Z_Malloc (numtextures*4, PU_STATIC, 0);

    totalwidth = 0;
    
    //	Really complex printing shit...
    temp1 = W_GetNumForName ("S_START");  // P_???????
    temp2 = W_GetNumForName ("S_END") - 1;
    temp3 = ((temp2-temp1+63)/64) + ((numtextures+63)/64);
    printf("[");
    for (i = 0; i < temp3; i++)
	printf(" ");
    printf("         ]");
    for (i = 0; i < temp3; i++)
	printf("\x8");
    printf("\x8\x8\x8\x8\x8\x8\x8\x8\x8\x8");	
	
    for (i=0 ; i<numtextures ; i++, directory++)
    {
	if (!(i&63))
	    printf (".");

	if (i == numtextures1)
	{
	    // Start looking in second texture file.
	    maptex = maptex2;
	    maxoff = maxoff2;
	    directory = maptex+1;
	}
		
	offset = LUMP_LONG(directory);

	if (offset > maxoff)
	    I_Error ("R_InitTextures: bad texture directory");
	
	mtexture = (maptexture_t *) ( (byte *)maptex + offset);

	/* Use byte-safe reads: maptex offset may not be 4-byte-aligned, so
	 * the maptexture_t pointer can be misaligned on strict-alignment
	 * targets (MIPS, ARM Cortex-M).  read_le16/read_le32 compile to a
	 * single load on LE hosts (wasm/x86) — output is byte-identical. */
	{
	    short pcount = read_le16(&mtexture->patchcount);
	    texture = textures[i] =
		Z_Malloc (sizeof(texture_t)
			  + sizeof(texpatch_t)*(pcount-1),
			  PU_STATIC, 0);
	    texture->width = read_le16(&mtexture->width);
	    texture->height = read_le16(&mtexture->height);
	    // webdoom: a height of 0, or one over 32767 read back negative,
	    // makes R_DrawColumn's mask all ones or its wrap loop endless; a
	    // legal texture is at least one pixel tall
	    if (texture->height < 1)
		texture->height = 1;
	    // and a width below 1 sizes the column tables at zero or negative
	    // bytes (a read past them, a memset of (size_t)-1, a zone block
	    // header written before its block)
	    if (texture->width < 1)
		texture->width = 1;
	    texture->patchcount = pcount;
	}

	/* memcpy would be optimised into lw (word) loads on MIPS, which SIGBUS on
	 * a misaligned mtexture pointer.  Copy byte-by-byte to stay safe. */
	{
	    int k;
	    for (k = 0; k < (int)sizeof(texture->name); k++)
		texture->name[k] = mtexture->name[k];
	}
	mpatch = &mtexture->patches[0];
	patch = &texture->patches[0];

	for (j=0 ; j<texture->patchcount ; j++, mpatch++, patch++)
	{
	    patch->originx = read_le16(&mpatch->originx);
	    patch->originy = read_le16(&mpatch->originy);
	    patch->patch = patchlookup[(int)read_le16(&mpatch->patch)];
	    if (patch->patch == -1)
	    {
		I_Error ("R_InitTextures: Missing patch in texture %s",
			 texture->name);
	    }
	}		
	texturecolumnlump[i] = Z_Malloc (texture->width*2, PU_STATIC,0);
	texturecolumnofs[i] = Z_Malloc (texture->width*2, PU_STATIC,0);

	j = 1;
	while (j*2 <= texture->width)
	    j<<=1;

	texturewidthmask[i] = j-1;
	textureheight[i] = texture->height<<FRACBITS;
		
	totalwidth += texture->width;
#ifdef TEXTURES_CONST
	R_ConstTexture (i);
#endif
    }

    Z_Free (maptex1);
    if (maptex2)
	Z_Free (maptex2);
    
#ifdef TEXTURES_CONST
    // the const tables, every texture's lookup already checked against them;
    // or vanilla's, built here; or none yet (R_InitData runs this again)
    j = R_ConstEnd ();
    if (j < 0)
	return;
    if (j == 0)
#endif
    // Precalculate whatever possible.	
    for (i=0 ; i<numtextures ; i++)
	R_GenerateLookup (i);
    
    // Create translation table for global animation.
    texturetranslation = Z_Malloc ((numtextures+1)*4, PU_STATIC, 0);
    
    for (i=0 ; i<numtextures ; i++)
	texturetranslation[i] = i;
}



//
// R_InitFlats
//
void R_InitFlats (void)
{
    int		i;
	
    firstflat = W_GetNumForName ("F_START") + 1;
    lastflat = W_GetNumForName ("F_END") - 1;
    numflats = lastflat - firstflat + 1;
	
    // Create translation table for global animation.
    flattranslation = Z_Malloc ((numflats+1)*4, PU_STATIC, 0);
    
    for (i=0 ; i<numflats ; i++)
	flattranslation[i] = i;
}


//
// R_InitSpriteLumps
// Finds the width and hoffset of all sprites in the wad,
//  so the sprite does not need to be cached completely
//  just for having the header info ready during rendering.
//
void R_InitSpriteLumps (void)
{
    int		i;
    patch_t	*patch;
	
    firstspritelump = W_GetNumForName ("S_START") + 1;
    lastspritelump = W_GetNumForName ("S_END") - 1;
    
    numspritelumps = lastspritelump - firstspritelump + 1;
    spritewidth = Z_Malloc (numspritelumps*4, PU_STATIC, 0);
    spriteoffset = Z_Malloc (numspritelumps*4, PU_STATIC, 0);
    spritetopoffset = Z_Malloc (numspritelumps*4, PU_STATIC, 0);
	
    for (i=0 ; i< numspritelumps ; i++)
    {
	if (!(i&63))
	    printf (".");

	patch = W_CacheLumpNum (firstspritelump+i, PU_CACHE);
	spritewidth[i] = SHORT(patch->width)<<FRACBITS;
	spriteoffset[i] = SHORT(patch->leftoffset)<<FRACBITS;
	spritetopoffset[i] = SHORT(patch->topoffset)<<FRACBITS;
    }
#ifdef TEXTURES_CONST
    R_ConstSprites ();
#endif
}



//
// R_InitColormaps
//
void R_InitColormaps (void)
{
    int	lump, length;
    
    // Load in the light tables, 
    //  256 byte align tables.
    lump = W_GetNumForName("COLORMAP"); 
    length = W_LumpLength (lump) + 255; 
    colormaps = Z_Malloc (length, PU_STATIC, 0); 
    colormaps = (byte *)( ((int)colormaps + 255)&~0xff); 
    W_ReadLump (lump,colormaps); 
}



//
// R_InitData
// Locates all the lumps
//  that will be used by all views
// Must be called after W_Init.
//
void R_InitData (void)
{
    R_InitTextures ();
#ifdef TEXTURES_CONST
    if (tc_redo)
	R_InitTextures ();	// the const tables failed midway: vanilla's
#endif
    printf ("\nInitTextures");
    R_InitFlats ();
    printf ("\nInitFlats");
    R_InitSpriteLumps ();
    printf ("\nInitSprites");
    R_InitColormaps ();
    printf ("\nInitColormaps");
}



//
// R_FlatNumForName
// Retrieval, get a flat number for a flat name.
//
int R_FlatNumForName (char* name)
{
    int		i;
    char	namet[9];

    i = W_CheckNumForName (name);

    if (i == -1)
    {
	namet[8] = 0;
	memcpy (namet, name,8);
	I_Error ("R_FlatNumForName: %s not found",namet);
    }
    return i - firstflat;
}




//
// R_CheckTextureNumForName
// Check whether texture is available.
// Filter out NoTexture indicator.
//
int	R_CheckTextureNumForName (char *name)
{
    int		i;

    // "NoTexture" marker.
    if (name[0] == '-')		
	return 0;
		
    for (i=0 ; i<numtextures ; i++)
	if (!strncasecmp (textures[i]->name, name, 8) )
	    return i;
		
    return -1;
}



//
// R_TextureNumForName
// Calls R_CheckTextureNumForName,
//  aborts with error message.
//
int	R_TextureNumForName (char* name)
{
    int		i;

    i = R_CheckTextureNumForName (name);

    if (i==-1)
    {
	// webdoom: some wads (HACX) reference flats as wall textures,
	// which vanilla cannot draw. 0 renders as no-texture; the map
	// still plays. Vanilla aborted the whole game here.
	fprintf (stderr, "R_TextureNumForName: %.8s not found\n", name);
	return 0;
    }
    return i;
}




//
// R_PrecacheLevel
// Preloads all relevant graphics for the level.
//
int		flatmemory;
int		texturememory;
int		spritememory;

void R_PrecacheLevel (void)
{
    char*		flatpresent;
    char*		texturepresent;
    char*		spritepresent;

    int			i;
    int			j;
    int			k;
    int			lump;
    
    texture_t*		texture;
    thinker_t*		th;
    spriteframe_t*	sf;

    if (demoplayback)
	return;
    
    // Precache flats.
    flatpresent = alloca(numflats);
    memset (flatpresent,0,numflats);	

    for (i=0 ; i<numsectors ; i++)
    {
	flatpresent[sectors[i].floorpic] = 1;
	flatpresent[sectors[i].ceilingpic] = 1;
    }
	
    flatmemory = 0;

    for (i=0 ; i<numflats ; i++)
    {
	if (flatpresent[i])
	{
	    lump = firstflat + i;
	    flatmemory += lumpinfo[lump].size;
	    W_CacheLumpNum(lump, PU_CACHE);
	}
    }
    
    // Precache textures.
    texturepresent = alloca(numtextures);
    memset (texturepresent,0, numtextures);
	
    for (i=0 ; i<numsides ; i++)
    {
	texturepresent[sides[i].toptexture] = 1;
	texturepresent[sides[i].midtexture] = 1;
	texturepresent[sides[i].bottomtexture] = 1;
    }

    // Sky texture is always present.
    // Note that F_SKY1 is the name used to
    //  indicate a sky floor/ceiling as a flat,
    //  while the sky texture is stored like
    //  a wall texture, with an episode dependend
    //  name.
    texturepresent[skytexture] = 1;
	
    texturememory = 0;
    for (i=0 ; i<numtextures ; i++)
    {
	if (!texturepresent[i])
	    continue;

	texture = textures[i];
	
	for (j=0 ; j<texture->patchcount ; j++)
	{
	    lump = texture->patches[j].patch;
	    texturememory += lumpinfo[lump].size;
	    W_CacheLumpNum(lump , PU_CACHE);
	}
    }
    
    // Precache sprites.
    spritepresent = alloca(numsprites);
    memset (spritepresent,0, numsprites);
	
    for (th = thinkercap.next ; th != &thinkercap ; th=th->next)
    {
	if (th->function.acp1 == (actionf_p1)P_MobjThinker)
	    spritepresent[((mobj_t *)th)->sprite] = 1;
    }
	
    spritememory = 0;
    for (i=0 ; i<numsprites ; i++)
    {
	if (!spritepresent[i])
	    continue;

	for (j=0 ; j<sprites[i].numframes ; j++)
	{
	    sf = &sprites[i].spriteframes[j];
	    for (k=0 ; k<8 ; k++)
	    {
		lump = firstspritelump + sf->lump[k];
		spritememory += lumpinfo[lump].size;
		W_CacheLumpNum(lump , PU_CACHE);
	    }
	}
    }
}



#if defined TEXTURES_CONST || defined TEXTURES_GEN
//
// webdoom: the texture tables as const data (TEXTURES_CONST, a compile-time
// opt-in; COMPOSITES_CONST adds the composite textures).
//
// R_InitData builds in the zone tables that are a pure function of the WAD:
// each texture's definition (texture_t), column lumps and offsets, width mask,
// height and composite size, and the sprites' widths and offsets; and the
// renderer builds a multi-patch texture's composite there when it is first
// drawn.  For the four IWADs that is 180-365 KiB of zone at boot, and up to
// 209 KiB of composites in one demo.  A port whose WAD sits in flash can keep
// them in flash beside it:
//   - at build time, fs-texgen (tools/freestanding/Makefile) boots the build's
//     own engine on each IWAD, and when R_InitData returns,
//     tools/floor/gen-texture-tables.c prints what it built, and every
//     composite R_GenerateComposite builds, as C initializers
//     (textures_const.inc).  It does so twice, every zone block filled first
//     with 0x00 and then with 0xff, and the two must be the same: no table
//     holds a byte the engine never wrote;
//   - at boot, R_InitTextures and R_InitSpriteLumps still run vanilla's code,
//     a texture at a time; each texture's lookup (and composite) is compared
//     with the const copy and freed.  The const tables are used only if all
//     of them are what this WAD gives.  Meanwhile the zone holds vanilla's
//     per-texture arrays, one texture's tables and composite, and the sprite
//     tables until they are compared: 41-54 KiB at most for the IWADs.
// A WAD that differs from every const copy -- a PWAD's TEXTURE1, TEXTURE2,
// PNAMES, patches or sprites, another IWAD -- gets vanilla's tables in the
// zone, as without TEXTURES_CONST, and stderr says which texture differed.
// What changes at run time stays in the zone: texturetranslation,
// flattranslation, colormaps, and texturecomposite without COMPOSITES_CONST.
// The const tables are never written (on the host, .rodata faults if they are).
//
#include <stddef.h>

typedef struct
{
    const char*			wad;		// the WAD it was made from
    int				numtextures;
    int				nummappatches;
    int				numspritelumps;
    int				numcolumns;
    int				numcomposites;
    texture_t* const*		textures;
    short* const*		columnlump;
    unsigned short* const*	columnofs;
    const int*			widthmask;
    const fixed_t*		height;
    const int*			compositesize;
    byte* const*		composite;	// NULL: built in the zone
    const fixed_t*		spritewidth;
    const fixed_t*		spriteoffset;
    const fixed_t*		spritetopoffset;
} texconst_t;

// A texture of n+1 patches, laid out as R_InitTextures allocates one: the
// texture_t, then the patches past its first.
#define TC_PATCHES(n)	struct { texture_t t; texpatch_t more[n]; }
typedef char tc_layout_check[sizeof (texture_t)
			     == offsetof (texture_t, patches) + sizeof (texpatch_t)
			     && sizeof (TC_PATCHES (2))
			     == sizeof (texture_t) + 2 * sizeof (texpatch_t) ? 1 : -1];
#endif


#ifdef TEXTURES_GEN
// tools/floor/gen-texture-tables.c reads the private texture_t through these
void R_TexGenTexture (int i, char* name, int* width, int* height,
		      int* patchcount)
{
    texture_t*	t = textures[i];
    memcpy (name, t->name, 8);
    *width = t->width;
    *height = t->height;
    *patchcount = t->patchcount;
}

void R_TexGenPatch (int i, int j, int* originx, int* originy, int* patch)
{
    texpatch_t*	p = &textures[i]->patches[j];
    *originx = p->originx;
    *originy = p->originy;
    *patch = p->patch;
}
#endif


#ifdef TEXTURES_CONST
#if defined COMPOSITES_CONST && !defined TEXTURES_CONST
#error COMPOSITES_CONST needs TEXTURES_CONST
#endif

// texconst_all[]: one per WAD, NULL-terminated
#include "textures_const.inc"

#define TC_MAX		8

static struct
{
    const texconst_t*	c;
    int			composites;	// its composites matched too
} tc_live[TC_MAX];
static int		tc_nlive;	// the const copies still in the running
static int		tc_freed;	// textures whose zone tables were freed
static int		tc_off;		// the second run: vanilla's tables
static const texconst_t* tc_used;
// the last difference found, for stderr
static const char*	tc_why;
static const char*	tc_whywad;
static int		tc_whytex;
static char		tc_whyname[9];

static void R_ConstNote (const texconst_t* c, int texnum, const char* why)
{
    tc_why = why;
    tc_whywad = c->wad;
    tc_whytex = texnum;
    memcpy (tc_whyname, textures[texnum]->name, 8);
    tc_whyname[8] = 0;
}

//
// R_ConstBegin
// The const copies whose counts match this WAD's.
//
static void R_ConstBegin (int nummappatches)
{
    int		i;

    tc_nlive = tc_freed = tc_redo = 0;
    tc_used = NULL;
    tc_why = NULL;
    if (tc_off)
	return;
    for (i=0 ; texconst_all[i] && tc_nlive < TC_MAX ; i++)
	if (texconst_all[i]->numtextures == numtextures
	    && texconst_all[i]->nummappatches == nummappatches)
	{
	    tc_live[tc_nlive].c = texconst_all[i];
	    tc_live[tc_nlive].composites = texconst_all[i]->composite != NULL;
	    tc_nlive++;
	}
}

//
// R_ConstDiffers
// What of texture texnum, as vanilla just built it, differs from c's copy.
//
static const char* R_ConstDiffers (const texconst_t* c, int texnum)
{
#ifdef TEXTURES_CONST_UNCHECKED
    // the red-proof's build (tools/floor/textures-const-test.mjs): the const
    // copy is taken as it is
    return NULL;
#else
    texture_t*		t = textures[texnum];
    const texture_t*	k = c->textures[texnum];
    int			j;

    if (memcmp (t->name, k->name, 8) || t->width != k->width
	|| t->height != k->height || t->patchcount != k->patchcount)
	return "definition";
    for (j=0 ; j<t->patchcount ; j++)
	if (t->patches[j].originx != k->patches[j].originx
	    || t->patches[j].originy != k->patches[j].originy
	    || t->patches[j].patch != k->patches[j].patch)
	    return "patches";
    if (texturewidthmask[texnum] != c->widthmask[texnum]
	|| textureheight[texnum] != c->height[texnum]
	|| texturecompositesize[texnum] != c->compositesize[texnum])
	return "size";
    if (memcmp (texturecolumnlump[texnum], c->columnlump[texnum],
		t->width * sizeof(short)))
	return "column lumps";
    if (memcmp (texturecolumnofs[texnum], c->columnofs[texnum],
		t->width * sizeof(unsigned short)))
	return "column offsets";
    return NULL;
#endif
}

//
// R_ConstTexture
// Texture texnum is defined: build its lookup (and its composite) as
// vanilla does, keep the const copies that hold the same, and free it.
//
static void R_ConstTexture (int texnum)
{
    byte*	block = NULL;
    const char*	why;
    int		k;
    int		n;

    if (!tc_nlive)
	return;
    R_GenerateLookup (texnum);
#ifdef COMPOSITES_CONST
    if (texturecompositesize[texnum])
    {
	R_GenerateComposite (texnum);
	block = texturecomposite[texnum];
    }
#endif
    for (k=n=0 ; k<tc_nlive ; k++)
    {
	why = R_ConstDiffers (tc_live[k].c, texnum);
	if (why)
	{
	    R_ConstNote (tc_live[k].c, texnum, why);
	    continue;
	}
#ifndef TEXTURES_CONST_UNCHECKED
	if (block && tc_live[k].composites
	    && memcmp (block, tc_live[k].c->composite[texnum],
		       texturecompositesize[texnum]))
	{
	    R_ConstNote (tc_live[k].c, texnum, "composite");
	    tc_live[k].composites = 0;
	}
#endif
	tc_live[n++] = tc_live[k];
    }
    tc_nlive = n;
    if (block)
	Z_Free (block);		// texturecomposite[texnum] is 0 again
    if (!tc_nlive)
    {
	// vanilla's tables from here on; the ones freed must be built again
	tc_redo = tc_freed > 0;
	return;
    }
    Z_Free (textures[texnum]);
    Z_Free (texturecolumnlump[texnum]);
    Z_Free (texturecolumnofs[texnum]);
    textures[texnum] = NULL;
    tc_freed++;
}

//
// R_ConstEnd
// Every texture is defined.  1: the const tables are in; 0: vanilla's are
// being built (R_InitTextures goes on); -1: some textures matched before one
// did not, and were freed: everything is freed, R_InitData runs
// R_InitTextures again, and that run builds vanilla's.
//
static int R_ConstEnd (void)
{
    int		i;
    int		k;
    int		comp;

    if (tc_redo)
    {
	for (i=0 ; i<numtextures ; i++)
	    if (textures[i])
	    {
		Z_Free (textures[i]);
		Z_Free (texturecolumnlump[i]);
		Z_Free (texturecolumnofs[i]);
	    }
	Z_Free (textures);
	Z_Free (texturecolumnlump);
	Z_Free (texturecolumnofs);
	Z_Free (texturecomposite);
	Z_Free (texturecompositesize);
	Z_Free (texturewidthmask);
	Z_Free (textureheight);
	tc_off = 1;
	fprintf (stderr, "R_InitTextures: the const tables from %s differ at "
		 "texture %d (%s: %s): built in the zone\n",
		 tc_whywad, tc_whytex, tc_whyname, tc_why);
	return -1;
    }
    if (!tc_nlive)
    {
	if (tc_off)
	    return 0;		// the second run, already reported
	if (tc_why)
	    fprintf (stderr, "R_InitTextures: the const tables from %s differ "
		     "at texture %d (%s: %s): built in the zone\n",
		     tc_whywad, tc_whytex, tc_whyname, tc_why);
	else
	    fprintf (stderr, "R_InitTextures: no const tables for this WAD "
		     "(%d textures): built in the zone\n", numtextures);
	return 0;
    }

    // the first that matched, one with its composites if there is one
    for (k=0 ; k<tc_nlive-1 && !tc_live[k].composites ; k++)
	;
    tc_used = tc_live[k].c;
    comp = tc_live[k].composites;
    Z_Free (textures);
    Z_Free (texturecolumnlump);
    Z_Free (texturecolumnofs);
    Z_Free (texturecomposite);
    Z_Free (texturecompositesize);
    Z_Free (texturewidthmask);
    Z_Free (textureheight);
    textures = (texture_t **) tc_used->textures;
    texturecolumnlump = (short **) tc_used->columnlump;
    texturecolumnofs = (unsigned short **) tc_used->columnofs;
    texturecompositesize = (int *) tc_used->compositesize;
    texturewidthmask = (int *) tc_used->widthmask;
    textureheight = (fixed_t *) tc_used->height;
    if (comp)
	texturecomposite = (byte **) tc_used->composite;
    else
    {
	texturecomposite = Z_Malloc (numtextures*4, PU_STATIC, 0);
	memset (texturecomposite, 0, numtextures*4);
    }
    fprintf (stderr, "R_InitTextures: const tables from %s: %d textures, "
	     "%d columns, %d composites %s, %s\n",
	     tc_used->wad, numtextures, tc_used->numcolumns,
	     tc_used->numcomposites, comp ? "const" : "built in the zone",
#ifdef TEXTURES_CONST_UNCHECKED
	     "UNCHECKED (TEXTURES_CONST_UNCHECKED)"
#else
	     "checked against this WAD"
#endif
	     );
    if (tc_used->composite && !comp)
	fprintf (stderr, "R_InitTextures: the const composites from %s differ "
		 "at texture %d (%s): built in the zone\n",
		 tc_whywad, tc_whytex, tc_whyname);
    return 1;
}

//
// R_ConstSprites
// Vanilla's sprite tables are built: if a const copy holds the same, use it
// and free them.
//
static void R_ConstSprites (void)
{
    const texconst_t*	c;
    int			i;
    int			n = numspritelumps * sizeof(fixed_t);

    for (i=-1 ; ; i++)
    {
	c = i < 0 ? tc_used : texconst_all[i];
	if (i >= 0 && !c)
	{
	    fprintf (stderr, "R_InitSpriteLumps: no const tables for this "
		     "WAD's %d sprite lumps: built in the zone\n",
		     numspritelumps);
	    return;
	}
	if (!c || c->numspritelumps != numspritelumps)
	    continue;
#ifndef TEXTURES_CONST_UNCHECKED
	if (memcmp (spritewidth, c->spritewidth, n)
	    || memcmp (spriteoffset, c->spriteoffset, n)
	    || memcmp (spritetopoffset, c->spritetopoffset, n))
	    continue;
#endif
	break;
    }
    Z_Free (spritewidth);
    Z_Free (spriteoffset);
    Z_Free (spritetopoffset);
    spritewidth = (fixed_t *) c->spritewidth;
    spriteoffset = (fixed_t *) c->spriteoffset;
    spritetopoffset = (fixed_t *) c->spritetopoffset;
    fprintf (stderr, "R_InitSpriteLumps: const tables from %s: %d sprite "
	     "lumps, %s\n", c->wad, numspritelumps,
#ifdef TEXTURES_CONST_UNCHECKED
	     "UNCHECKED (TEXTURES_CONST_UNCHECKED)"
#else
	     "checked against this WAD"
#endif
	     );
}
#endif
