// The two pieces of UI plumbing every other client module needs.
//
// Neither is clever.  Both existed in several hand-written copies, and in both
// cases the copies had drifted in ways that mattered:
//
//   #status was written SIX different ways across main.js, lobby.js, demo.js
//   (twice), audio.js, settings.js and video.js (the last two are gone; the
//   settings panel became a menu screen).  Three of them dereferenced
//   the element without a null check, so a module loaded before the element
//   exists — or in a test harness with no DOM at all — threw where it meant to
//   report.  video.js already knew that and captured the element defensively
//   at module scope, which is a different bug: it caches a null forever if it
//   loads first.
//
//   The teardown ledger stood verbatim in input.js, settings.js and qol.js.
//   Two of those three are gone now; input.js still uses the shared copy, and
//   the duplication is what this file exists to have removed.
//   Round 5 added it to stop each boot leaving another live handler on window;
//   a fourth module needing it would have had to copy it correctly.

// Look the element up EVERY time, and tolerate its absence.  The launcher
// creates and replaces DOM around it, and modules load in an order no single
// module controls.
export function setStatus(msg) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
}

// ── the loading panel ────────────────────────────────────────────────────────
//
// It lived in main.js, which meant it existed only once a game was booting.
// The LAUNCHER's own startup — /api/wads, an IndexedDB read and a base64
// decode of ~63 font patches before the first menu row appears — showed
// nothing at all: a black page for however long that takes on a slow host.
//
// The bar carries role="progressbar" (index.html), so the percentage has to
// reach aria-valuenow as well as the fill's width; a bar that only changes
// width is silent to anything not looking at it.
export const loading = {
    _el(id) { return typeof document === 'undefined' ? null : document.getElementById(id); },
    _set(label, pct) {
        const l = this._el('loading-label'); if (l) l.textContent = label;
        const f = this._el('loading-fill');  if (f) f.style.width = `${pct}%`;
        const b = this._el('loading-bar');
        if (b) {
            // ARIA: an INDETERMINATE progressbar omits aria-valuenow.  Saying
            // "0%" for a transfer whose length is unknown is a false statement,
            // not a missing one -- and that is what a compressed response
            // (no content-length) used to produce for its whole duration.
            if (pct === null) b.removeAttribute('aria-valuenow');
            else b.setAttribute('aria-valuenow', String(pct));
        }
    },
    show(label) { this._set(label, 0); const e = this._el('loading'); if (e) e.hidden = false; },
    set(label, frac) { this._set(label, Math.round((frac ?? 0) * 100)); },
    // Length unknown: the LABEL carries the progress and the bar says so.
    indeterminate(label) { this._set(label, null); },
    hide() { const e = this._el('loading'); if (e) e.hidden = true; },
};

// A ledger of "how to undo this", returned as { on, off }.
//   on(target, event, fn, opts)  adds the listener and records its removal
//   off()                        runs every recorded removal, once
export function teardownLedger() {
    const undo = [];
    return {
        on(target, ev, fn, opts) {
            target.addEventListener(ev, fn, opts);
            undo.push(() => target.removeEventListener(ev, fn, opts));
        },
        off() {
            for (const f of undo) f();
            undo.length = 0;
        },
    };
}
