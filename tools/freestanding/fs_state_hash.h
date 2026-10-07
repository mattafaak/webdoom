// tools/freestanding/fs_state_hash.h — the per-tic sim hash, one copy for the
// harnesses that run the freestanding platform layer: fs-doom (i_main.c) and
// the Cortex-M builds (tools/cortexm/cm_main.c).
//
// Identical algorithm to web_state_hash() and nat_state_hash(): every field in
// exactly the same order, which bit-identical comparison with the goldens
// requires.  A static function in a header, so each harness inlines its own.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef FS_STATE_HASH_H
#define FS_STATE_HASH_H

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "r_state.h"

extern int prndindex;        /* m_random.c */
extern thinker_t thinkercap; /* p_tick.c — thinker list sentinel */

static int fs_state_hash (void)
{
    unsigned h = 0x9e3779b9u ^ (unsigned) gametic;
    int i;

    h = (h ^ (unsigned) prndindex) * 0x01000193u;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && players[i].mo)
        {
            h = (h ^ (unsigned) players[i].mo->x) * 0x01000193u;
            h = (h ^ (unsigned) players[i].mo->y) * 0x01000193u;
            h = (h ^ (unsigned) players[i].mo->angle) * 0x01000193u;
            h = (h ^ (unsigned) players[i].health) * 0x01000193u;
        }
    // sector floor/ceiling heights — catches moving floors/ceilings.
    for (i = 0; i < numsectors; i++)
    {
        h = (h ^ (unsigned) sectors[i].floorheight) * 0x01000193u;
        h = (h ^ (unsigned) sectors[i].ceilingheight) * 0x01000193u;
    }
    // thinker count — catches spawn/despawn of active thinkers.
    {
        thinker_t* th;
        unsigned cnt = 0;
        for (th = thinkercap.next; th != &thinkercap; th = th->next)
            cnt++;
        h = (h ^ cnt) * 0x01000193u;
    }
    return (int) h;
}

#endif
