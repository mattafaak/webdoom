// The replay scrubber ("demo as video"): a range input and an input timeline
// strip under the canvas.  Seeking calls web_seek_demo(N), which re-sims from
// tic 0 -- no keyframes -- so the worst case is the whole demo: the longest one
// in the matrix is plutonia-demo1 at 7,403 tics, measured ~0.36 s on the
// slowest fleet host (wbox; docs/perf.md §19.3).  This comment and the tooltip
// below both said "~2.2 s for 44,580 tics" until round 13.  44,580 is the
// thirteen-demo CORPUS total and nothing seeks across demos, so the figure a
// user was reading was 6x the real worst case.
// Demo tic format (vanilla .lmp, 4 bytes): forwardmove, sidemove, angleturn/8,
// buttons (bit 0 fire, 1 use, 2 strafe, 3 speed, 4-7 weapon slots).
// JS only: no engine writes, determinism safe.

const BTN_FIRE   = 0x01;
const BTN_USE    = 0x02;
const BTN_SPEED  = 0x08;

// parseDemoTimeline: extract per-tic input data from raw .lmp bytes.
// Returns an array of { forward, side, angle, buttons } objects (one per tic).
// header is 13 bytes; each tic is 4 bytes; last byte is DEMOMARKER (0x80).
function parseDemoTimeline(demoBytes) {
    const HEADER = 13;
    const MARKER = 0x80;
    const ticks = [];
    let i = HEADER;
    while (i + 3 < demoBytes.length) {
        // Check 4-byte-aligned DEMOMARKER
        if (demoBytes[i] === MARKER) break;
        ticks.push({
            forward: (demoBytes[i] << 24 >> 24),    // signed
            side:    (demoBytes[i+1] << 24 >> 24),
            angle:   (demoBytes[i+2] << 24 >> 24),
            buttons: demoBytes[i+3],
        });
        i += 4;
    }
    return ticks;
}

// createScrubberUI: attach scrubber + timeline strip below #screen.
// doom: the wasm module instance (from bootDoom).
// demoBytes: raw .lmp Uint8Array.
// container: element to append the scrubber panel to (default: document.body).
// seekHook: function(n) called to request a seek to tic n (provided by main.js).
//
// Returns { destroy() } to remove the UI.
export function createScrubberUI(doom, demoBytes, { container = document.body, seekHook } = {}) {
    if (!doom || !demoBytes || !demoBytes.length) return { destroy: () => {} };
    if (typeof doom._web_seek_demo !== 'function') {
        console.warn('scrubber: web_seek_demo not available — rebuild engine');
        return { destroy: () => {} };
    }

    const timeline = parseDemoTimeline(demoBytes);
    const totalTics = timeline.length;
    if (totalTics === 0) return { destroy: () => {} };

    // ── Panel ─────────────────────────────────────────────────────────────────
    // styled in webdoom.css under #scrubber-panel
    const el = (tag, className, props = {}) =>
        Object.assign(document.createElement(tag), { className, ...props });
    const panel = el('div', '', { id: 'scrubber-panel' });

    // ── Scrubber row ──────────────────────────────────────────────────────────
    const scrubRow = el('div', 'row');
    const label = el('span', 'tic', { textContent: 'TIC 0' });
    const scrubber = el('input', '', { type: 'range', min: '0', max: String(totalTics - 1), value: '0' });
    scrubber.setAttribute('aria-label', 'Demo scrubber');
    const latencyNote = el('span', 'note', {
        textContent: '↩ re-sim/tic',
        title: 'Seek re-sims from tic 0. The longest demo is 7,403 tics, measured at ~0.36 s on the slowest fleet host (wbox). See docs/perf.md §19.3.',
    });

    scrubRow.appendChild(label);
    scrubRow.appendChild(scrubber);
    scrubRow.appendChild(latencyNote);

    // ── Timeline strip ───────────────────────────────────────────────────────
    // A narrow canvas showing per-tic button events as coloured pixels.
    // Red = fire, yellow = use, white = speed.  Each pixel = one tic (scaled).
    const strip = el('canvas', 'strip', { height: 16 });
    // decorative: the range input beside it is the keyboard-reachable control
    strip.setAttribute('role', 'presentation');
    strip.setAttribute('aria-hidden', 'true');

    // One pixel per tic was unbounded.  The longest demo in the matrix is 7,403
    // tics, but the server accepts a 1 MiB .lmp, which is ~260,000 tics -- and
    // it is the UPLOAD that sets this bound, not the matrix.  Against Firefox's
    // 32,767 px canvas limit, where an
    // over-limit canvas yields a context that cannot be drawn into.  The throw
    // escapes createScrubberUI, out of bootDoom's `after` callback, into
    // enterGame's .catch.  Chrome's limits are higher, so this never showed
    // here.  Cap the canvas and down-sample: the strip is a 16 px-tall
    // decorative overview scaled by CSS anyway, so pixel-per-tic was never
    // something a reader could resolve.
    const STRIP_MAX_PX = 8192;
    const stripW = Math.max(1, Math.min(totalTics, STRIP_MAX_PX));
    // tic index -> x, and never a zero-width mark
    const xOf = i => Math.floor(i * stripW / totalTics);
    const markW = Math.max(1, Math.ceil(stripW / totalTics));

    function renderStrip() {
        strip.width = stripW;
        const ctx = strip.getContext('2d');
        ctx.clearRect(0, 0, stripW, 16);
        // Background
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, stripW, 16);
        // Movement track (mid 6px): brightness of |forward|
        for (let i = 0; i < timeline.length; i++) {
            const t = timeline[i];
            const fwd = Math.abs(t.forward);
            if (fwd > 0) {
                const bright = Math.min(255, fwd * 2);
                ctx.fillStyle = `rgb(${bright},${bright>>1},0)`;
                ctx.fillRect(xOf(i), 5, markW, 6);
            }
        }
        // Button events (top 4px = fire red, bottom 3px = use yellow, bit-3 = speed cyan)
        for (let i = 0; i < timeline.length; i++) {
            const b = timeline[i].buttons;
            if (b & BTN_FIRE)  { ctx.fillStyle = '#f00'; ctx.fillRect(xOf(i), 0, markW, 4); }
            if (b & BTN_USE)   { ctx.fillStyle = '#ff0'; ctx.fillRect(xOf(i), 13, markW, 3); }
            if (b & BTN_SPEED) { ctx.fillStyle = '#0ff'; ctx.fillRect(xOf(i), 9, markW, 2); }
        }
    }
    renderStrip();

    // Playhead overlay
    const stripWrap = el('div', 'stripwrap');
    const playhead = el('div', 'playhead');
    stripWrap.appendChild(strip);
    stripWrap.appendChild(playhead);

    panel.appendChild(scrubRow);
    panel.appendChild(stripWrap);
    container.appendChild(panel);

    // ── Legend ───────────────────────────────────────────────────────────────
    const legend = el('div', 'legend');
    for (const [color, text] of [['#f00', 'fire'], ['#ff0', 'use'], ['#0ff', 'speed'], ['#a50', 'move']]) {
        const item = el('span');
        item.appendChild(el('span', '', { textContent: '▬' })).style.color = color;
        item.appendChild(document.createTextNode(' ' + text));
        legend.appendChild(item);
    }
    panel.appendChild(legend);


    // ── Seek logic ────────────────────────────────────────────────────────────
    let currentTic = 0;

    function updatePlayhead(tic) {
        const frac = totalTics > 1 ? tic / (totalTics - 1) : 0;
        playhead.style.left = `${frac * 100}%`;
        label.textContent = `TIC ${tic}`;
    }

    function doSeek(n) {
        currentTic = Math.max(0, Math.min(totalTics - 1, n));
        scrubber.value = String(currentTic);
        updatePlayhead(currentTic);
        if (seekHook) {
            seekHook(currentTic);
        }
    }

    scrubber.addEventListener('input', () => doSeek(+scrubber.value));

    // Click on strip also seeks
    strip.addEventListener('click', (e) => {
        const rect = strip.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        doSeek(Math.round(frac * (totalTics - 1)));
    });

    // ── External tick update (called each frame from main.js) ─────────────────
    // Returns a function that main.js can call each rAF to keep the scrubber in sync.
    function onFrame() {
        if (typeof doom._web_gametic !== 'function') return;
        const tic = doom._web_gametic();
        if (tic !== currentTic) {
            currentTic = tic;
            scrubber.value = String(Math.min(tic, totalTics - 1));
            updatePlayhead(Math.min(tic, totalTics - 1));
        }
    }


    // ── Destroy ───────────────────────────────────────────────────────────────
    function destroy() {
        panel.remove();
    }

    return { destroy, onFrame };
}
