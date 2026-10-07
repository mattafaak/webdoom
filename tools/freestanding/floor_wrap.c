// tools/freestanding/floor_wrap.c — what the floor gate needs to know about
// a tic, caught at the link with no engine/core edit.  Linked only by the
// native Makefile, which passes the matching --wrap flags; the cross builds
// (be-build.sh) leave both counters at zero.
//
//   fs_floor_load    set when a level load, an intermission or a finale
//                    starts: P_SetupLevel, WI_Start and F_StartFinale are each
//                    called only from g_game.c, across an object boundary, so
//                    --wrap sees every call.  Such a tic is not graded.
//   fs_floor_mbytes  bytes copied out of the WAD blob: W_ReadLump's memcpy from
//                    the lump's handle (w_wad.c), the copy a cache miss costs.
//
// Both live in i_main.c, which reads and clears them at each tic boundary.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stddef.h>

#include "doomdef.h"
#include "d_player.h" /* wbstartstruct_t, which wi_stuff.h needs first */
#include "wi_stuff.h"

extern volatile unsigned fs_floor_load;
extern volatile unsigned fs_floor_mbytes;
extern const unsigned char* fs_floor_blob;
extern size_t fs_floor_blob_len;

void __real_P_SetupLevel (int episode, int map, int playermask, skill_t skill);
void __wrap_P_SetupLevel (int episode, int map, int playermask, skill_t skill)
{
    fs_floor_load = 1;
    __real_P_SetupLevel (episode, map, playermask, skill);
}

void __real_WI_Start (wbstartstruct_t* wbstartstruct);
void __wrap_WI_Start (wbstartstruct_t* wbstartstruct)
{
    fs_floor_load = 1;
    __real_WI_Start (wbstartstruct);
}

void __real_F_StartFinale (void);
void __wrap_F_StartFinale (void)
{
    fs_floor_load = 1;
    __real_F_StartFinale ();
}

void* __real_memcpy (void* dest, const void* src, size_t n);
void* __wrap_memcpy (void* dest, const void* src, size_t n)
{
    const unsigned char* s = (const unsigned char*) src;
    if (fs_floor_blob && s >= fs_floor_blob && s < fs_floor_blob + fs_floor_blob_len)
        fs_floor_mbytes += (unsigned) n;
    return __real_memcpy (dest, src, n);
}
