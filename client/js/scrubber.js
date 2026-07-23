// scrubber.js — task 19.3 replay scrubber ("demo as video").
//
// Attaches a range scrubber + input timeline strip below the canvas when a
// demo is playing.  The scrubber drives web_seek_demo(N) to jump to any tic
// in the demo without needing keyframe data — always re-sims from tic 0.
//
// Design:
//   - The scrubber is a <input type="range"> for the tic position.
//   - The input timeline strip is a <canvas> showing per-tic button events
//     (fire, use, speed) as coloured marks — parsed from the raw .lmp bytes.
//   - Seeking pauses the normal rAF loop (via seekPending flag in main.js)
//     and renders a single frame at the target tic.
//   - After seek, playback resumes from the next tic (gametic=N+1 from the
//     rendering frame that followed the seek).
//
// Latency note (docs/perf.md §seek-latency):
//   Node.js measurement: seek-to-59 in ~0.4 ms (~4000× realtime).
//   Worst-case 44,580-tic seek extrapolated: ~0.3 s on devbox.
//   Wbox (Raspberry Pi 5): see docs/perf.md for measured figures.
//   The UI cites the measured wbox worst case (~2.2 s, 2026-07-22) — the wbox
//   measurement refines or confirms this figure; see docs/perf.md §19.3.
//
// Demo LMP tic format (bytes per tic, vanilla):
//   byte 0: forwardmove (-127..127)
//   byte 1: sidemove    (-127..127)
//   byte 2: angleturn   (-127..127) lo byte; vanilla stores angleturn/8 here
//   byte 3: buttons bitmask:
//              bit 0 = fire
//              bit 1 = use
//              bit 2 = strafe-on (modifier)
//              bit 3 = speed     (shift)
//              bits 4-7 = weapon-change slots (vanilla)
//
// Ownership: JS only — no engine writes, determinism safe.

export const BTN_FIRE   = 0x01;
export const BTN_USE    = 0x02;
export const BTN_SPEED  = 0x08;

// parseDemoTimeline: extract per-tic input data from raw .lmp bytes.
// Returns an array of { forward, side, angle, buttons } objects (one per tic).
// header is 13 bytes; each tic is 4 bytes; last byte is DEMOMARKER (0x80).
export function parseDemoTimeline(demoBytes) {
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
    const panel = document.createElement('div');
    panel.id = 'scrubber-panel';
    panel.style.cssText =
        'display:flex;flex-direction:column;gap:4px;padding:6px 8px;' +
        'background:#111;border-top:1px solid #333;user-select:none;';

    // ── Scrubber row ──────────────────────────────────────────────────────────
    const scrubRow = document.createElement('div');
    scrubRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const label = document.createElement('span');
    label.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px;min-width:56px;';
    label.textContent = 'TIC 0';

    const scrubber = document.createElement('input');
    scrubber.type  = 'range';
    scrubber.min   = '0';
    scrubber.max   = String(totalTics - 1);
    scrubber.value = '0';
    scrubber.style.cssText = 'flex:1;cursor:pointer;accent-color:#c00;';
    scrubber.setAttribute('aria-label', 'Demo scrubber');

    const latencyNote = document.createElement('span');
    latencyNote.style.cssText = 'color:#666;font-family:monospace;font-size:10px;min-width:90px;text-align:right;';
    latencyNote.title = 'Seek re-sims from tic 0. Worst-case 44,580-tic seek measured at ~2.2 s on the slowest fleet host (wbox). See docs/perf.md §19.3.';
    latencyNote.textContent = '↩ re-sim/tic';

    scrubRow.appendChild(label);
    scrubRow.appendChild(scrubber);
    scrubRow.appendChild(latencyNote);

    // ── Timeline strip ───────────────────────────────────────────────────────
    // A narrow canvas showing per-tic button events as coloured pixels.
    // Red = fire, yellow = use, white = speed.  Each pixel = one tic (scaled).
    const strip = document.createElement('canvas');
    strip.height = 16;
    strip.style.cssText = 'width:100%;height:16px;display:block;image-rendering:pixelated;cursor:pointer;';
    strip.setAttribute('aria-label', 'Input timeline strip');

    function renderStrip() {
        strip.width = totalTics;  // 1 px per tic before CSS scaling
        const ctx = strip.getContext('2d');
        ctx.clearRect(0, 0, totalTics, 16);
        // Background
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, totalTics, 16);
        // Movement track (mid 6px): brightness of |forward|
        for (let i = 0; i < timeline.length; i++) {
            const t = timeline[i];
            const fwd = Math.abs(t.forward);
            if (fwd > 0) {
                const bright = Math.min(255, fwd * 2);
                ctx.fillStyle = `rgb(${bright},${bright>>1},0)`;
                ctx.fillRect(i, 5, 1, 6);
            }
        }
        // Button events (top 4px = fire red, bottom 3px = use yellow, bit-3 = speed cyan)
        for (let i = 0; i < timeline.length; i++) {
            const b = timeline[i].buttons;
            if (b & BTN_FIRE)  { ctx.fillStyle = '#f00'; ctx.fillRect(i, 0, 1, 4); }
            if (b & BTN_USE)   { ctx.fillStyle = '#ff0'; ctx.fillRect(i, 13, 1, 3); }
            if (b & BTN_SPEED) { ctx.fillStyle = '#0ff'; ctx.fillRect(i, 9, 1, 2); }
        }
    }
    renderStrip();

    // Playhead overlay
    const stripWrap = document.createElement('div');
    stripWrap.style.cssText = 'position:relative;';
    const playhead = document.createElement('div');
    playhead.style.cssText =
        'position:absolute;top:0;bottom:0;width:1px;background:#fff;pointer-events:none;';
    stripWrap.appendChild(strip);
    stripWrap.appendChild(playhead);

    panel.appendChild(scrubRow);
    panel.appendChild(stripWrap);
    container.appendChild(panel);

    // ── Legend (safe DOM construction — no innerHTML) ─────────────────────────
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;gap:10px;font-family:monospace;font-size:10px;color:#666;';
    for (const [color, text] of [['#f00','fire'],['#ff0','use'],['#0ff','speed'],['#a50','move']]) {
        const item = document.createElement('span');
        const swatch = document.createElement('span');
        swatch.textContent = '▬';  // ▬
        swatch.style.color = color;
        item.appendChild(swatch);
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

    // Expose the onFrame updater so main.js can call it each rAF.
    panel._scrubberOnFrame = onFrame;

    // ── Destroy ───────────────────────────────────────────────────────────────
    function destroy() {
        panel.remove();
    }

    return { destroy, onFrame };
}
