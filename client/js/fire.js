// PSX DOOM-style indexed-byte fire background.
// Algorithm: Fabien Sanglard's write-up of the original PSX DOOM fire:
//   each cell above the source row = cell below minus random decay (0 or 1)
//   with a ±1 column wind jitter. 37 heat levels, DOOM fire-ramp palette.
//
// Performance contract: sim+draw targets < 1 ms/frame on wbox (AMD G-T56N).
// Grid is deliberately small (64×40) for chunky pixels + perf headroom.
// Canvas is upscaled via image-rendering:pixelated (nearest-neighbour).

const W = 64;   // fire grid width  (pixels are ~20 px wide on 1280 screen — very chunky)
const H = 40;   // fire grid height (pixels are ~24 px tall on 960 screen)

const HEAT_MAX    = 36;   // index of white in the palette (full fire source)
const HEAT_STEADY = 14;   // source heat in dim/menu mode — low, muted flames
const HEAT_FLARE  = 36;   // source heat during menu transitions
const TICK_MS     = 62;   // ~16 Hz simulation rate

// Classic PSX / DOOM fire ramp: 37 entries, black → dark-red → orange →
// yellow → white. These are the canonical Fabien Sanglard / Doom fire RGB
// values, matching the game's PLAYPAL fire-colour range.
// prettier-ignore
const FIRE_PALETTE_RGB = new Uint8Array([
      7,   7,   7,  //  0  near-black
     31,   7,   7,  //  1
     47,  15,   7,  //  2
     71,  15,   7,  //  3
     87,  23,   7,  //  4
    103,  31,   7,  //  5
    119,  31,   7,  //  6
    143,  39,   7,  //  7
    159,  47,   7,  //  8
    175,  63,   7,  //  9
    191,  71,   7,  // 10
    199,  71,   7,  // 11
    223,  79,   7,  // 12
    223,  87,   7,  // 13
    223,  87,   7,  // 14
    215,  95,   7,  // 15
    215,  95,   7,  // 16
    215, 103,  15,  // 17
    207, 111,  15,  // 18
    207, 119,  15,  // 19
    207, 127,  15,  // 20
    207, 135,  23,  // 21
    199, 135,  23,  // 22
    199, 143,  23,  // 23
    199, 151,  31,  // 24
    191, 159,  31,  // 25
    191, 159,  31,  // 26
    191, 167,  39,  // 27
    191, 167,  39,  // 28
    183, 175,  39,  // 29
    183, 175,  39,  // 30
    183, 183,  47,  // 31
    183, 183,  47,  // 32
    207, 207, 111,  // 33
    223, 223, 159,  // 34
    239, 239, 199,  // 35
    255, 255, 255,  // 36  white
]);

// Flat RGBA lookup (alpha = 255 throughout): index = heat * 4
const PAL = new Uint8Array(37 * 4);
for (let i = 0; i <= HEAT_MAX; i++) {
    PAL[i * 4]     = FIRE_PALETTE_RGB[i * 3];
    PAL[i * 4 + 1] = FIRE_PALETTE_RGB[i * 3 + 1];
    PAL[i * 4 + 2] = FIRE_PALETTE_RGB[i * 3 + 2];
    PAL[i * 4 + 3] = 255;
}

// Precomputed noise table: avoids calling Math.random() in the hot inner loop.
// W*H = 2560 cells; table is 8192 entries (> 3× grid size) so the cycled
// pattern is not visible. Values in {0, 1, 2} matching the PSX algorithm.
const RAND_LEN = 8192;
const RAND_TBL = new Uint8Array(RAND_LEN);
for (let i = 0; i < RAND_LEN; i++) RAND_TBL[i] = (Math.random() * 3) | 0;
let randPos = 0;

export function createFire(container) {
    // Canvas is inserted as first child of the container so it renders
    // behind all other children in DOM source order.
    const canvas = document.createElement('canvas');
    canvas.id = 'fire-bg';
    canvas.width  = W;
    canvas.height = H;
    container.insertBefore(canvas, container.firstChild);

    const ctx = canvas.getContext('2d');
    const grid = new Uint8Array(W * H);  // indexed heat cells
    const imgData = ctx.createImageData(W, H);
    const pixels  = imgData.data;        // Uint8ClampedArray

    let sourceHeat  = HEAT_STEADY;
    let flareTimer  = null;
    let paused      = false;
    let tickInterval = null;
    let lastTickMs  = 0;   // most recent measured sim+draw cost (ms)
    let avgTickMs   = 0;   // exponential moving average (α = 0.1)
    let tickCount   = 0;   // total ticks elapsed

    // ── prefers-reduced-motion: one static frame, no sim loop ─────────────
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
        // Initialise grid with a frozen mid-level state (low warm glow).
        const base = (H - 1) * W;
        for (let x = 0; x < W; x++) grid[base + x] = HEAT_STEADY;
        // Spread it upward a few synthetic steps for a static glow at the bottom.
        for (let s = 0; s < 60; s++) _simulate();
        _draw();
        return {
            flare:   () => {},
            pause:   () => {},
            resume:  () => {},
            destroy: () => { canvas.remove(); },
            _lastMs: () => 0,
        };
    }

    // ── initialise: seed bottom row ────────────────────────────────────────
    _setSource(sourceHeat);

    // ── simulation ─────────────────────────────────────────────────────────
    function _setSource(heat) {
        const base = (H - 1) * W;
        for (let x = 0; x < W; x++) grid[base + x] = heat;
    }

    function _simulate() {
        // Iterate every row except the source row, reading heat from the row
        // below and writing (possibly shifted + decayed) into the current row.
        for (let y = H - 2; y >= 0; y--) {
            const row  = y * W;
            const rowB = (y + 1) * W;
            for (let x = 0; x < W; x++) {
                const val = grid[rowB + x];
                if (val === 0) {
                    grid[row + x] = 0;
                } else {
                    // PSX algorithm: randIdx ∈ {0,1,2}; decay = randIdx & 1;
                    // horizontal jitter = x - randIdx + 1 → shifts -1, 0, +1.
                    // Table lookup replaces per-cell Math.random() calls,
                    // cutting inner-loop cost by ~4× on slow hardware.
                    const r   = RAND_TBL[randPos++ & (RAND_LEN - 1)];
                    const nx  = ((x - r + 1) + W) % W;
                    grid[row + nx] = val - (r & 1);
                }
            }
        }
    }

    function _draw() {
        const d = pixels;
        for (let i = 0; i < W * H; i++) {
            const p = grid[i] * 4;
            const o = i * 4;
            d[o]     = PAL[p];
            d[o + 1] = PAL[p + 1];
            d[o + 2] = PAL[p + 2];
            d[o + 3] = PAL[p + 3];
        }
        ctx.putImageData(imgData, 0, 0);
    }

    function _tick() {
        if (paused) return;
        const t0 = performance.now();
        _setSource(sourceHeat);
        _simulate();
        _draw();
        lastTickMs = performance.now() - t0;
        tickCount++;
        avgTickMs = tickCount < 2 ? lastTickMs
            : avgTickMs * 0.9 + lastTickMs * 0.1;
    }

    function _startInterval() {
        if (tickInterval !== null) return;
        tickInterval = setInterval(_tick, TICK_MS);
    }

    function _stopInterval() {
        if (tickInterval === null) return;
        clearInterval(tickInterval);
        tickInterval = null;
    }

    _startInterval();

    // ── public API ─────────────────────────────────────────────────────────

    // Brief intensity boost on menu transitions (push/pop/reset).
    // peak: source heat ceiling (default HEAT_FLARE=36 for a return-to-launcher
    //       "arrival" flare; use a lower value, e.g. 28, for subtle nav flares
    //       between sub-screens — still noticeable but doesn't wash the palette).
    // Tuned curve (task 4.2): 400 ms peak hold → 2-unit step every 80 ms decay.
    // Full-flare (36→14) total duration ≈ 1.3 s — reads as a "whoosh" not a slow
    // fade. Nav-flare (28→14) ≈ 0.95 s. Both pass contrast check at opacity 0.45.
    // Safe while paused: sourceHeat is written but the sim interval is stopped;
    // the pending timers are cleared by pause() if a game starts mid-flare.
    function flare(peak = HEAT_FLARE) {
        clearTimeout(flareTimer);
        sourceHeat = Math.min(peak, HEAT_MAX);
        // Hold peak briefly, then step-cool back to steady state.
        flareTimer = setTimeout(() => {
            const cool = () => {
                if (sourceHeat > HEAT_STEADY) {
                    sourceHeat -= 2;
                    if (sourceHeat < HEAT_STEADY) sourceHeat = HEAT_STEADY;
                    flareTimer = setTimeout(cool, 80);
                }
            };
            cool();
        }, 400);
    }

    // Pause sim (tab hidden or game running — zero perf cost).
    function pause() {
        clearTimeout(flareTimer);   // abort mid-flare cooldown chain so
        flareTimer = null;          // sourceHeat stops decaying during gameplay
        paused = true;
        _stopInterval();
    }

    // Resume sim (tab visible or returned to menu).
    function resume() {
        if (!paused) return;
        paused = false;
        _startInterval();
    }

    function destroy() {
        pause();
        clearTimeout(flareTimer);
        canvas.remove();
    }

    // Single-tick cost (subject to performance.now() precision floor ~0.1ms).
    function _lastMs() { return lastTickMs; }

    // Batch benchmark: runs N tight tick loops and returns ms-per-tick.
    // Bypasses the 0.1ms resolution floor by amortising over many iterations.
    function _benchMs(n = 200) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) { _setSource(sourceHeat); _simulate(); _draw(); }
        return (performance.now() - t0) / n;
    }

    // Expose on window for browser test access.
    window._fireBg = { flare, pause, resume, _lastMs, _benchMs };

    return { flare, pause, resume, destroy, _lastMs, _benchMs };
}
