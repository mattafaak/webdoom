// webdoom boot: fetch the engine and the WAD stack, boot, drive D_DoomFrame
// from requestAnimationFrame.  lobby.js calls this for every way into a game.
import { createRenderer } from './video.js';
import { createInput, loadSettings } from './input.js';
import { createAudio } from './audio.js';
import { attachRelay, attachSpectate } from './net.js';
import { loadPersisted, startSync } from './persist.js';
import { wadCacheGet, wadCachePut } from './wad-cache.js';
import { libraryGetBytes } from './wad-library.js';
import { createScrubberUI } from './scrubber.js';
import { setStatus as status, loading } from './ui.js';
import { perfMarks } from './perf-marks.js';

// The engine identifies games by their 1993 filenames: Ultimate Doom must be
// doomu.wad for retail detection, and a doom-shaped TC takes the same name or
// IdentifyVersion finds nothing.
const ENGINE_NAME = {
    'doom.wad': 'doomu.wad',
    'chex.wad': 'doomu.wad',    // 4-episode doom-shaped TC (has DEMO4)
};

// false on insecure origins (no navigator.serviceWorker) and in the window
// before a new worker claims the page
const swActive = () => typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

// Three tiers: the user's local library (IDB, never on the server), then the
// IDB cache when there is no service worker, then the network -- which the
// service worker caches itself on secure origins, so IDB is written only
// without one (one store per WAD, never two).  onProgress(got, total|0): the
// caller owns the display, since a stack is fetched in parallel.
//
// The bytes land in the wasm heap and nowhere else (round 10): with a known
// content-length each chunk is written straight into a heap block, so a
// 12-18 MB WAD is never held as a JS array for the session.  Returns
// {ptr, len} in `doom`'s heap.
async function fetchWad(doom, file, sha, onProgress = () => {}) {
    const sw = swActive();
    const intoHeap = bytes => {
        const ptr = doom._malloc(bytes.length);
        // a 0 from _malloc would put the whole WAD over address 0 with no error
        if (!ptr) throw new Error(`out of memory for ${file} (${bytes.length} bytes)`);
        doom.HEAPU8.set(bytes, ptr);
        return { ptr, len: bytes.length };
    };
    if (sha) {
        const local = await libraryGetBytes(sha).catch(() => null);
        if (local) { onProgress(local.length, local.length); return intoHeap(local); }
    }
    if (!sw && sha) {
        const cached = await wadCacheGet(sha);
        if (cached) { onProgress(cached.length, cached.length); return intoHeap(cached); }
    }

    const res = await fetch(`/wads/${file}?v=${(sha ?? '').slice(0, 8)}`);
    if (!res.ok) throw new Error(`wad fetch failed: ${file} (${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader();
    let got = 0, ptr = 0;
    const parts = [];                       // only without a content-length
    if (total) {
        ptr = doom._malloc(total);
        if (!ptr) throw new Error(`out of memory for ${file} (${total} bytes)`);
    }
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total) {
            if (got + value.length > total) throw new Error(`wad fetch overran content-length: ${file}`);
            doom.HEAPU8.set(value, ptr + got);
        } else parts.push(value);
        got += value.length;
        onProgress(got, total);
    }
    if (total && got !== total) throw new Error(`wad fetch short: ${file} (${got} of ${total} bytes)`);
    onProgress(got, total || got);
    if (!total) {
        const buf = new Uint8Array(got);
        let o = 0;
        for (const p of parts) { buf.set(p, o); o += p.length; }
        ({ ptr } = intoHeap(buf));
    }
    // best-effort, and a transient copy: IDB needs its own bytes
    if (!sw && sha) wadCachePut(sha, doom.HEAPU8.slice(ptr, ptr + got)).catch(() => {});
    return { ptr, len: got };
}

function restoreOnFailure(canvas) {
    loading.hide();
    canvas.hidden = true;
    document.getElementById('landing').hidden = false;
}

// wads:   [{file, sha}], the IWAD first, then PWADs and patches
// net:    {slot, numplayers, jitterMs, ...} or null for single player;
//         net.join re-simulates the history first, net.spectate is receive-only
// onQuit: runs on EVERY exit -- Quit Game, I_Error, a throw in the frame loop
// record: pass -record so G_RecordDemo is armed before G_BeginRecording fires

// The live session's one exit, reachable from outside bootDoom's closure.
//
// WHY THIS EXISTS.  endSession is the only thing that stops the rAF loop,
// releases the relay socket, the audio context and the sync interval, hides the
// canvas and un-hides #landing -- and it was a closure local, so a caller that
// had already got its `doom` back could not reach it.  lobby.js's
// resetToLauncher therefore "returned to the launcher" by resetting menu state
// while the engine kept running behind a hidden #landing: the launcher rendered
// invisibly, the status message explaining the failure was unreadable, window
// input listeners still fed the live engine, and `booted` was false again, so a
// keypress could boot a SECOND engine onto the same canvas.  The reachable
// trigger is a demo permalink whose header the engine rejects -- one click.
//
// Returns whether there was a session to end, so a caller can tell the two
// cases apart.  Re-entrant by construction: the handle is cleared before
// endSession runs, and endSession's own `released` flag is the second guard,
// so endSession -> onQuit -> resetToLauncher -> here terminates.
let activeEndSession = null;
export function endActiveSession(reason = null) {
    const fn = activeEndSession;
    activeEndSession = null;
    if (!fn) return false;
    try { fn(reason); } catch { /* boot died mid-construction */ }
    return true;
}

export async function bootDoom({ wads, args = [], net = null, onQuit = null, record = false }) {
    // a `launch` naming a WAD this client has no copy of arrives as [] from
    // stackFor(); refuse with a reason before the landing page is hidden
    if (!Array.isArray(wads) || wads.length === 0 || !wads[0]?.file)
        throw new Error('this browser has no copy of that WAD — ask the host which one the game is using');
    const canvas = document.getElementById('screen');
    document.getElementById('landing').hidden = true;
    canvas.hidden = false;

    loading.show('LOADING ENGINE…');

    // declared before createDoom: onDoomError can fire before the loop starts
    let running = false;
    let syncHandle = null;
    // Disposers, pushed AS EACH HANDLE IS CREATED, and run in reverse.
    //
    // This used to be one `releaseResources = () => {...}` assignment at the
    // END of the boot, 60 lines after the first thing it releases.  Anything
    // that threw in between escaped cleanup entirely: the relay WebSocket
    // (so the server kept the colour slot for the rest of the session and
    // refused the reconnect), the AudioContext with its three window-level
    // arm listeners, and a 3 s interval left poking a dead instance.  Two
    // reachable triggers: a shader compile failure throwing out of
    // createRenderer, and an I_Error during callMain.
    //
    // Registering beside the construction is the fix that cannot drift: a
    // handle added later without a disposer is visible at the call site.
    const disposers = [];
    const releaseResources = () => {
        while (disposers.length) {
            try { disposers.pop()(); } catch { /* dead instance */ }
        }
        document.exitPointerLock?.();
        canvas.hidden = true;
        document.getElementById('landing').hidden = false;
    };

    // One exit for the quit path and both error paths.  The caller's onQuit
    // is what re-renders the launcher, so it runs on every exit; the reason
    // is written after it, so the launcher's own reset cannot blank it.
    let released = false;
    const endSession = (reason) => {
        if (released) return;          // I_Error then a propagating throw is one exit
        released = true;
        activeEndSession = null;       // nothing outside may re-enter this
        running = false;
        try { syncHandle?.flush?.(); } catch { /* dead instance */ }   // no wasm calls: safe after abort()
        try { releaseResources(); } catch { /* boot died before construction */ }
        loading.hide();
        canvas.hidden = true;
        document.getElementById('landing').hidden = false;
        try { onQuit?.(); } catch { /* launcher gone */ }
        if (reason) { try { status(reason); } catch { /* DOM unavailable */ } }
    };
    // Published here, not after the boot completes: a failure anywhere in the
    // rest of this function still needs a working teardown, and that is exactly
    // the window in which the relay socket and the audio listeners already
    // exist while nothing is watching them.
    activeEndSession = endSession;

    // the engine first, so the WADs can stream into its heap; then every WAD
    // in parallel, one aggregate bar.  A response without content-length
    // makes the whole bar indeterminate rather than a false 0%.
    let doom, blocks, persisted;
    try {
        const { default: createDoom } = await import('/engine/doom.js');
        doom = await createDoom({
            print: t => console.log(t),
            printErr: t => console.warn(t),
            onDoomError: msg => endSession(`engine error: ${msg}`),   // I_Error → abort()
        });
        const got = new Array(wads.length).fill(0);
        const tot = new Array(wads.length).fill(0);
        const mb = n => (n / 1048576).toFixed(1);
        const report = () => {
            const g = got.reduce((a, b) => a + b, 0);
            const known = tot.every(t => t > 0);
            const t = tot.reduce((a, b) => a + b, 0);
            const what = wads.length > 1 ? `${wads.length} FILES` : wads[0].file;
            if (known) loading.set(`FETCHING ${what} — ${mb(g)} / ${mb(t)} MB`, t ? g / t : 0);
            else loading.indeterminate(`FETCHING ${what} — ${mb(g)} MB`);
        };
        blocks = await Promise.all(wads.map((w, i) =>
            fetchWad(doom, w.file, w.sha, (g, t) => { got[i] = g; tot[i] = t; report(); })));
        persisted = await loadPersisted(wads[0].file);
    } catch (err) {
        restoreOnFailure(canvas);
        throw err;
    }

    loading.set('BOOTING…', 1);

    // no filesystem: WADs live once in the heap, small files in a JS Map
    doom['fileMap'] = persisted;
    wads.forEach((w, i) => {
        const name = i === 0 ? (ENGINE_NAME[w.file] ?? w.file) : w.file;
        doom.ccall('web_register_file', null,
            ['string', 'number', 'number'], [name, blocks[i].ptr, blocks[i].len]);
    });

    const pwads = wads.slice(1).flatMap(w => ['-file', w.file]);
    const baseWsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const relay = net?.spectate
        ? attachSpectate(doom, baseWsUrl, net)
        : net ? attachRelay(doom, baseWsUrl, net) : null;
    doom.netQuit = () => { try { relay?.quit?.(); } catch { /* already closed */ } };   // D_QuitNetGame
    disposers.push(() => relay?.quit?.());

    // -record here rather than a pre-boot call: G_RecordDemo needs the zone
    // allocator, which D_DoomMain initialises first
    doom.callMain([...pwads, ...args, ...(record ? ['-record', 'webdemo'] : [])]);
    if (net?.spectate) {
        loading.show('SPECTATING — CATCHING UP');
        await relay.catchUp(net.frontier ?? 0, (done, total) =>
            loading.set('SPECTATING — CATCHING UP', total ? Math.min(1, done / total) : 0));
    } else if (net?.join) {
        // re-simulate the streamed history to the frontier, then watch a live
        // player until our slot spawns (the engine snaps the view back then)
        loading.show('JOINING — CATCHING UP');
        await relay.catchUp(net.frontier ?? 0, (done, total) =>
            loading.set('JOINING — CATCHING UP', total ? Math.min(1, done / total) : 0));
        const anchor = doom._web_first_ingame();
        if (anchor >= 0 && anchor !== net.slot) doom._web_set_console(anchor);
    } else {
        relay?.go();
    }
    window.doomAudio = createAudio(doom);
    disposers.push(() => window.doomAudio?.stop?.());
    window.webdoom = { doom };              // debug/test handle

    // The scrubber asks for a seek; the frame loop performs it on the next
    // animation callback, never mid-frame.
    let seekPending = null;
    let scrubberHandle = null;
    disposers.push(() => { scrubberHandle?.destroy?.(); scrubberHandle = null; });
    window.webdoom.attachScrubber = (demoBytes, container) => {
        scrubberHandle?.destroy();
        scrubberHandle = createScrubberUI(doom, demoBytes, { container, seekHook: n => { seekPending = n; } });
    };

    syncHandle = startSync(doom, wads[0].file);
    disposers.push(() => syncHandle?.stop?.());

    const renderer = createRenderer(canvas);
    disposers.push(() => { renderer?.destroy?.(); renderer?.dispose?.(); });
    window.webdoom._renderer = renderer;   // browser-pipeline reads .kind
    // memory never grows (ALLOW_MEMORY_GROWTH=0), so the views are stable
    const fb = doom._web_framebuffer();
    const pal = doom._web_palette();
    const fbView = doom.HEAPU8.subarray(fb, fb + 320 * 200);
    const palView = doom.HEAPU8.subarray(pal, pal + 768);
    let palVersion = -1;

    loading.hide();
    status('');
    canvas.focus();
    const input = createInput(doom, canvas, loadSettings());
    disposers.push(() => { input?.destroy?.(); input?.dispose?.(); });
    doom._web_set_smooth(input.settings.smooth ? 1 : 0);

    // through doomAudio, not the export: on the worklet tier the flavour has
    // to reach the worklet's own copy of the synth as well
    window.doomAudio.setOplMode(input.settings.musicBackend === 'opl3' ? 1 : 0);

    running = true;

    doom.onQuit = () => endSession(null);   // I_Quit: a clean exit, no reason

    const frame = (rafTime) => {
        if (!running) return;
        perfMarks.begin(rafTime);
        try {
            if (seekPending !== null) {
                // re-sim from tic 0 with drawing off, clear any pending wipe,
                // then one drawn frame at the sought tic
                const n = seekPending;
                seekPending = null;
                if (typeof doom._web_seek_demo === 'function') {
                    doom._web_seek_demo(n);
                    doom._web_wipe_skip();
                    doom._web_frame();
                    scrubberHandle?.onFrame?.();
                }
            } else {
                input.frame();
                doom._web_frame();
                scrubberHandle?.onFrame?.();
            }
            // INSIDE the same try as the engine call, deliberately.  These
            // three lines sat after the catch, so a throw from the frame hook,
            // the palette read or the GL draw killed the rAF loop with no
            // endSession at all: no status message, #landing still hidden, the
            // canvas still visible, input listeners still attached and the
            // relay socket still holding its server slot -- the ws-001 silent
            // wedge, in the one loop that exists to prevent it.
            //
            // browser-rafdeath injects by patching doom._web_frame, which is
            // the statement that WAS covered, so the gate proved the guarded
            // line was guarded and said nothing about these.  It injects here
            // now as well.
            window._doomFrameHook?.();      // test seam: per-frame hash collection
            const v = doom._web_palette_version();
            renderer.draw(fbView, palView, v !== palVersion);
            palVersion = v;
        } catch (err) {
            // onDoomError may already have ended the session before the throw
            // propagated here
            if (running) endSession(`engine error: ${err?.message ?? String(err)}`);
            return;
        }
        perfMarks.end();
        if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    console.log(`webdoom up — renderer: ${renderer.kind}, ${net ? `netplay slot ${net.slot}/${net.numplayers}` : 'single player'}`);
    return doom;
}
