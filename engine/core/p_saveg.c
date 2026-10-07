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
//
//-----------------------------------------------------------------------------

static const char
rcsid[] = "$Id: p_tick.c,v 1.4 1997/02/03 16:47:55 b1 Exp $";

#include "i_system.h"
#include "z_zone.h"
#include "p_local.h"

// State.
#include "doomstat.h"
#include "r_state.h"

byte*		save_p;

// webdoom: the end of the savegame being loaded.  A save is untrusted input
// -- it may come from another WAD, be cut short or be edited -- so every
// read is checked against this, and every index read from the file against
// the array it selects, before either is used.
byte*		save_end;

extern int	numflats;
extern int	numtextures;

static void P_SaveNeed (int n)
{
    if (save_end - save_p < n)
	I_Error ("Savegame is truncated");
}

static void P_SaveBad (char* what, int value)
{
    I_Error ("Savegame does not match this game: %s %d", what, value);
}

static void P_SaveSector (int sector)
{
    if ((unsigned) sector >= numsectors)
	P_SaveBad ("sector", sector);
}


// Pads save_p to a 4-byte boundary
//  so that the load/save works on SGI&Gecko.
#define PADSAVEP()	save_p += (4 - ((int) save_p & 3)) & 3


//
// P_ArchiveSize
// An upper bound on what the four P_Archive* functions write for the
// current level, so the caller can size the buffer before writing into it.
// Every thinker is archived at most once, as a class byte, up to 3 bytes of
// padding and its struct, and mobj_t is the largest struct archived.
//
_Static_assert(sizeof(mobj_t) >= sizeof(ceiling_t)
	       && sizeof(mobj_t) >= sizeof(vldoor_t)
	       && sizeof(mobj_t) >= sizeof(floormove_t)
	       && sizeof(mobj_t) >= sizeof(plat_t)
	       && sizeof(mobj_t) >= sizeof(lightflash_t)
	       && sizeof(mobj_t) >= sizeof(strobe_t)
	       && sizeof(mobj_t) >= sizeof(glow_t),
	       "P_ArchiveSize bounds every archived thinker by sizeof(mobj_t)");

int P_ArchiveSize (void)
{
    thinker_t*	th;
    int		size;
    int		i;
    int		j;

    size = MAXPLAYERS * (3 + sizeof(player_t));

    size += numsectors * 7 * sizeof(short);
    for (i=0 ; i<numlines ; i++)
    {
	size += 3 * sizeof(short);
	for (j=0 ; j<2 ; j++)
	    if (lines[i].sidenum[j] != -1)
		size += 5 * sizeof(short);
    }

    for (th = thinkercap.next ; th != &thinkercap ; th=th->next)
	size += 1 + 3 + sizeof(mobj_t);

    // tc_end and tc_endspecials
    return size + 2;
}



//
// P_ArchivePlayers
//
void P_ArchivePlayers (void)
{
    int		i;
    int		j;
    player_t*	dest;
		
    for (i=0 ; i<MAXPLAYERS ; i++)
    {
	if (!playeringame[i])
	    continue;
	
	PADSAVEP();

	dest = (player_t *)save_p;
	memcpy (dest,&players[i],sizeof(player_t));
	save_p += sizeof(player_t);
	for (j=0 ; j<NUMPSPRITES ; j++)
	{
	    if (dest->psprites[j].state)
	    {
		dest->psprites[j].state 
		    = (state_t *)(dest->psprites[j].state-states);
	    }
	}
    }
}



//
// P_UnArchivePlayers
//
void P_UnArchivePlayers (void)
{
    int		i;
    int		j;
	
    for (i=0 ; i<MAXPLAYERS ; i++)
    {
	if (!playeringame[i])
	    continue;
	
	PADSAVEP();
	P_SaveNeed (sizeof(player_t));

	memcpy (&players[i],save_p, sizeof(player_t));
	save_p += sizeof(player_t);
	
	// will be set when unarc thinker
	players[i].mo = NULL;	
	players[i].message = NULL;
	players[i].attacker = NULL;

	// webdoom: these index weaponinfo[], the colormaps and the palettes;
	// P_DamageMobj caps damagecount at 100, and bonuscount grows by
	// BONUSADD per pickup
	if ((unsigned) players[i].readyweapon >= NUMWEAPONS)
	    P_SaveBad ("ready weapon", players[i].readyweapon);
	if ((unsigned) players[i].pendingweapon >= NUMWEAPONS
	    && players[i].pendingweapon != wp_nochange)
	    P_SaveBad ("pending weapon", players[i].pendingweapon);
	if ((unsigned) players[i].fixedcolormap > NUMCOLORMAPS)
	    P_SaveBad ("fixed colormap", players[i].fixedcolormap);
	if ((unsigned) players[i].damagecount > 100)
	    P_SaveBad ("damage count", players[i].damagecount);
	if ((unsigned) players[i].bonuscount > 0xffff)
	    P_SaveBad ("bonus count", players[i].bonuscount);

	for (j=0 ; j<NUMPSPRITES ; j++)
	{
	    if (players[i]. psprites[j].state)
	    {
		if ((unsigned) (int) players[i].psprites[j].state >= NUMSTATES)
		    P_SaveBad ("weapon state",
			       (int) players[i].psprites[j].state);
		players[i]. psprites[j].state 
		    = &states[ (int)players[i].psprites[j].state ];
	    }
	}
    }
}


//
// P_ArchiveWorld
//
void P_ArchiveWorld (void)
{
    int			i;
    int			j;
    sector_t*		sec;
    line_t*		li;
    side_t*		si;
    short*		put;
	
    put = (short *)save_p;
    
    // do sectors
    for (i=0, sec = sectors ; i<numsectors ; i++,sec++)
    {
	*put++ = sec->floorheight >> FRACBITS;
	*put++ = sec->ceilingheight >> FRACBITS;
	*put++ = sec->floorpic;
	*put++ = sec->ceilingpic;
	*put++ = sec->lightlevel;
	*put++ = sec->special;		// needed?
	*put++ = sec->tag;		// needed?
    }

    
    // do lines
    for (i=0, li = lines ; i<numlines ; i++,li++)
    {
	*put++ = li->flags;
	*put++ = li->special;
	*put++ = li->tag;
	for (j=0 ; j<2 ; j++)
	{
	    if (li->sidenum[j] == -1)
		continue;
	    
	    si = &sides[li->sidenum[j]];

	    *put++ = SIDE_TEXOFS(si) >> FRACBITS;
	    *put++ = SIDE_ROWOFS(si) >> FRACBITS;
	    *put++ = si->toptexture;
	    *put++ = si->bottomtexture;
	    *put++ = si->midtexture;	
	}
    }
	
    save_p = (byte *)put;
}



//
// P_UnArchiveWorld
//
void P_UnArchiveWorld (void)
{
    int			i;
    int			j;
    sector_t*		sec;
    line_t*		li;
    side_t*		si;
    short*		get;
    int			size;
	
    // webdoom: the world has no count of its own; it must fit what is left
    size = numsectors * 7;
    for (i=0, li = lines ; i<numlines ; i++,li++)
	size += 3 + 5 * ((li->sidenum[0] != -1) + (li->sidenum[1] != -1));
    P_SaveNeed (size * sizeof(short));

    get = (short *)save_p;
    
    // do sectors
    for (i=0, sec = sectors ; i<numsectors ; i++,sec++)
    {
	sec->floorheight = *get++ << FRACBITS;
	sec->ceilingheight = *get++ << FRACBITS;
	sec->oldfloorheight = sec->floorheight;		/* webdoom: snap */
	sec->oldceilingheight = sec->ceilingheight;
	sec->floorpic = *get++;
	sec->ceilingpic = *get++;
	if ((unsigned) sec->floorpic >= numflats)
	    P_SaveBad ("flat", sec->floorpic);
	if ((unsigned) sec->ceilingpic >= numflats)
	    P_SaveBad ("flat", sec->ceilingpic);
	sec->lightlevel = *get++;
	sec->special = *get++;		// needed?
	sec->tag = *get++;		// needed?
	sec->specialdata = 0;
	sec->soundtarget = 0;
    }
    
    // do lines
    for (i=0, li = lines ; i<numlines ; i++,li++)
    {
	li->flags = *get++;
	li->special = *get++;
	li->tag = *get++;
	for (j=0 ; j<2 ; j++)
	{
	    if (li->sidenum[j] == -1)
		continue;
	    si = &sides[li->sidenum[j]];
#ifdef LEAN_LEVELS
	    si->textureoffset16 = *get++;	// the same, as r_defs.h keeps it
	    si->rowoffset16 = *get++;
#else
	    si->textureoffset = *get++ << FRACBITS;
	    si->rowoffset = *get++ << FRACBITS;
#endif
	    si->toptexture = *get++;
	    si->bottomtexture = *get++;
	    si->midtexture = *get++;
	    if ((unsigned) si->toptexture >= numtextures)
		P_SaveBad ("texture", si->toptexture);
	    if ((unsigned) si->bottomtexture >= numtextures)
		P_SaveBad ("texture", si->bottomtexture);
	    if ((unsigned) si->midtexture >= numtextures)
		P_SaveBad ("texture", si->midtexture);
	}
    }
    save_p = (byte *)get;	
}





//
// Thinkers
//
typedef enum
{
    tc_end,
    tc_mobj

} thinkerclass_t;



//
// P_ArchiveThinkers
//
void P_ArchiveThinkers (void)
{
    thinker_t*		th;
    mobj_t*		mobj;
	
    // save off the current thinkers
    for (th = thinkercap.next ; th != &thinkercap ; th=th->next)
    {
	if (th->function.acp1 == (actionf_p1)P_MobjThinker)
	{
	    *save_p++ = tc_mobj;
	    PADSAVEP();
	    mobj = (mobj_t *)save_p;
	    memcpy (mobj, th, sizeof(*mobj));
	    save_p += sizeof(*mobj);
	    mobj->state = (state_t *)(mobj->state - states);
	    
	    if (mobj->player)
		mobj->player = (player_t *)((mobj->player-players) + 1);
	    continue;
	}
		
	// I_Error ("P_ArchiveThinkers: Unknown thinker function");
    }

    // add a terminating marker
    *save_p++ = tc_end;	
}



//
// P_UnArchiveThinkers
//
void P_UnArchiveThinkers (void)
{
    byte		tclass;
    thinker_t*		currentthinker;
    thinker_t*		next;
    mobj_t*		mobj;
    int			i;
    
    // remove all the current thinkers
    currentthinker = thinkercap.next;
    while (currentthinker != &thinkercap)
    {
	next = currentthinker->next;
	
	if (currentthinker->function.acp1 == (actionf_p1)P_MobjThinker)
	    P_RemoveMobj ((mobj_t *)currentthinker);
	else
	    Z_Free (currentthinker);

	currentthinker = next;
    }
    P_InitThinkers ();
	
    // read in saved thinkers
    while (1)
    {
	P_SaveNeed (1);
	tclass = *save_p++;
	switch (tclass)
	{
	  case tc_end:
	    // webdoom: every player in the game needs a body
	    for (i=0 ; i<MAXPLAYERS ; i++)
		if (playeringame[i] && !players[i].mo)
		    P_SaveBad ("no mobj for player", i+1);
	    return; 	// end of list
			
	  case tc_mobj:
	    PADSAVEP();
	    P_SaveNeed (sizeof(*mobj));
	    mobj = Z_Malloc (sizeof(*mobj), PU_LEVEL, NULL);
	    memcpy (mobj, save_p, sizeof(*mobj));
	    save_p += sizeof(*mobj);
	    // webdoom: these index states[], mobjinfo[], players[] and
	    // playeringame[], and opposite[] (DI_NODIR is 8, p_enemy.c)
	    if ((unsigned) (int) mobj->state >= NUMSTATES)
		P_SaveBad ("mobj state", (int) mobj->state);
	    if ((unsigned) mobj->type >= NUMMOBJTYPES)
		P_SaveBad ("mobj type", mobj->type);
	    if ((unsigned) (int) mobj->player > MAXPLAYERS
		|| (mobj->player && !playeringame[(int) mobj->player - 1]))
		P_SaveBad ("mobj player", (int) mobj->player);
	    if ((unsigned) mobj->lastlook >= MAXPLAYERS)
		P_SaveBad ("mobj lastlook", mobj->lastlook);
	    if ((unsigned) mobj->movedir > 8)
		P_SaveBad ("mobj movedir", mobj->movedir);
	    // webdoom: no interpolation streak out of a loaded game
	    mobj->oldx = mobj->x;
	    mobj->oldy = mobj->y;
	    mobj->oldz = mobj->z;
	    mobj->oldangle = mobj->angle;
	    mobj->state = &states[(int)mobj->state];
	    mobj->target = NULL;
	    // webdoom: a raw pointer from the file, as target is; Chocolate
	    // Doom drops it too
	    mobj->tracer = NULL;
	    if (mobj->player)
	    {
		mobj->player = &players[(int)mobj->player-1];
		mobj->player->mo = mobj;
	    }
	    P_SetThingPosition (mobj);
	    mobj->info = &mobjinfo[mobj->type];
	    mobj->floorz = mobj->subsector->sector->floorheight;
	    mobj->ceilingz = mobj->subsector->sector->ceilingheight;
	    mobj->thinker.function.acp1 = (actionf_p1)P_MobjThinker;
	    P_AddThinker (&mobj->thinker);
	    break;
			
	  default:
	    I_Error ("Unknown tclass %i in savegame",tclass);
	}
	
    }

}


//
// P_ArchiveSpecials
//
enum
{
    tc_ceiling,
    tc_door,
    tc_floor,
    tc_plat,
    tc_flash,
    tc_strobe,
    tc_glow,
    tc_endspecials

} specials_e;	



//
// Things to handle:
//
// T_MoveCeiling, (ceiling_t: sector_t * swizzle), - active list
// T_VerticalDoor, (vldoor_t: sector_t * swizzle),
// T_MoveFloor, (floormove_t: sector_t * swizzle),
// T_LightFlash, (lightflash_t: sector_t * swizzle),
// T_StrobeFlash, (strobe_t: sector_t *),
// T_Glow, (glow_t: sector_t *),
// T_PlatRaise, (plat_t: sector_t *), - active list
//
void P_ArchiveSpecials (void)
{
    thinker_t*		th;
    ceiling_t*		ceiling;
    vldoor_t*		door;
    floormove_t*	floor;
    plat_t*		plat;
    lightflash_t*	flash;
    strobe_t*		strobe;
    glow_t*		glow;
    int			i;
	
    // save off the current thinkers
    for (th = thinkercap.next ; th != &thinkercap ; th=th->next)
    {
	if (th->function.acv == (actionf_v)NULL)
	{
	    for (i = 0; i < MAXCEILINGS;i++)
		if (activeceilings[i] == (ceiling_t *)th)
		    break;
	    
	    if (i<MAXCEILINGS)
	    {
		*save_p++ = tc_ceiling;
		PADSAVEP();
		ceiling = (ceiling_t *)save_p;
		memcpy (ceiling, th, sizeof(*ceiling));
		save_p += sizeof(*ceiling);
		ceiling->sector = (sector_t *)(ceiling->sector - sectors);
	    }
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_MoveCeiling)
	{
	    *save_p++ = tc_ceiling;
	    PADSAVEP();
	    ceiling = (ceiling_t *)save_p;
	    memcpy (ceiling, th, sizeof(*ceiling));
	    save_p += sizeof(*ceiling);
	    ceiling->sector = (sector_t *)(ceiling->sector - sectors);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_VerticalDoor)
	{
	    *save_p++ = tc_door;
	    PADSAVEP();
	    door = (vldoor_t *)save_p;
	    memcpy (door, th, sizeof(*door));
	    save_p += sizeof(*door);
	    door->sector = (sector_t *)(door->sector - sectors);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_MoveFloor)
	{
	    *save_p++ = tc_floor;
	    PADSAVEP();
	    floor = (floormove_t *)save_p;
	    memcpy (floor, th, sizeof(*floor));
	    save_p += sizeof(*floor);
	    floor->sector = (sector_t *)(floor->sector - sectors);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_PlatRaise)
	{
	    *save_p++ = tc_plat;
	    PADSAVEP();
	    plat = (plat_t *)save_p;
	    memcpy (plat, th, sizeof(*plat));
	    save_p += sizeof(*plat);
	    plat->sector = (sector_t *)(plat->sector - sectors);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_LightFlash)
	{
	    *save_p++ = tc_flash;
	    PADSAVEP();
	    flash = (lightflash_t *)save_p;
	    memcpy (flash, th, sizeof(*flash));
	    save_p += sizeof(*flash);
	    flash->sector = (sector_t *)(flash->sector - sectors);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_StrobeFlash)
	{
	    *save_p++ = tc_strobe;
	    PADSAVEP();
	    strobe = (strobe_t *)save_p;
	    memcpy (strobe, th, sizeof(*strobe));
	    save_p += sizeof(*strobe);
	    strobe->sector = (sector_t *)(strobe->sector - sectors);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_Glow)
	{
	    *save_p++ = tc_glow;
	    PADSAVEP();
	    glow = (glow_t *)save_p;
	    memcpy (glow, th, sizeof(*glow));
	    save_p += sizeof(*glow);
	    glow->sector = (sector_t *)(glow->sector - sectors);
	    continue;
	}
    }
	
    // add a terminating marker
    *save_p++ = tc_endspecials;	

}


//
// P_UnArchiveSpecials
//
void P_UnArchiveSpecials (void)
{
    byte		tclass;
    ceiling_t*		ceiling;
    vldoor_t*		door;
    floormove_t*	floor;
    plat_t*		plat;
    lightflash_t*	flash;
    strobe_t*		strobe;
    glow_t*		glow;
	
	
    // read in saved thinkers
    while (1)
    {
	P_SaveNeed (1);
	tclass = *save_p++;
	switch (tclass)
	{
	  case tc_endspecials:
	    return;	// end of list
			
	  case tc_ceiling:
	    PADSAVEP();
	    P_SaveNeed (sizeof(*ceiling));
	    ceiling = Z_Malloc (sizeof(*ceiling), PU_LEVEL, NULL);
	    memcpy (ceiling, save_p, sizeof(*ceiling));
	    save_p += sizeof(*ceiling);
	    P_SaveSector ((int) ceiling->sector);
	    ceiling->sector = &sectors[(int)ceiling->sector];
	    ceiling->sector->specialdata = ceiling;

	    if (ceiling->thinker.function.acp1)
		ceiling->thinker.function.acp1 = (actionf_p1)T_MoveCeiling;

	    P_AddThinker (&ceiling->thinker);
	    P_AddActiveCeiling(ceiling);
	    break;
				
	  case tc_door:
	    PADSAVEP();
	    P_SaveNeed (sizeof(*door));
	    door = Z_Malloc (sizeof(*door), PU_LEVEL, NULL);
	    memcpy (door, save_p, sizeof(*door));
	    save_p += sizeof(*door);
	    P_SaveSector ((int) door->sector);
	    door->sector = &sectors[(int)door->sector];
	    door->sector->specialdata = door;
	    door->thinker.function.acp1 = (actionf_p1)T_VerticalDoor;
	    P_AddThinker (&door->thinker);
	    break;
				
	  case tc_floor:
	    PADSAVEP();
	    P_SaveNeed (sizeof(*floor));
	    floor = Z_Malloc (sizeof(*floor), PU_LEVEL, NULL);
	    memcpy (floor, save_p, sizeof(*floor));
	    save_p += sizeof(*floor);
	    P_SaveSector ((int) floor->sector);
	    // the two types that end by setting floorpic (T_MoveFloor)
	    if ((floor->type == donutRaise || floor->type == lowerAndChange)
		&& (unsigned) floor->texture >= numflats)
		P_SaveBad ("flat", floor->texture);
	    floor->sector = &sectors[(int)floor->sector];
	    floor->sector->specialdata = floor;
	    floor->thinker.function.acp1 = (actionf_p1)T_MoveFloor;
	    P_AddThinker (&floor->thinker);
	    break;
				
	  case tc_plat:
	    PADSAVEP();
	    P_SaveNeed (sizeof(*plat));
	    plat = Z_Malloc (sizeof(*plat), PU_LEVEL, NULL);
	    memcpy (plat, save_p, sizeof(*plat));
	    save_p += sizeof(*plat);
	    P_SaveSector ((int) plat->sector);
	    plat->sector = &sectors[(int)plat->sector];
	    plat->sector->specialdata = plat;

	    if (plat->thinker.function.acp1)
		plat->thinker.function.acp1 = (actionf_p1)T_PlatRaise;

	    P_AddThinker (&plat->thinker);
	    P_AddActivePlat(plat);
	    break;
				
	  case tc_flash:
	    PADSAVEP();
	    P_SaveNeed (sizeof(*flash));
	    flash = Z_Malloc (sizeof(*flash), PU_LEVEL, NULL);
	    memcpy (flash, save_p, sizeof(*flash));
	    save_p += sizeof(*flash);
	    P_SaveSector ((int) flash->sector);
	    flash->sector = &sectors[(int)flash->sector];
	    flash->thinker.function.acp1 = (actionf_p1)T_LightFlash;
	    P_AddThinker (&flash->thinker);
	    break;
				
	  case tc_strobe:
	    PADSAVEP();
	    P_SaveNeed (sizeof(*strobe));
	    strobe = Z_Malloc (sizeof(*strobe), PU_LEVEL, NULL);
	    memcpy (strobe, save_p, sizeof(*strobe));
	    save_p += sizeof(*strobe);
	    P_SaveSector ((int) strobe->sector);
	    strobe->sector = &sectors[(int)strobe->sector];
	    strobe->thinker.function.acp1 = (actionf_p1)T_StrobeFlash;
	    P_AddThinker (&strobe->thinker);
	    break;
				
	  case tc_glow:
	    PADSAVEP();
	    P_SaveNeed (sizeof(*glow));
	    glow = Z_Malloc (sizeof(*glow), PU_LEVEL, NULL);
	    memcpy (glow, save_p, sizeof(*glow));
	    save_p += sizeof(*glow);
	    P_SaveSector ((int) glow->sector);
	    glow->sector = &sectors[(int)glow->sector];
	    glow->thinker.function.acp1 = (actionf_p1)T_Glow;
	    P_AddThinker (&glow->thinker);
	    break;
				
	  default:
	    I_Error ("P_UnarchiveSpecials:Unknown tclass %i "
		     "in savegame",tclass);
	}
	
    }

}

