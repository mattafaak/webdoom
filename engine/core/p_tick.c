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
//	Archiving: SaveGame I/O.
//	Thinker, Ticker.
//
//-----------------------------------------------------------------------------

static const char
rcsid[] = "$Id: p_tick.c,v 1.4 1997/02/03 16:47:55 b1 Exp $";

#include "z_zone.h"
#include "p_local.h"

#include "doomstat.h"

// webdoom task 8.1: frozen-surface invariant asserts.
// Include inside the #ifdef to stay zero-cost when the flag is off.
#ifdef WEBDOOM_INVARIANTS
#include "doomassert.h"
#endif


int	leveltime;

//
// THINKERS
// All thinkers should be allocated by Z_Malloc
// so they can be operated on uniformly.
// The actual structures will vary in size,
// but the first element must be thinker_t.
//



// Both the head and tail of the thinker list.
thinker_t	thinkercap;


//
// P_InitThinkers
//
void P_InitThinkers (void)
{
    thinkercap.prev = thinkercap.next  = &thinkercap;
}




//
// P_AddThinker
// Adds a new thinker at the end of the list.
//
void P_AddThinker (thinker_t* thinker)
{
    thinkercap.prev->next = thinker;
    thinker->next = &thinkercap;
    thinker->prev = thinkercap.prev;
    thinkercap.prev = thinker;

#ifdef WEBDOOM_INVARIANTS
    // §16 invariant: insertion order — new thinker must land at the tail.
    // thinkercap.prev is updated on the last line above; it must now point
    // to the thinker we just inserted.  Not tautological: if the insertion
    // logic ever changes (e.g., inserting at head instead of tail), this
    // fires at the exact call site rather than producing a demo desync.
    DOOM_ASSERT(thinkercap.prev == thinker
		&& "P_AddThinker: new thinker not at tail -- insertion order broken");
    // NOTE: do NOT assert here that thinker->function.acv != (actionf_v)(-1)
    // ("not already sentinel-marked").  That reads UNINITIALISED memory and
    // fires on stock vanilla demos (10/13).  Every non-mobj thinker caller
    // allocates with Z_Malloc, which does not zero, and calls P_AddThinker
    // BEFORE assigning .function -- e.g. p_doors.c:
    //     door = Z_Malloc (sizeof(*door), PU_LEVSPEC, 0);
    //     P_AddThinker (&door->thinker);            // .function still garbage
    //     door->thinker.function.acp1 = T_VerticalDoor;
    // p_doors/p_lights/p_plats/p_ceilng/p_floor do 14 Z_Mallocs and 0 memsets;
    // only P_SpawnMobj zeroes (p_mobj.c).  Since P_RemoveThinker writes exactly
    // (actionf_v)(-1) and the block is later Z_Free'd back to the zone, a
    // recycled block legitimately still holds -1.  The value is undefined until
    // the caller assigns it, so no invariant exists here to assert.
#endif
}



//
// P_RemoveThinker
// Deallocation is lazy -- it will not actually be freed
// until its thinking turn comes up.
//
void P_RemoveThinker (thinker_t* thinker)
{
  // FIXME: NOP.
  thinker->function.acv = (actionf_v)(-1);
}



//
// P_AllocateThinker
// Allocates memory and adds a new thinker at the end of the list.
//
void P_AllocateThinker (thinker_t*	thinker)
{
}



//
// P_RunThinkers
//
void P_RunThinkers (void)
{
    thinker_t*	currentthinker;
    thinker_t*	nextthinker;

    currentthinker = thinkercap.next;

#ifdef WEBDOOM_INVARIANTS
    // §16 invariant: traversal direction — must walk head → tail.
    // thinkercap.next is the head (first real thinker); thinkercap.prev is
    // the tail.  If the circular list is not empty, head != thinkercap.
    // The assert checks the STARTING point is thinkercap.next (head), not
    // thinkercap.prev (tail) — a reversed traversal would change which thinker
    // acts "first" each tic and desync demos.
    // Non-tautological: if the loop initializer is changed to thinkercap.prev,
    // this fires on the first tic that has any thinker in the list.
    DOOM_ASSERT(currentthinker == thinkercap.next
		&& "P_RunThinkers: traversal start is not thinkercap.next (head)");
#endif

    while (currentthinker != &thinkercap)
    {
	// webdoom fix (task 3.1): cache next before any free so ASan does not
	// flag the advance as a use-after-free.  Behavior is identical: the
	// deferred-free sentinel guarantees next/prev are intact at this point,
	// and Z_Zone does not zero freed blocks, so the advance was always safe
	// in practice -- but it IS undefined behavior and must be eliminated.
	nextthinker = currentthinker->next;

	if ( currentthinker->function.acv == (actionf_v)(-1) )
	{
	    // time to remove it
	    currentthinker->next->prev = currentthinker->prev;
	    currentthinker->prev->next = currentthinker->next;
	    Z_Free (currentthinker);
	}
	else
	{
	    if (currentthinker->function.acp1)
		currentthinker->function.acp1 (currentthinker);
	}
	currentthinker = nextthinker;
    }
}



//
// P_Ticker
//

void P_Ticker (void)
{
    int		i;

    // run the tic
    if (paused)
	return;

    // pause if in menu and at least one tic has been run
    if ( !netgame
	 && menuactive
	 && !demoplayback
	 && players[consoleplayer].viewz != 1)
    {
	return;
    }


    // webdoom: previous-tic sector heights for render interpolation
    for (i=0 ; i<numsectors ; i++)
    {
	sectors[i].oldfloorheight = sectors[i].floorheight;
	sectors[i].oldceilingheight = sectors[i].ceilingheight;
    }

    for (i=0 ; i<MAXPLAYERS ; i++)
	if (playeringame[i])
	    P_PlayerThink (&players[i]);

    P_RunThinkers ();
    P_UpdateSpecials ();
    P_RespawnSpecials ();

    // for par times
    leveltime++;
}
