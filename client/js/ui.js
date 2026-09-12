// The two pieces of UI plumbing every other client module needs.
//
// Neither is clever.  Both existed in several hand-written copies, and in both
// cases the copies had drifted in ways that mattered:
//
//   #status was written SIX different ways across main.js, lobby.js, demo.js
//   (twice), audio.js, settings.js and video.js.  Three of them dereferenced
//   the element without a null check, so a module loaded before the element
//   exists — or in a test harness with no DOM at all — threw where it meant to
//   report.  video.js already knew that and captured the element defensively
//   at module scope, which is a different bug: it caches a null forever if it
//   loads first.
//
//   The teardown ledger stood verbatim in input.js, settings.js and qol.js.
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
