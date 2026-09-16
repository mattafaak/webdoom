// The UI plumbing every other client module shares: the status line, the
// loading panel, the server config, and a listener ledger.

let statusTimer = 0;
// Looks the element up each time and tolerates its absence: modules load in
// no fixed order and the launcher replaces DOM around it.  ttlMs: an
// informational message clears itself; an error (no ttl) stays until
// something replaces it.
export function setStatus(msg, ttlMs = 0) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = msg;
    clearTimeout(statusTimer);
    if (ttlMs && msg)
        statusTimer = setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, ttlMs);
}

// The loading panel (index.html).  The bar is a progressbar, so the
// percentage reaches aria-valuenow as well as the fill's width; an
// indeterminate bar omits it rather than claiming 0%.
export const loading = {
    _el(id) { return typeof document === 'undefined' ? null : document.getElementById(id); },
    _set(label, pct) {
        const l = this._el('loading-label'); if (l) l.textContent = label;
        const f = this._el('loading-fill');  if (f) f.style.width = `${pct}%`;
        const b = this._el('loading-bar');
        if (b) {
            if (pct === null) b.removeAttribute('aria-valuenow');
            else b.setAttribute('aria-valuenow', String(pct));
        }
    },
    show(label) { this._set(label, 0); const e = this._el('loading'); if (e) e.hidden = false; },
    set(label, frac) { this._set(label, Math.round((frac ?? 0) * 100)); },
    indeterminate(label) { this._set(label, null); },
    hide() { const e = this._el('loading'); if (e) e.hidden = true; },
};

// A ledger of listeners to remove on teardown: on(target, event, fn, opts)
// adds and records; off() removes everything once.
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
