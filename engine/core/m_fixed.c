// Emacs style mode select   -*- C++ -*-
//-----------------------------------------------------------------------------
//
// Copyright (C) 1993-1996 by id Software, Inc.
// Copyright (C) 2026 webdoom, GPL-2.0-or-later
//
// DESCRIPTION:
//	Fixed point implementation.
//
//	webdoom: FixedMul and FixedDiv now live as `static inline` in
//	m_fixed.h so all 170 call sites (densest in the per-column
//	renderer loops) inline with no call overhead. FixedDiv uses the
//	integer form — proven bit-identical to linuxdoom's double path
//	over the guarded domain (docs/engine-archaeology.md §2). The old
//	out-of-line FixedMul/FixedDiv/FixedDiv2 and the unreachable
//	divide-by-zero I_Error are gone. This translation unit is now
//	intentionally empty.
//
//-----------------------------------------------------------------------------

#include "m_fixed.h"
