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
//	Put all global tate variables here.
//
//-----------------------------------------------------------------------------

static const char
rcsid[] = "$Id: m_bbox.c,v 1.1 1997/02/03 22:45:10 b1 Exp $";


#ifdef __GNUG__
#pragma implementation "doomstat.h"
#endif
#include "doomstat.h"


// Runtime screen width: starts at 320 (the canonical DOOM render width).
// MAXSCREENWIDTH (854) is the compile-time static-array cap only; it does not
// determine the initial render resolution.  web_set_wide(W) changes this at
// runtime to enable Hor+ widescreen (task 18.2c).
int screenwidth = DOOM_ORIGWIDTH;

// Game Mode - identify IWAD as shareware, retail etc.
GameMode_t gamemode = indetermined;
GameMission_t	gamemission = doom;

// Language.
Language_t   language = english;

// Set if homebrew PWAD stuff has been added.
boolean	modifiedgame;




