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
//	The actual span/column drawing functions.
//	Here find the main potential for optimization,
//	 e.g. inline assembly, different algorithms.
//
//-----------------------------------------------------------------------------


static const char
rcsid[] = "$Id: r_draw.c,v 1.4 1997/02/03 16:47:55 b1 Exp $";


#include "doomdef.h"

#include "i_system.h"
#include "z_zone.h"
#include "w_wad.h"

#include "r_local.h"

// Needs access to LFB (guess what).
#include "v_video.h"

// State.
#include "doomstat.h"

// webdoom task 2.2: call/pixel counters for R_DrawColumn / R_DrawSpan.
// Compile with -DWEB_PERF_COL_STATS to enable; zero overhead otherwise.
// perf.h lives in engine/web/ — include it only when the stats flag is set
// so that an unflagged build of engine/core/ has no dependency on engine/web/.
#ifdef WEB_PERF_COL_STATS
#include "perf.h"
#define PERF_COL_INC(count)  do { web_perf_col_calls++;  web_perf_col_pixels  += (count)+1; } while(0)
#define PERF_SPAN_INC(count) do { web_perf_span_calls++; web_perf_span_pixels += (count)+1; } while(0)
#else
#define PERF_COL_INC(count)  ((void)0)
#define PERF_SPAN_INC(count) ((void)0)
#endif


// ?
#define MAXWIDTH			1120
#define MAXHEIGHT			832

// status bar height at bottom of screen
#define SBARHEIGHT		32

//
// All drawing to the view buffer is accomplished in this file.
// The other refresh files only know about ccordinates,
//  not the architecture of the frame buffer.
// Conveniently, the frame buffer is a linear one,
//  and we need only the base address,
//  and the total size == width*height*depth/8.,
//


byte*		viewimage; 
int		viewwidth;
int		scaledviewwidth;
int		viewheight;
int		viewwindowx;
int		viewwindowy; 
byte*		ylookup[MAXHEIGHT]; 
int		columnofs[MAXWIDTH]; 

// Color tables for different players,
//  translate a limited part to another
//  (color ramps used for  suit colors).
//
byte		translations[3][256];	
 
 


//
// R_DrawColumn
// Source is the top of the column to scale.
//
lighttable_t*		dc_colormap; 
int			dc_x; 
int			dc_yl; 
int			dc_yh; 
fixed_t			dc_iscale; 
fixed_t			dc_texturemid;

// first pixel in a column (possibly virtual)
byte*			dc_source;

// Height (texels) of the source column buffer — set by the caller before
// invoking R_DrawColumn/R_DrawColumnLow.  The column draw dispatches on this:
//   power-of-2 heights (walls: 8/16/32/64/128) → fast & mask path + 4-wide
//     unroll (task 2.2), where mask = (dc_texheight - 1).
//   non-power-of-2 heights (sprites — patch post lengths are almost never
//     pow2) → prboom-style true modulo via heightmask = dc_texheight<<FRACBITS,
//     normalising frac before the loop then subtracting on overshoot.
// This gives correct tiling AND ASan-clean reads for both cases.
// Default 128 preserves the vanilla & 127 for callers that do not need to
// override (e.g. sky draw in r_plane.c, which sets its own height).
int			dc_texheight = 128;

// just for profiling
int			dccount;

//
// A column is a vertical slice/span from a wall texture that,
//  given the DOOM style restrictions on the view orientation,
//  will always have constant z depth.
// Thus a special case loop for very fast rendering can
//  be used. It has also been used with Wolfenstein 3D.
// 
void R_DrawColumn (void)
{
    int			count;
    byte*		dest;
    fixed_t		frac;
    fixed_t		fracstep;
    const byte*		source;
    const lighttable_t*	colormap;

    count = dc_yh - dc_yl;

    // Zero length, column does not exceed a pixel.
    if (count < 0)
	return;

#ifdef RANGECHECK
    if ((unsigned)dc_x >= (unsigned)screenwidth
	|| dc_yl < 0
	|| dc_yh >= SCREENHEIGHT)
	I_Error ("R_DrawColumn: %i to %i at %i", dc_yl, dc_yh, dc_x);
#endif

    PERF_COL_INC(count);

    // Framebuffer destination address.
    // Use ylookup LUT to avoid multiply with ScreenWidth.
    // Use columnofs LUT for subwindows?
    dest = ylookup[dc_yl] + columnofs[dc_x];

    // Determine scaling,
    //  which is the only mapping to be done.
    fracstep = dc_iscale;
    frac = dc_texturemid + (dc_yl-centery)*fracstep;

    // Hoist loop-invariant values into locals for the hot path.
    source   = dc_source;
    colormap = dc_colormap;

    // webdoom task 3.1: use dc_texheight as the column mask / wrap guard.
    // task hotfix (sprite clone-stamp regression from 3.1/3.2):
    //   For power-of-2 heights (walls: 8/16/32/64/128) the fast & mask path
    //   is correct and kept — including task 2.2's 4-wide unroll.
    //   For non-power-of-2 heights (sprites — patch post lengths are almost
    //   never pow2) we must use a TRUE modulo: frac % (dc_texheight<<FRACBITS).
    //   `frac & (length-1)` is NOT a modulo for non-pow2, causing the vertical
    //   clone-stamp artifact on every sprite (barrels, enemies, player gun, etc).
    //   prboom pattern: normalise frac into [0, heightmask) before the loop, then
    //   subtract on overshoot inside.  frac can be negative when the post top is
    //   above the screen, hence the normalisation step.
    if (dc_texheight & (dc_texheight - 1))
    {
        // Non-power-of-2 path (sprites and any non-pow2 wall patch).
        // Scalar only — sprites are a small fraction of total pixels; correctness
        // beats speed here.
        const fixed_t heightmask = dc_texheight << FRACBITS;
        if (frac < 0)
            while ((frac += heightmask) < 0);
        else
            while (frac >= heightmask) frac -= heightmask;

        while (count-- >= 0)
        {
            *dest = colormap[source[frac >> FRACBITS]];
            dest++;  /* 14.2a: column-major — next row is +1 byte (was +SCREENWIDTH) */
            if ((frac += fracstep) >= heightmask)
                frac -= heightmask;
        }
    }
    else
    {
        // Power-of-2 fast path (walls — the bulk of pixels).
        // webdoom task 2.2: unrolled 4-wide inner loop.
        // 14.2a column-major: sequential pixel writes (dest[0..3]) replace
        // the stride-SCREENWIDTH writes; dest += 4 advances four rows.
        const unsigned mask = (unsigned)(dc_texheight - 1);

        while (count >= 3)
        {
            dest[0] = colormap[source[((frac              )>>FRACBITS)&mask]];
            dest[1] = colormap[source[((frac+fracstep  )>>FRACBITS)&mask]];
            dest[2] = colormap[source[((frac+fracstep*2)>>FRACBITS)&mask]];
            dest[3] = colormap[source[((frac+fracstep*3)>>FRACBITS)&mask]];
            dest  += 4;
            frac  += fracstep*4;
            count -= 4;
        }

        // Scalar tail — handles 0, 1, 2, or 3 remaining pixels.
        // count is in [-1, 2] here.
        while (count-- >= 0)
        {
            *dest = colormap[source[(frac>>FRACBITS)&mask]];
            dest++;  /* column-major: +1 byte = next row in same column */
            frac += fracstep;
        }
    }
}



// UNUSED.
// Loop unrolled.
#if 0
void R_DrawColumn (void) 
{ 
    int			count; 
    byte*		source;
    byte*		dest;
    byte*		colormap;
    
    unsigned		frac;
    unsigned		fracstep;
    unsigned		fracstep2;
    unsigned		fracstep3;
    unsigned		fracstep4;	 
 
    count = dc_yh - dc_yl + 1; 

    source = dc_source;
    colormap = dc_colormap;		 
    dest = ylookup[dc_yl] + columnofs[dc_x];  
	 
    fracstep = dc_iscale<<9; 
    frac = (dc_texturemid + (dc_yl-centery)*dc_iscale)<<9; 
 
    fracstep2 = fracstep+fracstep;
    fracstep3 = fracstep2+fracstep;
    fracstep4 = fracstep3+fracstep;
	
    while (count >= 8) 
    { 
	dest[0] = colormap[source[frac>>25]]; 
	dest[MAXSCREENWIDTH] = colormap[source[(frac+fracstep)>>25]];
	dest[MAXSCREENWIDTH*2] = colormap[source[(frac+fracstep2)>>25]];
	dest[MAXSCREENWIDTH*3] = colormap[source[(frac+fracstep3)>>25]];

	frac += fracstep4;

	dest[MAXSCREENWIDTH*4] = colormap[source[frac>>25]];
	dest[MAXSCREENWIDTH*5] = colormap[source[(frac+fracstep)>>25]];
	dest[MAXSCREENWIDTH*6] = colormap[source[(frac+fracstep2)>>25]];
	dest[MAXSCREENWIDTH*7] = colormap[source[(frac+fracstep3)>>25]];

	frac += fracstep4;
	dest += MAXSCREENWIDTH*8;
	count -= 8;
    }

    while (count > 0)
    {
	*dest = colormap[source[frac>>25]];
	dest += MAXSCREENWIDTH;
	frac += fracstep; 
	count--;
    } 
}
#endif


void R_DrawColumnLow (void)
{
    int			count;
    byte*		dest;
    byte*		dest2;
    fixed_t		frac;
    fixed_t		fracstep;
    int			screen_x; /* 14.2a/14.2b: local doubled-x; do NOT modify dc_x (global) */

    count = dc_yh - dc_yl;

    // Zero length.
    if (count < 0)
	return;

#ifdef RANGECHECK
    if ((unsigned)dc_x >= (unsigned)screenwidth
	|| dc_yl < 0
	|| dc_yh >= SCREENHEIGHT)
    {
	I_Error ("R_DrawColumn: %i to %i at %i", dc_yl, dc_yh, dc_x);
    }
#endif

    PERF_COL_INC(count);

    // Blocky mode: double to screen x (0..SCREENWIDTH-1) via LOCAL var.
    // 14.2b: do NOT modify the global dc_x — callers iterate dc_x in
    // viewwidth coords (0..viewwidth-1); modifying dc_x here causes
    // exponential growth of the outer loop counter across iterations.
    screen_x = dc_x << 1;

    dest = ylookup[dc_yl] + columnofs[screen_x];
    dest2 = ylookup[dc_yl] + columnofs[screen_x+1];
    
    fracstep = dc_iscale; 
    frac = dc_texturemid + (dc_yl-centery)*fracstep;
    
    // hotfix: same pow2/non-pow2 dispatch as R_DrawColumn.
    if (dc_texheight & (dc_texheight - 1))
    {
        const fixed_t heightmask = dc_texheight << FRACBITS;
        if (frac < 0)
            while ((frac += heightmask) < 0);
        else
            while (frac >= heightmask) frac -= heightmask;

        do
        {
            *dest2 = *dest = dc_colormap[dc_source[frac >> FRACBITS]];
            dest++;   /* 14.2a column-major */
            dest2++;
            if ((frac += fracstep) >= heightmask)
                frac -= heightmask;
        } while (count--);
    }
    else
    {
        const unsigned mask = (unsigned)(dc_texheight - 1);
        do
        {
            // Hack. Does not work corretly.
            *dest2 = *dest = dc_colormap[dc_source[(frac>>FRACBITS)&mask]];
            dest++;   /* 14.2a column-major */
            dest2++;
            frac  += fracstep;
        } while (count--);
    }
}


//
// Spectre/Invisibility.
//
#define FUZZTABLE		50 
/* 14.2a column-major: adjacent fuzz pixel is 1 byte away (next row in column) */
#define FUZZOFF	1


int	fuzzoffset[FUZZTABLE] =
{
    FUZZOFF,-FUZZOFF,FUZZOFF,-FUZZOFF,FUZZOFF,FUZZOFF,-FUZZOFF,
    FUZZOFF,FUZZOFF,-FUZZOFF,FUZZOFF,FUZZOFF,FUZZOFF,-FUZZOFF,
    FUZZOFF,FUZZOFF,FUZZOFF,-FUZZOFF,-FUZZOFF,-FUZZOFF,-FUZZOFF,
    FUZZOFF,-FUZZOFF,-FUZZOFF,FUZZOFF,FUZZOFF,FUZZOFF,FUZZOFF,-FUZZOFF,
    FUZZOFF,-FUZZOFF,FUZZOFF,FUZZOFF,-FUZZOFF,-FUZZOFF,FUZZOFF,
    FUZZOFF,-FUZZOFF,-FUZZOFF,-FUZZOFF,-FUZZOFF,FUZZOFF,FUZZOFF,
    FUZZOFF,FUZZOFF,-FUZZOFF,FUZZOFF,FUZZOFF,-FUZZOFF,FUZZOFF 
}; 

int	fuzzpos = 0; 


//
// Framebuffer postprocessing.
// Creates a fuzzy image by copying pixels
//  from adjacent ones to left and right.
// Used with an all black colormap, this
//  could create the SHADOW effect,
//  i.e. spectres and invisible players.
//
void R_DrawFuzzColumn (void) 
{ 
    int			count; 
    byte*		dest; 
    fixed_t		frac;
    fixed_t		fracstep;	 

    // Adjust borders. Low... 
    if (!dc_yl) 
	dc_yl = 1;

    // .. and high.
    if (dc_yh == viewheight-1) 
	dc_yh = viewheight - 2; 
		 
    count = dc_yh - dc_yl; 

    // Zero length.
    if (count < 0) 
	return; 

    
#ifdef RANGECHECK 
    if ((unsigned)dc_x >= (unsigned)screenwidth
	|| dc_yl < 0 || dc_yh >= SCREENHEIGHT)
    {
	I_Error ("R_DrawFuzzColumn: %i to %i at %i",
		 dc_yl, dc_yh, dc_x);
    }
#endif


    // Keep till detailshift bug in blocky mode fixed,
    //  or blocky mode removed.
    /* WATCOM code 
    if (detailshift)
    {
	if (dc_x & 1)
	{
	    outpw (GC_INDEX,GC_READMAP+(2<<8) ); 
	    outp (SC_INDEX+1,12); 
	}
	else
	{
	    outpw (GC_INDEX,GC_READMAP); 
	    outp (SC_INDEX+1,3); 
	}
	dest = destview + dc_yl*80 + (dc_x>>1); 
    }
    else
    {
	outpw (GC_INDEX,GC_READMAP+((dc_x&3)<<8) ); 
	outp (SC_INDEX+1,1<<(dc_x&3)); 
	dest = destview + dc_yl*80 + (dc_x>>2); 
    }*/

    
    // Does not work with blocky mode.
    dest = ylookup[dc_yl] + columnofs[dc_x];

    // Looks familiar.
    fracstep = dc_iscale; 
    frac = dc_texturemid + (dc_yl-centery)*fracstep; 

    // Looks like an attempt at dithering,
    //  using the colormap #6 (of 0-31, a bit
    //  brighter than average).
    do 
    {
	// Lookup framebuffer, and retrieve
	//  a pixel that is either one column
	//  left or right of the current one.
	// Add index from colormap to index.
	*dest = colormaps[6*256+dest[fuzzoffset[fuzzpos]]];

	// Clamp table lookup index.
	if (++fuzzpos == FUZZTABLE)
	    fuzzpos = 0;

	dest++;  /* 14.2a column-major */

	frac += fracstep;
    } while (count--);
} 
 
  
 

//
// R_DrawTranslatedColumn
// Used to draw player sprites
//  with the green colorramp mapped to others.
// Could be used with different translation
//  tables, e.g. the lighter colored version
//  of the BaronOfHell, the HellKnight, uses
//  identical sprites, kinda brightened up.
//
byte*	dc_translation;
byte*	translationtables;

void R_DrawTranslatedColumn (void) 
{ 
    int			count; 
    byte*		dest; 
    fixed_t		frac;
    fixed_t		fracstep;	 
 
    count = dc_yh - dc_yl; 
    if (count < 0) 
	return; 
				 
#ifdef RANGECHECK 
    if ((unsigned)dc_x >= (unsigned)screenwidth
	|| dc_yl < 0
	|| dc_yh >= SCREENHEIGHT)
    {
	I_Error ( "R_DrawColumn: %i to %i at %i",
		  dc_yl, dc_yh, dc_x);
    }
    
#endif 


    // WATCOM VGA specific.
    /* Keep for fixing.
    if (detailshift)
    {
	if (dc_x & 1)
	    outp (SC_INDEX+1,12); 
	else
	    outp (SC_INDEX+1,3);
	
	dest = destview + dc_yl*80 + (dc_x>>1); 
    }
    else
    {
	outp (SC_INDEX+1,1<<(dc_x&3)); 

	dest = destview + dc_yl*80 + (dc_x>>2); 
    }*/

    
    // FIXME. As above.
    dest = ylookup[dc_yl] + columnofs[dc_x]; 

    // Looks familiar.
    fracstep = dc_iscale; 
    frac = dc_texturemid + (dc_yl-centery)*fracstep; 

    // Here we do an additional index re-mapping.
    // hotfix: apply same non-pow2/pow2 wrap as R_DrawColumn so translated
    // player sprites don't clone-stamp and don't OOB-read.
    if (dc_texheight & (dc_texheight - 1))
    {
        const fixed_t heightmask = dc_texheight << FRACBITS;
        if (frac < 0)
            while ((frac += heightmask) < 0);
        else
            while (frac >= heightmask) frac -= heightmask;

        do
        {
            *dest = dc_colormap[dc_translation[dc_source[frac >> FRACBITS]]];
            dest++;  /* 14.2a column-major */
            if ((frac += fracstep) >= heightmask)
                frac -= heightmask;
        } while (count--);
    }
    else
    {
        const unsigned mask = (unsigned)(dc_texheight - 1);
        do
        {
            // Translation tables are used
            //  to map certain colorramps to other ones,
            //  used with PLAY sprites.
            // Thus the "green" ramp of the player 0 sprite
            //  is mapped to gray, red, black/indigo.
            *dest = dc_colormap[dc_translation[dc_source[(frac>>FRACBITS)&mask]]];
            dest++;  /* 14.2a column-major */
            frac += fracstep;
        } while (count--);
    }
} 




//
// R_InitTranslationTables
// Creates the translation tables to map
//  the green color ramp to gray, brown, red.
// Assumes a given structure of the PLAYPAL.
// Could be read from a lump instead.
//
void R_InitTranslationTables (void)
{
    int		i;
	
    translationtables = Z_Malloc (256*3+255, PU_STATIC, 0);
    translationtables = (byte *)(( (int)translationtables + 255 )& ~255);
    
    // translate just the 16 green colors
    for (i=0 ; i<256 ; i++)
    {
	if (i >= 0x70 && i<= 0x7f)
	{
	    // map green ramp to gray, brown, red
	    translationtables[i] = 0x60 + (i&0xf);
	    translationtables [i+256] = 0x40 + (i&0xf);
	    translationtables [i+512] = 0x20 + (i&0xf);
	}
	else
	{
	    // Keep all other colors as is.
	    translationtables[i] = translationtables[i+256] 
		= translationtables[i+512] = i;
	}
    }
}




//
// R_DrawSpan 
// With DOOM style restrictions on view orientation,
//  the floors and ceilings consist of horizontal slices
//  or spans with constant z depth.
// However, rotation around the world z axis is possible,
//  thus this mapping, while simpler and faster than
//  perspective correct texture mapping, has to traverse
//  the texture at an angle in all but a few cases.
// In consequence, flats are not stored by column (like walls),
//  and the inner loop has to step in texture space u and v.
//
int			ds_y; 
int			ds_x1; 
int			ds_x2;

lighttable_t*		ds_colormap; 

fixed_t			ds_xfrac; 
fixed_t			ds_yfrac; 
fixed_t			ds_xstep; 
fixed_t			ds_ystep;

// start of a 64*64 tile image 
byte*			ds_source;	

// just for profiling
int			dscount;


//
// Draws the actual span.
void R_DrawSpan (void)
{
    fixed_t		xfrac;
    fixed_t		yfrac;
    byte*		dest;
    int			count;
    int			spot;

#ifdef RANGECHECK
    if (ds_x2 < ds_x1
	|| ds_x1<0
	|| ds_x2>=screenwidth
	|| (unsigned)ds_y>SCREENHEIGHT)
    {
	I_Error( "R_DrawSpan: %i to %i at %i",
		 ds_x1,ds_x2,ds_y);
    }
//	dscount++;
#endif


    xfrac = ds_xfrac;
    yfrac = ds_yfrac;

    dest = ylookup[ds_y] + columnofs[ds_x1];

    // We do not check for zero spans here?
    count = ds_x2 - ds_x1;

    PERF_SPAN_INC(count);

    do
    {
	// Current texture index in u,v.
	spot = ((yfrac>>(16-6))&(63*64)) + ((xfrac>>16)&63);

	// Lookup pixel from flat texture tile,
	//  re-index using light/colormap.
	// 14.2a column-major: moving right one pixel = +SCREENHEIGHT bytes.
	*dest = ds_colormap[ds_source[spot]];
	dest += SCREENHEIGHT;

	// Next step in u,v.
	xfrac += ds_xstep;
	yfrac += ds_ystep;

    } while (count--);
}



// UNUSED.
// Loop unrolled by 4.
#if 0
void R_DrawSpan (void) 
{ 
    unsigned	position, step;

    byte*	source;
    byte*	colormap;
    byte*	dest;
    
    unsigned	count;
    usingned	spot; 
    unsigned	value;
    unsigned	temp;
    unsigned	xtemp;
    unsigned	ytemp;
		
    position = ((ds_xfrac<<10)&0xffff0000) | ((ds_yfrac>>6)&0xffff);
    step = ((ds_xstep<<10)&0xffff0000) | ((ds_ystep>>6)&0xffff);
		
    source = ds_source;
    colormap = ds_colormap;
    dest = ylookup[ds_y] + columnofs[ds_x1];	 
    count = ds_x2 - ds_x1 + 1; 
	
    while (count >= 4) 
    { 
	ytemp = position>>4;
	ytemp = ytemp & 4032;
	xtemp = position>>26;
	spot = xtemp | ytemp;
	position += step;
	dest[0] = colormap[source[spot]]; 

	ytemp = position>>4;
	ytemp = ytemp & 4032;
	xtemp = position>>26;
	spot = xtemp | ytemp;
	position += step;
	dest[1] = colormap[source[spot]];
	
	ytemp = position>>4;
	ytemp = ytemp & 4032;
	xtemp = position>>26;
	spot = xtemp | ytemp;
	position += step;
	dest[2] = colormap[source[spot]];
	
	ytemp = position>>4;
	ytemp = ytemp & 4032;
	xtemp = position>>26;
	spot = xtemp | ytemp;
	position += step;
	dest[3] = colormap[source[spot]]; 
		
	count -= 4;
	dest += 4;
    } 
    while (count > 0) 
    { 
	ytemp = position>>4;
	ytemp = ytemp & 4032;
	xtemp = position>>26;
	spot = xtemp | ytemp;
	position += step;
	*dest++ = colormap[source[spot]]; 
	count--;
    } 
} 
#endif


//
// Again..
//
void R_DrawSpanLow (void) 
{ 
    fixed_t		xfrac;
    fixed_t		yfrac; 
    byte*		dest; 
    int			count;
    int			spot; 
	 
#ifdef RANGECHECK 
    if (ds_x2 < ds_x1
	|| ds_x1<0
	|| ds_x2>=screenwidth  
	|| (unsigned)ds_y>SCREENHEIGHT)
    {
	I_Error( "R_DrawSpan: %i to %i at %i",
		 ds_x1,ds_x2,ds_y);
    }
//	dscount++; 
#endif 
	 
    xfrac = ds_xfrac;
    yfrac = ds_yfrac;

    // Blocky mode, need to multiply by 2.
    // 14.2a bug-fix: compute count BEFORE the shift.
    // After ds_x1 <<= 1 and ds_x2 <<= 1, both are doubled, so (ds_x2 - ds_x1)
    // would be 2× the original span width. Each loop iteration advances by
    // 2*SCREENHEIGHT (two adjacent columns), so count must be the ORIGINAL
    // (pre-shift) span width; otherwise the loop runs 2× and overruns the buffer.
    count = ds_x2 - ds_x1;

    ds_x1 <<= 1;
    ds_x2 <<= 1;

    dest = ylookup[ds_y] + columnofs[ds_x1];

    do
    {
	spot = ((yfrac>>(16-6))&(63*64)) + ((xfrac>>16)&63);
	// Lowres/blocky mode writes two adjacent columns.
	// 14.2a column-major: adjacent columns are SCREENHEIGHT bytes apart.
	{
	    byte v = ds_colormap[ds_source[spot]];
	    *dest = v;
	    *(dest + SCREENHEIGHT) = v;
	    dest += 2*SCREENHEIGHT;
	}

	xfrac += ds_xstep;
	yfrac += ds_ystep;

    } while (count--);
}

//
// R_InitBuffer 
// Creats lookup tables that avoid
//  multiplies and other hazzles
//  for getting the framebuffer address
//  of a pixel to draw.
//
void
R_InitBuffer
( int		width,
  int		height ) 
{ 
    int		i; 

    // Handle resize,
    //  e.g. smaller view windows
    //  with border and/or status bar.
    viewwindowx = (screenwidth-width) >> 1;

    // 14.2a column-major layout: screens[n][x*SCREENHEIGHT + y].
    // columnofs[x] = byte offset of column (viewwindowx+x) from screens[0] base.
    // ylookup[y]   = screens[0] + (viewwindowy+y), the row offset within any column.
    // pixel(x,y)   = ylookup[y] + columnofs[x]  (same formula, different values).
    for (i=0 ; i<width ; i++)
	columnofs[i] = (viewwindowx + i) * SCREENHEIGHT;

    // Same with base row offset.
    if (width == screenwidth)
	viewwindowy = 0;
    else
	viewwindowy = (SCREENHEIGHT-SBARHEIGHT-height) >> 1;

    // Precalculate all row offsets into screens[0].
    for (i=0 ; i<height ; i++)
	ylookup[i] = screens[0] + (i+viewwindowy);
} 
 
 


//
// R_FillBackScreen
// Fills the back screen with a pattern
//  for variable screen sizes
// Also draws a beveled edge.
//
void R_FillBackScreen (void) 
{ 
    byte*	src;
    byte*	dest; 
    int		x;
    int		y; 
    patch_t*	patch;

    // DOOM border patch.
    char	name1[] = "FLOOR7_2";

    // DOOM II border patch.
    char	name2[] = "GRNROCK";	

    char*	name;
	
    if (scaledviewwidth == 320)
	return;
	
    if ( gamemode == commercial)
	name = name2;
    else
	name = name1;
    
    src = W_CacheLumpName (name, PU_CACHE);
    /* 14.2a column-major: fill screens[1] column by column.
       screens[1] pixel at (x,y) lives at screens[1] + x*SCREENHEIGHT + y.
       Flat tile is 64x64; src[((y&63)<<6)+(x&63)] gives the tile pixel. */
    for (x=0 ; x<screenwidth ; x++)
    {
	dest = screens[1] + x * SCREENHEIGHT;
	for (y=0 ; y<SCREENHEIGHT-SBARHEIGHT ; y++)
	    *dest++ = src[((y&63)<<6) + (x&63)];
    }
	
    patch = W_CacheLumpName ("brdr_t",PU_CACHE);

    for (x=0 ; x<scaledviewwidth ; x+=8)
	V_DrawPatch (viewwindowx+x,viewwindowy-8,1,patch);
    patch = W_CacheLumpName ("brdr_b",PU_CACHE);

    for (x=0 ; x<scaledviewwidth ; x+=8)
	V_DrawPatch (viewwindowx+x,viewwindowy+viewheight,1,patch);
    patch = W_CacheLumpName ("brdr_l",PU_CACHE);

    for (y=0 ; y<viewheight ; y+=8)
	V_DrawPatch (viewwindowx-8,viewwindowy+y,1,patch);
    patch = W_CacheLumpName ("brdr_r",PU_CACHE);

    for (y=0 ; y<viewheight ; y+=8)
	V_DrawPatch (viewwindowx+scaledviewwidth,viewwindowy+y,1,patch);


    // Draw beveled edge. 
    V_DrawPatch (viewwindowx-8,
		 viewwindowy-8,
		 1,
		 W_CacheLumpName ("brdr_tl",PU_CACHE));
    
    V_DrawPatch (viewwindowx+scaledviewwidth,
		 viewwindowy-8,
		 1,
		 W_CacheLumpName ("brdr_tr",PU_CACHE));
    
    V_DrawPatch (viewwindowx-8,
		 viewwindowy+viewheight,
		 1,
		 W_CacheLumpName ("brdr_bl",PU_CACHE));
    
    V_DrawPatch (viewwindowx+scaledviewwidth,
		 viewwindowy+viewheight,
		 1,
		 W_CacheLumpName ("brdr_br",PU_CACHE));
} 
 

//
// Copy a screen buffer — column-major version (14.2a).
// Copies rectangle (x, y, width, height) from screens[1] to screens[0].
// In column-major storage the copy is one memcpy per column.
//
void
R_VideoErase
( int		x,
  int		y,
  int		width,
  int		height )
{
    int cx;
    for (cx = x; cx < x + width; cx++)
        memcpy (screens[0] + cx * SCREENHEIGHT + y,
                screens[1] + cx * SCREENHEIGHT + y,
                (size_t)height);
}


//
// R_DrawViewBorder
// Draws the border around the view
//  for different size windows?
//
void
V_MarkRect
( int		x,
  int		y,
  int		width,
  int		height ); 
 
void R_DrawViewBorder (void)
{
    int		top;
    int		side;

    if (scaledviewwidth == screenwidth)
	return;

    top  = ((SCREENHEIGHT-SBARHEIGHT)-viewheight)/2;
    side = (screenwidth-scaledviewwidth)/2;

    // 14.2a column-major: express border as four explicit axis-aligned rects.
    // Top border: full width, rows [0, top)
    R_VideoErase (0, 0, screenwidth, top);
    // Bottom border: full width, rows [viewheight+top, viewheight+2*top)
    R_VideoErase (0, viewheight+top, screenwidth, top);
    // Left side: columns [0, side), rows [top, viewheight+top)
    R_VideoErase (0, top, side, viewheight);
    // Right side: columns [screenwidth-side, screenwidth), rows [top, viewheight+top)
    R_VideoErase (screenwidth-side, top, side, viewheight);

    V_MarkRect (0, 0, screenwidth, SCREENHEIGHT-SBARHEIGHT);
}
 
 
