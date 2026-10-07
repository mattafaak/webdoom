// tools/cortexm/fasttest_ref.c — the reference fasttest.c holds the port's
// FixedMul and FixedDiv to: engine/core/m_fixed.h's own definitions, compiled
// here without WEB_FIXED_PORT (the Makefile filters it out of this file's
// flags), so on ARMv6-M they are libgcc's __aeabi_lmul and __aeabi_ldivmod.
// Copyright (C) 2026, GPL-2.0-or-later.
#ifdef WEB_FIXED_PORT
#error "fasttest_ref.c must compile m_fixed.h's own FixedMul and FixedDiv"
#endif
#include "m_fixed.h"

fixed_t ft_ref_mul (fixed_t a, fixed_t b);
fixed_t ft_ref_div (fixed_t a, fixed_t b);

fixed_t ft_ref_mul (fixed_t a, fixed_t b)
{
    return FixedMul (a, b);
}

fixed_t ft_ref_div (fixed_t a, fixed_t b)
{
    return FixedDiv (a, b);
}
