// webdoom frozen-surface invariant asserts — task 8.1
//
// Usage:
//   In each instrumented TU, inside an #ifdef WEBDOOM_INVARIANTS block:
//
//     #ifdef WEBDOOM_INVARIANTS
//     #include "doomassert.h"
//     #endif
//
//   Then at each call site, also inside #ifdef WEBDOOM_INVARIANTS:
//
//     #ifdef WEBDOOM_INVARIANTS
//     DOOM_ASSERT(condition);
//     #endif
//
// Zero web/platform dependency: this header includes only <assert.h> (ISO C),
// never any web/, emscripten, or platform header.  The include guard and the
// #ifdef WEBDOOM_INVARIANTS wrapper in each TU together guarantee that when the
// flag is off, neither this file nor <assert.h> is opened by the preprocessor,
// preserving byte-for-byte binary identity with the unflagged build.
//
// Architectural rule (task 2.2 precedent): this header is included INSIDE the
// #ifdef WEBDOOM_INVARIANTS block in each TU — never at file scope — so the
// normal build sees zero additional preprocessor work.
//
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).

#ifndef __DOOMASSERT_H__
#define __DOOMASSERT_H__

#include <assert.h>

// DOOM_ASSERT(cond) — abort if cond is false.
// Wraps assert() which emits the file/line and condition on failure.
// When WEBDOOM_INVARIANTS is off (or NDEBUG is set), the entire call site
// is elided by the surrounding #ifdef.
#define DOOM_ASSERT(cond)  assert(cond)

// doom_in_render_path — set to 1 before R_RenderPlayerView, 0 after.
// Used by P_Random to detect render-code contamination.
// Declared here (defined in m_random.c) so r_main.c can reference it without
// including a web header.
extern int doom_in_render_path;

// doom_prnd_prev — shadow of the last prndindex seen by P_Random.
// Used to assert the index advances by exactly 1 each call.
// Declared here (defined in m_random.c) so the value persists across calls.
extern int doom_prnd_prev;

#endif /* __DOOMASSERT_H__ */
