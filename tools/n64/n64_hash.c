// tools/n64/n64_hash.c — N64 per-tic simulation state hash (task 20.4c).
//
// PURPOSE: compute fs_state_hash()-equivalent per tic during timedemo
// playback, accumulate the trace in RDRAM, and expose it for GDB dump via
// the ares debug stub.
//
// Algorithm: bit-identical to tools/freestanding/i_main.c fs_state_hash()
// and engine/web/*.c web_state_hash() — same field order, same FNV-mix
// constants.  Required for direct comparison against tools/golden/*.json.
//
// GDB extraction flow (run-n64-demos.sh):
//   1. n64_record_hash() appends one hash per unique gametic to n64_trace[].
//   2. On demo completion (timedemo longjmp), n64_demo_complete_halt() is
//      called with n64_trace_len set.
//   3. run-n64-demos.sh sets a GDB software breakpoint on
//      n64_demo_complete_halt, waits for it to fire, then issues:
//        dump binary memory /path/trace.bin n64_trace n64_trace+$len
//   4. Python parses the big-endian uint32 dump and compares against
//      tools/golden/<iwad>-<demo>.json.
//
// Engine/core: 0-diff.  All new code is in tools/n64/ only.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).

#include "doomdef.h"   /* MAXPLAYERS, boolean */
#include "doomstat.h"  /* gametic, playeringame, players */
#include "r_state.h"   /* numsectors, sectors */

#include "n64_platform.h"

extern int       prndindex;    /* m_random.c */
extern thinker_t thinkercap;   /* p_tick.c   */

/* Trace buffer: 10000 entries covers the longest standard demo
   (plutonia-demo1: 7403 tics) with >2500 entries of headroom.
   10000 × 4 B = 40 KB — trivial vs the N64's 4 MB RDRAM. */
#define N64_MAX_TRACE 10000

int n64_trace[N64_MAX_TRACE];
int n64_trace_len = 0;

/* Compute one state hash — identical algorithm to fs_state_hash(). */
static int
n64_state_hash (void)
{
    unsigned h = 0x9e3779b9u ^ (unsigned) gametic;
    int      i;

    h = (h ^ (unsigned) prndindex) * 0x01000193u;
    for (i = 0; i < MAXPLAYERS; i++)
        if (playeringame[i] && players[i].mo)
        {
            h = (h ^ (unsigned) players[i].mo->x)     * 0x01000193u;
            h = (h ^ (unsigned) players[i].mo->y)     * 0x01000193u;
            h = (h ^ (unsigned) players[i].mo->angle) * 0x01000193u;
            h = (h ^ (unsigned) players[i].health)    * 0x01000193u;
        }
    for (i = 0; i < numsectors; i++)
    {
        h = (h ^ (unsigned) sectors[i].floorheight)   * 0x01000193u;
        h = (h ^ (unsigned) sectors[i].ceilingheight) * 0x01000193u;
    }
    {
        thinker_t *th;
        unsigned   cnt = 0;
        /* Guard: thinkercap.next is BSS-zero until P_InitThinkers runs.
           Dereferencing NULL here was the crash at PC=0x800477E8.
           If the sentinel is uninitialised, cnt=0 is already correct
           (nothing has been spawned yet), so we just skip the loop. */
        if (thinkercap.next != NULL)
        {
            for (th = thinkercap.next; th != &thinkercap; th = th->next)
                cnt++;
        }
        h = (h ^ cnt) * 0x01000193u;
    }
    return (int) h;
}

/* Append one hash for the current gametic.
   Called once per unique gametic in the main frame loop.
   Guard: skip recording until P_InitThinkers has been called.
   thinkercap.next stays NULL (BSS zero) until G_DoPlayDemo →
   G_InitNew → G_DoLoadLevel → P_SetupLevel → P_InitThinkers.
   In the singletics path gametic goes 0→1 inside the same G_Ticker
   call that runs P_InitThinkers, so the guard only fires on the first
   iteration when the TryRunTics path hasn't called G_Ticker yet.
   last_tic is updated by the caller in either case, so the first
   properly-initialised tic is never skipped. */
void
n64_record_hash (void)
{
    if (thinkercap.next == NULL)
        return;  /* P_InitThinkers not yet called — skip this gametic */
    if (n64_trace_len < N64_MAX_TRACE)
        n64_trace[n64_trace_len++] = n64_state_hash ();
}

/* GDB breakpoint target: run-n64-demos.sh breaks here to know the trace is
   complete, then reads n64_trace_len and dumps n64_trace[0..len-1].
   noinline ensures the symbol survives --gc-sections; used ensures it is
   not optimised away even though no C code calls it via the ABI. */
__attribute__ ((noinline, used)) void
n64_demo_complete_halt (void)
{
    for (;;)
    {
    }
}
