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
//	Gamma correction LUT.
//	Functions to draw patches (by post) directly to screen.
//	Functions to blit a block to the screen.
//
//-----------------------------------------------------------------------------


#ifndef __V_VIDEO__
#define __V_VIDEO__

#include "doomtype.h"

#include "doomdef.h"

// Needed because we are refering to patches.
#include "r_data.h"

//
// VIDEO
//

#define CENTERY			(SCREENHEIGHT/2)


// Screen 0 is the screen updated by I_Update screen.
// Screen 1 is an extra buffer.



extern	byte*		screens[5];

#ifdef LEAN_SCREENS
// LEAN_SCREENS (a port's opt-in; tools/freestanding LEAN=1): only screens[0]
// is permanent.  The others exist while something needs them:
//   screens[1]  the back screen: the view border's pattern while a level is
//               played in a narrowed view, the intermission's background.
//               A zone block tagged PU_LEVEL, so the next level load frees
//               it; a widened view frees it at once.  V_BackScreen holds it
//               and names the owner's function that draws it.  Nothing reads
//               it while a melt runs, so a wipe gives it back to the zone for
//               the melt and its owner draws it again after: a wipe holds two
//               screens, never three.
//   screens[2]  the wipe's start and end screens, held by f_wipe.c from
//   screens[3]  wipe_StartScreen/wipe_EndScreen until the melt ends, or
//               until the frame after a platform cuts the wipe short.
//   screens[4]  the status bar's background: only rows 0..V_SBARHEIGHT-1 are
//               ever drawn or read, so it is that many rows at that column
//               stride (vanilla allocates a whole screen).
// A screen's block is owned by its screens[] slot: Z_Free, whoever calls
// it, leaves the slot NULL.  So a read after release is a NULL dereference,
// never another block's pixels.
#define V_SBARHEIGHT	32
#ifndef V_SBARSTRIDE
#define V_SBARSTRIDE	V_SBARHEIGHT
#endif
#define V_SBARBYTES	((SCREENWIDTH-1)*V_SBARSTRIDE + V_SBARHEIGHT)
#define V_STRIDE(s)	((s) == 4 ? V_SBARSTRIDE : SCREENHEIGHT)
#define V_ROWS(s)	((s) == 4 ? V_SBARHEIGHT : SCREENHEIGHT)

byte*	V_HoldScreen (int scrn, int tag);	// screens[scrn], allocated if absent
void	V_ReleaseScreen (int scrn);		// back to the zone, if held
byte*	V_BackScreen (void (*redraw) (void));	// screens[1] for this level, zeroed when new
void	V_SuspendBackScreen (void);		// the wipe's: back to the zone for the melt
void	V_ResumeBackScreen (void);		// ...and drawn again by its owner after
void	V_DrawPatchStrip (int x, int y, patch_t* patch);	// V_DrawPatch's screen 4
#endif

extern  int	dirtybox[4];

extern	byte	gammatable[5][256];
extern	int	usegamma;



// Allocates buffer screens, call before R_Init.
void V_Init (void);


void
V_CopyRect
( int		srcx,
  int		srcy,
  int		srcscrn,
  int		width,
  int		height,
  int		destx,
  int		desty,
  int		destscrn );

void
V_DrawPatch
( int		x,
  int		y,
  int		scrn,
  patch_t*	patch);

void
V_DrawPatchDirect
( int		x,
  int		y,
  int		scrn,
  patch_t*	patch );


// Draw a linear block of pixels into the view buffer.
void
V_DrawBlock
( int		x,
  int		y,
  int		scrn,
  int		width,
  int		height,
  byte*		src );

// Reads a linear block of pixels into the view buffer.
void
V_GetBlock
( int		x,
  int		y,
  int		scrn,
  int		width,
  int		height,
  byte*		dest );


void
V_MarkRect
( int		x,
  int		y,
  int		width,
  int		height );

#endif
//-----------------------------------------------------------------------------
//
// $Log:$
//
//-----------------------------------------------------------------------------
