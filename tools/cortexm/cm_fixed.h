// tools/cortexm/cm_fixed.h — FixedMul and FixedDiv for the Cortex-M builds,
// equal to engine/core/m_fixed.h's for every input.  The Makefile's FIXED=1
// names this header in WEB_FIXED_PORT, and m_fixed.h includes it in place of
// its own two definitions.
//
// ARMv6-M (Cortex-M0+) has MULS (32x32 -> low 32) and no 64-bit multiply or
// any divide, so gcc turns m_fixed.h's int64 forms into calls to libgcc:
// __aeabi_lmul (a 64x64 multiply, ~28 instructions a call plus the call) and
// __aeabi_ldivmod (~380 instructions a call, and its remainder costs another
// __aeabi_lmul).  The forms here need neither.
//
// FixedMul: write a = ah*2^16 + al and b = bh*2^16 + bl, with ah = a >> 16
// and bh = b >> 16 (arithmetic shifts: signed, in [-2^15, 2^15)) and
// al = a & 0xffff, bl = b & 0xffff (unsigned, in [0, 2^16)).  Then exactly,
// as integers,
//     a*b = 2^16 * (a*bh + ah*bl) + al*bl,       0 <= al*bl < 2^32,
// so floor(a*b / 2^16) = a*bh + ah*bl + floor(al*bl / 2^16).  m_fixed.h's
// value is that floor (an int64 product, exact since |a*b| <= 2^62, then an
// arithmetic >> 16) reduced mod 2^32 by the conversion to int.  The sum here
// is computed mod 2^32 in unsigned arithmetic: each product's low 32 bits
// (MULS) and al*bl exactly (it fits in 32 bits), so the result is the same
// integer mod 2^32: equal for every one of the 2^64 inputs.  Three MULS.
//
// FixedDiv: m_fixed.h's clamp, (abs(a) >> 14) >= abs(b), evaluated without
// its overflow: abs(MININT) is MININT as gcc computes it (and undefined in C,
// which lets gcc fold a later "a == MININT" away, so this form never calls
// abs).  So b == MININT always clamps; a == MININT (b not) never clamps and
// takes m_fixed.h's own int64 expression, its quotient not fitting 30 bits;
// otherwise n = |a| and d = |b| are below 2^31 and the clamp is (n >> 14) >= d.
// Past it d >= 1 and floor(n / 2^14) < d, i.e. n < 2^14 * d, so the quotient
// q = floor(n * 2^16 / d) < 2^30 and (n * 2^16) >> 30 = n >> 14 < d.
// cm_udiv30 (fixed_v6m.S) is restoring division over the 30 low bits of
// n * 2^16, starting from the remainder n >> 14: exact.  m_fixed.h's int64
// division truncates toward zero, i.e. sign(a)*sign(b)*q, which is what is
// returned.  (FixedDiv (MININT, 0) divides by zero in m_fixed.h too.)
// Copyright (C) 2026, GPL-2.0-or-later.
#ifndef CM_FIXED_H
#define CM_FIXED_H

#if defined(CM_ARMV6M)

static inline fixed_t FixedMul (fixed_t a, fixed_t b)
{
    unsigned al = (unsigned) a & 0xffffu, bl = (unsigned) b & 0xffffu;
    unsigned r = (unsigned) a * (unsigned) (b >> 16) +
                 (unsigned) (a >> 16) * bl + ((al * bl) >> 16);
#ifdef CM_REDPROOF_FIXEDMUL
    // a red-proof build's wrong FixedMul: one product in 4,096 off by one
    r += (((unsigned) a ^ (unsigned) b) & 0xfffu) == 0x5a5u;
#endif
    return (fixed_t) r;
}

unsigned cm_udiv30 (unsigned n, unsigned d); /* fixed_v6m.S */

static inline fixed_t FixedDiv (fixed_t a, fixed_t b)
{
    unsigned ua, ub, q;
    if (b == MININT) /* abs (b) is MININT, below anything: the clamp */
        return (a ^ b) < 0 ? MININT : MAXINT;
    if (a == MININT) /* abs (a) >> 14 is negative: never the clamp */
        return (fixed_t) (((long long) a << FRACBITS) / b);
    ua = a < 0 ? 0u - (unsigned) a : (unsigned) a;
    ub = b < 0 ? 0u - (unsigned) b : (unsigned) b;
    if ((ua >> 14) >= ub)
        return (a ^ b) < 0 ? MININT : MAXINT;
    q = cm_udiv30 (ua, ub);
#ifdef CM_REDPROOF_FIXEDDIV
    // a red-proof build's wrong FixedDiv: one quotient in 256 off by one
    q += (ua & 0xffu) == 0x5au;
#endif
    return (a ^ b) < 0 ? -(fixed_t) q : (fixed_t) q;
}

#else /* ARMv8-M: SMULL and libgcc's UDIV-based 64-bit divide; m_fixed.h's */

static inline fixed_t FixedMul (fixed_t a, fixed_t b)
{
    return (fixed_t) (((long long) a * (long long) b) >> FRACBITS);
}

static inline fixed_t FixedDiv (fixed_t a, fixed_t b)
{
    if ((abs (a) >> 14) >= abs (b))
        return (a ^ b) < 0 ? MININT : MAXINT;
    return (fixed_t) (((long long) a << FRACBITS) / b);
}

#endif
#endif
