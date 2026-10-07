// tools/freestanding/fixed_count.h — m_fixed.h with call counters, for the
// demand vector's FixedMul / FixedDiv counts.  Force-included by a side build
// (make OBJDIR=obj-fixed OUT=fs-doom-fixed EXTRA_CFLAGS="-include fixed_count.h"),
// it defines m_fixed.h's guard first, so the engine's own header is skipped
// and every call site uses these.  The arithmetic is m_fixed.h's, unchanged;
// only the counting differs, so this build's instruction counts are not demand.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __M_FIXED__
#define __M_FIXED__
#include <stdlib.h>
#include "doomtype.h"

#define FRACBITS 16
#define FRACUNIT (1 << FRACBITS)
typedef int fixed_t;

#define FS_FIXED_COUNT 1
extern unsigned long long fs_fixedmul_n;  /* every FixedMul */
extern unsigned long long fs_fixeddiv_n;  /* every FixedDiv */
extern unsigned long long fs_fixeddiv_clamped_n; /* those answered by the clamp, no divide */

static inline fixed_t FixedMul (fixed_t a, fixed_t b)
{
    fs_fixedmul_n++;
    return (fixed_t) (((long long) a * (long long) b) >> FRACBITS);
}

static inline fixed_t FixedDiv (fixed_t a, fixed_t b)
{
    fs_fixeddiv_n++;
    if ((abs (a) >> 14) >= abs (b))
    {
        fs_fixeddiv_clamped_n++;
        return (a ^ b) < 0 ? MININT : MAXINT;
    }
    return (fixed_t) (((long long) a << FRACBITS) / b);
}

#endif
