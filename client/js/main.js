// webdoom boot: fetch engine + WAD stack, boot, drive D_DoomFrame per
// rAF. Called by lobby.js for both single player and netplay.
import { createRenderer } from './video.js';
import { createInput, loadSettings } from './input.js';
import { createAudio } from './audio.js';
import { createSettingsUI } from './settings.js';
import { attachRelay } from './net.js';
import { loadPersisted, startSync } from './persist.js';
import { wadCacheGet, wadCachePut } from './wad-cache.js';

const status = msg => { document.getElementById('status').textContent = msg; };

// centred loading panel + progress bar
const loading = {
    show(label) {
        document.getElementById('loading-label').textContent = label;
        document.getElementById('loading-fill').style.width = '0%';
        document.getElementById('loading').hidden = false;
    },
    set(label, frac) {
        document.getElementById('loading-label').textContent = label;
        document.getElementById('loading-fill').style.width = `${Math.round((frac ?? 0) * 100)}%`;
    },
    hide() { document.getElementById('loading').hidden = true; },
};

// The engine identifies games by 1993 filenames. Ultimate Doom must be
// doomu.wad (retail detection); the standalone TCs get the filename of
// the game mode they are shaped like, or IdentifyVersion finds nothing
// and the engine aborts with an empty WAD list.
const ENGINE_NAME = {
    'doom.wad': 'doomu.wad',
    'chex.wad': 'doomu.wad',    // 4-episode doom-shaped TC (has DEMO4)
};

// Is the service worker currently active as the page's controller?
// Returns false on insecure origins (plain http://<LAN-IP>) where
// navigator.serviceWorker is undefined, and also in the brief window
// before a newly-installed SW claims the page.
function swActive() {
    return typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        !!navigator.serviceWorker.controller;
}

async function fetchWad(file, sha) {
    const sw = swActive();

    // IDB fallback tier — consulted only when the SW cache is absent.
    // On secure origins with an active SW the fetch below goes through the
    // SW's cache-first handler (webdoom-wads-v1); we never read IDB in that
    // case to avoid stale-data surprises, and we skip IDB writes entirely
    // to avoid duplicate storage (design rule: one store per WAD, not two).
    if (!sw && sha) {
        const cached = await wadCacheGet(sha);
        if (cached) {
            loading.set(`LOADING ${file} (cached)…`, 1);
            return cached;
        }
    }

    const res = await fetch(`/wads/${file}?v=${(sha ?? '').slice(0, 8)}`);
    if (!res.ok) throw new Error(`wad fetch failed: ${file} (${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    const mb = n => (n / 1048576).toFixed(1);
    const parts = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        loading.set(total ? `FETCHING ${file} — ${mb(got)} / ${mb(total)} MB` : `FETCHING ${file}…`,
            total ? got / total : 0);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }

    // Write to IDB only on insecure origins without an active SW.
    // On secure origins (active SW) the SW cache-first handler already stored
    // the WAD in webdoom-wads-v1; no IDB write needed.
    if (!sw && sha) {
        wadCachePut(sha, buf).catch(() => {}); // fire-and-forget; non-fatal
    }

    return buf;
}

// Restore the landing page when loading fails so the user is not left on
// a blank canvas with no way back.
function restoreOnFailure(canvas) {
    loading.hide();
    canvas.hidden = true;
    document.getElementById('landing').hidden = false;
}

// Per-frame profiling via ?perfmarks=1 query flag.
// When enabled, window.__wd_perf is created and the rAF frame loop populates
// it with raw duration arrays.  tools/browser-pipeline.mjs reads the arrays
// via CDP Runtime.evaluate at the end of a run to compute per-stage stats.
// All overhead is gated behind a single null-check — zero cost otherwise.
const _perfmarks = typeof location !== 'undefined' &&
    new URLSearchParams(location.search).has('perfmarks');
if (_perfmarks) {
    window.__wd_perf = {
        frames: 0,          // rAF callbacks counted
        raf: [],            // (c) frame-to-frame interval (ms) — rAF jitter
        rafDur: [],         // (c) rAF callback duration (ms)
        palette: [],        // (a) palette upload duration (ms); only when dirty
        upload: [],         // (b) FB texSubImage2D / putImageData duration (ms)
        inputLat: [],       // (e) keydown.timeStamp → renderer.draw() returns (ms)
        worklet: [],        // (d) AudioWorklet process() duration (ms) posted via port
        _lastRafTime: 0,
        _frameCallStart: 0,
        _pendingInputTime: undefined,
    };
    // (e) input latency: capture event.timeStamp on the first untracked keydown
    window.addEventListener('keydown', e => {
        const perf = window.__wd_perf;
        if (perf && perf._pendingInputTime === undefined)
            perf._pendingInputTime = e.timeStamp;
    }, { capture: true });
}

// wads: [{file, sha}] — first entry is the IWAD, the rest are PWADs.
// net: {slot, numplayers, jitterMs} or null for single player.
// onQuit: called when the player quits in-game (Quit Game → Y).
export async function bootDoom({ wads, args = [], net = null, onQuit = null }) {
    const canvas = document.getElementById('screen');
    document.getElementById('landing').hidden = true;
    canvas.hidden = false;

    loading.show('LOADING ENGINE…');

    // --- fetch phase: engine module + WADs (may fail on network error) --------
    let createDoom, bytes, persisted;
    try {
        ({ default: createDoom } = await import('/engine/doom.js'));
        bytes = [];
        for (const w of wads) bytes.push(await fetchWad(w.file, w.sha));
        persisted = await loadPersisted(wads[0].file);
    } catch (err) {
        // Restore landing so the user can read the error and retry.
        restoreOnFailure(canvas);
        throw err;
    }
    // --------------------------------------------------------------------------

    loading.set('BOOTING…', 1);
    // running is declared here (before createDoom) so the onDoomError closure can
    // set it to false even if I_Error fires before the frame loop begins.
    // The assignment `running = true` below (after all setup) starts the loop.
    let running = false;
    let syncHandle = null;   // set after startSync; referenced in onDoomError closure
    const doom = await createDoom({
        print: t => console.log(t),
        printErr: t => console.warn(t),
        // tenet-4 fail-soft: engine death (I_Error → abort()) ⇒ landing page
        // restored + user-visible error + canvas/game state torn down.
        onDoomError: msg => {
            running = false;
            restoreOnFailure(canvas);
            status(`engine error: ${msg}`);
            try { window.doomAudio?.stop?.(); } catch { /* dead instance */ }
            try { syncHandle?.stop?.(); } catch { /* dead instance */ }
        },
    });

    // no filesystem: WADs live once in the heap, small files in a JS Map
    doom['fileMap'] = persisted;
    wads.forEach((w, i) => {
        const name = i === 0 ? (ENGINE_NAME[w.file] ?? w.file) : w.file;
        const p = doom._malloc(bytes[i].length);
        doom.HEAPU8.set(bytes[i], p);
        doom.ccall('web_register_file', null,
            ['string', 'number', 'number'], [name, p, bytes[i].length]);
    });

    const pwads = wads.slice(1).flatMap(w => ['-file', w.file]);
    const relay = net
        ? attachRelay(doom, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, net)
        : null;

    doom.callMain([...pwads, ...args]);
    if (net?.join) {
        // Drop-in: re-simulate the streamed cmd history to the live frontier
        // (headless, at speed), then park the view on a live player until our
        // own slot spawns — the engine snaps it back to us at that tic.
        loading.show('JOINING — CATCHING UP');
        await relay.catchUp(net.frontier ?? 0, (done, total) =>
            loading.set('JOINING — CATCHING UP', total ? Math.min(1, done / total) : 0));
        const anchor = doom._web_first_ingame();
        if (anchor >= 0 && anchor !== net.slot) doom._web_set_console(anchor);
    } else {
        relay?.go();
    }
    window.doomAudio = createAudio(doom);
    window.webdoom = { doom };              // debug/test handle
    syncHandle = startSync(doom, wads[0].file);

    const renderer = createRenderer(canvas);
    const fb = doom._web_framebuffer();
    const pal = doom._web_palette();
    let palVersion = -1;

    loading.hide();
    status('');
    canvas.focus();
    const input = createInput(doom, canvas, loadSettings());
    createSettingsUI(input, doom);
    doom._web_set_smooth(input.settings.smooth ? 1 : 0);

    // Quit Game → Y calls I_Quit → this hook: stop the loop, tear down,
    // and let the front end return to the main menu (a fresh wasm boots
    // on the next PLAY — this instance force-exits).
    running = true;
    doom.onQuit = () => {
        running = false;
        document.exitPointerLock?.();
        canvas.hidden = true;
        document.getElementById('landing').hidden = false;
        try { window.doomAudio?.stop?.(); } catch { /* dead instance */ }
        try { syncHandle?.stop?.(); } catch { /* dead instance */ }
        onQuit?.();
    };

    // rafTime: DOMHighResTimeStamp provided by requestAnimationFrame — used for
    // jitter measurement (interval between consecutive rAF invocations).
    const frame = (rafTime) => {
        if (!running) return;
        const perf = window.__wd_perf;
        if (perf) {
            // (c) rAF jitter: interval since last frame
            if (perf.frames > 0) perf.raf.push(rafTime - perf._lastRafTime);
            perf._lastRafTime = rafTime;
            perf._frameCallStart = performance.now();
        }
        try {
            input.frame();
            doom._web_frame();
        } catch (err) {
            // ws-001 fix: surface the error, restore landing, tear down.
            // Guard on running: onDoomError (I_Error/abort) may have already
            // cleaned up before the throw propagates here — do not double-restore.
            if (running) {
                running = false;
                try { restoreOnFailure(canvas); } catch { /* DOM torn down */ }
                try { status(`engine error: ${err?.message ?? String(err)}`); } catch { /* DOM unavailable */ }
                try { window.doomAudio?.stop?.(); } catch { /* dead instance */ }
                try { syncHandle?.stop?.(); } catch { /* dead instance */ }
            }
            return;
        }
        const v = doom._web_palette_version();
        renderer.draw(
            doom.HEAPU8.subarray(fb, fb + 320 * 200),
            doom.HEAPU8.subarray(pal, pal + 768),
            v !== palVersion,
        );
        palVersion = v;
        if (perf) {
            // (c) rAF callback total duration
            perf.rafDur.push(performance.now() - perf._frameCallStart);
            // (e) input latency: event.timeStamp → renderer.draw() returns
            if (perf._pendingInputTime !== undefined) {
                perf.inputLat.push(performance.now() - perf._pendingInputTime);
                perf._pendingInputTime = undefined;
            }
            perf.frames++;
        }
        if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    console.log(`webdoom up — renderer: ${renderer.kind}, ${net ? `netplay slot ${net.slot}/${net.numplayers}` : 'single player'}`);
    return doom;
}
