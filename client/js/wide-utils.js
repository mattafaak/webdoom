// wide-utils.js — shared Hor+ aspect-bucket selection (wide-fix).
//
// Single source of truth for display-aspect → render-width mapping, used by
// BOTH the settings toggle path (settings.js) and the boot persist path
// (main.js).  These were previously two divergent implementations: the
// toggle picked 560 while a reload re-applied a hardcoded 854 — exactly the
// drift the shared module exists to prevent.
//
// Buckets are the Crispy-standard widths measured in task 18.1; all are
// within the MAXSCREENWIDTH=854 compile cap.

export function wideBucket() {
    const aspect = window.innerWidth / window.innerHeight;
    if (aspect <= 1.55) return 320;   // 4:3 / 5:4 — wide off equivalent
    if (aspect <= 2.0)  return 426;   // 16:9 / 16:10
    if (aspect <= 2.6)  return 560;   // 21:9
    return 854;                       // 32:9 / beyond
}
