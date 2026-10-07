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
//	Mission begin melt/wipe screen special effect.
//
//-----------------------------------------------------------------------------


static const char rcsid[] = "$Id: f_wipe.c,v 1.2 1997/02/03 22:45:09 b1 Exp $";



#include "z_zone.h"
#include "i_video.h"
#include "v_video.h"
#include "m_random.h"

#include "doomdef.h"

#include "f_wipe.h"
#ifdef LEAN_SCREENS
#include "i_system.h"
#endif

//
//                       SCREEN WIPE PACKAGE
//

// when zero, stop the wipe
static boolean	go = 0;

static byte*	wipe_scr_start;
static byte*	wipe_scr_end;
static byte*	wipe_scr;


void
wipe_shittyColMajorXform
( short*	array,
  int		width,
  int		height )
{
    /* screens[] are column-major (pixel(x,y) = base[x*height+y]),
       so the input is no longer row-major shorts.  Rebuild the short-
       column-major layout doMelt expects — dest[i*height+y] = the pixel
       pair (2i,y),(2i+1,y) — by packing the two byte columns explicitly.
       Packing and unpacking (doMelt) are both explicit lo=2i / hi=2i+1,
       so the transform is endian-independent (vanilla relied on LE
       short punning). */
    const byte*	src = (const byte*) array;
    int		i;
    int		y;
    short*	dest;

#ifdef LEAN_SCREENS
    /* In place, one pair of byte columns at a time: short-column i takes
       exactly the bytes of byte columns 2i and 2i+1, so a copy of that
       pair is all the scratch it needs (vanilla's is a whole screen from
       the zone).  Same bytes out. */
    byte	pair[2*SCREENHEIGHT];

    if (height > SCREENHEIGHT)
	I_Error ("wipe_shittyColMajorXform: height %d", height);
    dest = array;
    for(i=0;i<width;i++)
    {
	memcpy(pair, src + (2*i)*height, 2*height);
	for(y=0;y<height;y++)
	    dest[i*height+y] = (short)(pair[y] | (pair[height+y] << 8));
    }
#else
    dest = (short*) Z_Malloc(width*height*2, PU_STATIC, 0);

    for(i=0;i<width;i++)
	for(y=0;y<height;y++)
	    dest[i*height+y] = (short)(src[(2*i)*height+y]
				       | (src[(2*i+1)*height+y] << 8));

    memcpy(array, dest, width*height*2);

    Z_Free(dest);
#endif

}

int
wipe_initColorXForm
( int	width,
  int	height,
  int	ticks )
{
    memcpy(wipe_scr, wipe_scr_start, width*height);
    return 0;
}

int
wipe_doColorXForm
( int	width,
  int	height,
  int	ticks )
{
    boolean	changed;
    byte*	w;
    byte*	e;
    int		newval;

    changed = false;
    w = wipe_scr;
    e = wipe_scr_end;
    
    while (w!=wipe_scr+width*height)
    {
	if (*w != *e)
	{
	    if (*w > *e)
	    {
		newval = *w - ticks;
		if (newval < *e)
		    *w = *e;
		else
		    *w = newval;
		changed = true;
	    }
	    else if (*w < *e)
	    {
		newval = *w + ticks;
		if (newval > *e)
		    *w = *e;
		else
		    *w = newval;
		changed = true;
	    }
	}
	w++;
	e++;
    }

    return !changed;

}

int
wipe_exitColorXForm
( int	width,
  int	height,
  int	ticks )
{
    return 0;
}


static int*	y;
#ifdef LEAN_SCREENS
// The melt's column offsets, static here: a wipe a platform cuts short keeps
// them for the next one (vanilla leaves its zone block allocated), and
// allocated after the two borrowed screens that block would stay behind as a
// PU_STATIC island in the middle of the zone once they are freed.
static int	ybuf[SCREENWIDTH];
#endif

int
wipe_initMelt
( int	width,
  int	height,
  int	ticks )
{
    int i, r;
    
    // copy start screen to main screen
    memcpy(wipe_scr, wipe_scr_start, width*height);
    
    // makes this wipe faster (in theory)
    // to have stuff in column-major format
    wipe_shittyColMajorXform((short*)wipe_scr_start, width/2, height);
    wipe_shittyColMajorXform((short*)wipe_scr_end, width/2, height);
    
    // setup initial column positions
    // (y<0 => not ready to scroll yet)
#ifdef LEAN_SCREENS
    if (width > SCREENWIDTH)
	I_Error ("wipe_initMelt: width %d", width);
    y = ybuf;
#else
    y = (int *) Z_Malloc(width*sizeof(int), PU_STATIC, 0);
#endif
    y[0] = -(M_Random()%16);
    for (i=1;i<width;i++)
    {
	r = (M_Random()%3) - 1;
	y[i] = y[i-1] + r;
	if (y[i] > 0) y[i] = 0;
	else if (y[i] == -16) y[i] = -15;
    }

    return 0;
}

int
wipe_doMelt
( int	width,
  int	height,
  int	ticks )
{
    int		i;
    int		j;
    int		dy;

    short*	s;
    byte*	dlo;
    byte*	dhi;
    boolean	done = true;

    width/=2;

    while (ticks--)
    {
	for (i=0;i<width;i++)
	{
	    if (y[i]<0)
	    {
		y[i]++; done = false;
	    }
	    else if (y[i] < height)
	    {
		dy = (y[i] < 16) ? y[i]+1 : 8;
		if (y[i]+dy >= height) dy = height - y[i];
		s = &((short *)wipe_scr_end)[i*height+y[i]];
		/* column-major wipe_scr: short-column i row r is the
		   byte pair (2i,r),(2i+1,r) = wipe_scr[(2i)*height+r] and
		   wipe_scr[(2i+1)*height+r].  Unpack lo/hi explicitly to
		   match the explicit pack in wipe_shittyColMajorXform. */
		dlo = wipe_scr + (2*i)*height + y[i];
		dhi = dlo + height;
		for (j=dy;j;j--)
		{
		    short v = *(s++);
		    *dlo++ = (byte)(v & 0xff);
		    *dhi++ = (byte)((v >> 8) & 0xff);
		}
		y[i] += dy;
		s = &((short *)wipe_scr_start)[i*height];
		dlo = wipe_scr + (2*i)*height + y[i];
		dhi = dlo + height;
		for (j=height-y[i];j;j--)
		{
		    short v = *(s++);
		    *dlo++ = (byte)(v & 0xff);
		    *dhi++ = (byte)((v >> 8) & 0xff);
		}
		done = false;
	    }
	}
    }

    return done;

}

int
wipe_exitMelt
( int	width,
  int	height,
  int	ticks )
{
#ifndef LEAN_SCREENS
    Z_Free(y);
#endif
    return 0;
}

int
wipe_StartScreen
( int	x,
  int	y,
  int	width,
  int	height )
{
#ifdef LEAN_SCREENS
    wipe_scr_start = V_HoldScreen(2, PU_STATIC);
#else
    wipe_scr_start = screens[2];
#endif
    I_ReadScreen(wipe_scr_start);
    return 0;
}

int
wipe_EndScreen
( int	x,
  int	y,
  int	width,
  int	height )
{
#ifdef LEAN_SCREENS
    // nothing reads the back screen while the melt runs: its memory is the
    // end screen's for now (V_SuspendBackScreen)
    V_SuspendBackScreen();
    wipe_scr_end = V_HoldScreen(3, PU_STATIC);
#else
    wipe_scr_end = screens[3];
#endif
    I_ReadScreen(wipe_scr_end);
    /* wipe_scr_start is a raw copy of column-major screens[0]
       (I_ReadScreen), so restoring it is a raw copy back — V_DrawBlock
       now expects a row-major source block and would transpose it. */
    memcpy(screens[0], wipe_scr_start, width*height); // restore start scr.
    return 0;
}

int
wipe_ScreenWipe
( int	wipeno,
  int	x,
  int	y,
  int	width,
  int	height,
  int	ticks )
{
    int rc;
    static int (*wipes[])(int, int, int) =
    {
	wipe_initColorXForm, wipe_doColorXForm, wipe_exitColorXForm,
	wipe_initMelt, wipe_doMelt, wipe_exitMelt
    };

    void V_MarkRect(int, int, int, int);

    // initial stuff
    if (!go)
    {
	go = 1;
	// wipe_scr = (byte *) Z_Malloc(width*height, PU_STATIC, 0); // DEBUG
	wipe_scr = screens[0];
	(*wipes[wipeno*3])(width, height, ticks);
    }

    // do a piece of wipe-in
    V_MarkRect(0, 0, width, height);
    rc = (*wipes[wipeno*3+1])(width, height, ticks);
    //  V_DrawBlock(x, y, 0, width, height, wipe_scr); // DEBUG

    // final stuff
    if (rc)
    {
	go = 0;
	(*wipes[wipeno*3+2])(width, height, ticks);
#ifdef LEAN_SCREENS
	wipe_Release();
#endif
    }

    return !go;

}

#ifdef LEAN_SCREENS
// Both screens back to the zone, and the melt's own pointers to them
// cleared, so a melt step after this dereferences NULL instead of reading
// freed memory; then the back screen, if the wipe had it, is drawn again.
// A wipe cut short keeps vanilla's state otherwise: `go` stays set and `y`
// keeps its columns, so the next wipe resumes them on fresh captures, as
// vanilla's does on its static screens.
void wipe_Release (void)
{
    V_ReleaseScreen(2);
    V_ReleaseScreen(3);
    wipe_scr_start = wipe_scr_end = NULL;
    V_ResumeBackScreen();
}
#endif
