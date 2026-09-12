// wide-utils.js — shared Hor+ exact-fit width selection (wide-fix).
//
// Single source of truth for display-shape → render-width mapping, used by
// BOTH the settings toggle path (settings.js) and the boot persist path
// (main.js).  These were previously two divergent implementations: the
// toggle picked 560 while a reload re-applied a hardcoded 854 — exactly the
// drift the shared module exists to prevent.
//
// Exact fit, not buckets (field report: coarse Crispy buckets 426/560/854
// letterboxed any window whose aspect fell between them — "I just want the
// horizontal screen space filled").  DOOM's 200 rows display as 240
// aspect-corrected units (1:1.2 pixel aspect), so the width that exactly
// fills a window of aspect A is 240·A.  Rounded to an even column count
// (low-detail mode draws column pairs) and clamped to [320, MAXSCREENWIDTH
// =854].  16:9 → 426, 16:10 → 384, 21:9 → 560, 32:9 → 854: the old buckets
// fall out as the special cases.

export function wideWidth() {
    const aspect = window.innerWidth / window.innerHeight;
    const w = Math.round(240 * aspect / 2) * 2;
    return Math.max(320, Math.min(854, w));
}

// Panini/cylindrical remap strength for a given render width.
//
// The same drift, a second time: this lived verbatim in BOTH main.js and
// settings.js, the latter carrying the comment "matches main.js
// paniniStrength()" — a comment is not a mechanism, and wide-utils.js was
// created after the wideWidth() copies diverged for precisely this reason
// (task 25.3).
//
// 0.0 at 4:3 or narrower, rising linearly to 0.4 at 21:9 and clamped there.
// Returns 0 when the remap is disabled.
export function paniniStrength(width, enabled) {
    if (!enabled) return 0.0;
    const aspect = width / 200;
    return Math.min(0.4, Math.max(0, (aspect - 4 / 3) / (21 / 9 - 4 / 3)) * 0.4);
}
