// webdoom boot: fetch engine + WAD stack, boot, drive D_DoomFrame per
// rAF. Called by lobby.js for both single player and netplay.
import { createRenderer } from './video.js';
import { createInput, loadSettings } from './input.js';
import { createAudio } from './audio.js';
import { sf2GetCurrentBytes } from './sf2-library.js';
import { attachRelay, attachSpectate } from './net.js';
import { loadPersisted, startSync } from './persist.js';
import { wadCacheGet, wadCachePut } from './wad-cache.js';
import { libraryGetBytes } from './wad-library.js';
import { createScrubberUI } from './scrubber.js';
import { setStatus as status, loading } from './ui.js';
import { perfMarks } from './perf-marks.js';

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

// onProgress(gotBytes, totalBytes|0) — the CALLER owns the display, because a
// WAD stack is fetched in parallel and one shared bar has to show the sum.
// Reporting per file meant the last chunk to land decided what the bar said.
async function fetchWad(file, sha, onProgress = () => {}) {
    const sw = swActive();

    // Local library tier — user-imported WADs live only in IDB, never on the
    // server.  Check this first, regardless of SW/origin context, so imported
    // PWADs boot without a network request even on secure origins.
    if (sha) {
        const local = await libraryGetBytes(sha).catch(() => null);
        if (local) {
            onProgress(local.length, local.length);
            return local;
        }
    }

    // IDB fallback tier — consulted only when the SW cache is absent.
    // On secure origins with an active SW the fetch below goes through the
    // SW's cache-first handler (webdoom-wads-v1); we never read IDB in that
    // case to avoid stale-data surprises, and we skip IDB writes entirely
    // to avoid duplicate storage (design rule: one store per WAD, not two).
    if (!sw && sha) {
        const cached = await wadCacheGet(sha);
        if (cached) {
            onProgress(cached.length, cached.length);
            return cached;
        }
    }

    const res = await fetch(`/wads/${file}?v=${(sha ?? '').slice(0, 8)}`);
    if (!res.ok) throw new Error(`wad fetch failed: ${file} (${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    const parts = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onProgress(got, total);
    }
    onProgress(got, total || got);
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


// wads: [{file, sha}] — first entry is the IWAD, the rest are PWADs.
// net: {slot, numplayers, jitterMs} or null for single player.
// onQuit: called when the player quits in-game (Quit Game → Y).
// record: if true, call doom._web_demo_start() before callMain so that
//         G_RecordDemo is armed before D_DoomLoop's G_BeginRecording fires.
//         The caller (lobby.js) controls the stop-and-share lifecycle.
export async function bootDoom({ wads, args = [], net = null, onQuit = null, record = false }) {
    // stackFor() in lobby.js returns [] for a WAD this client's manifest does
    // not list, and line ~162 below then reads wads[0].file.  A `launch` frame
    // naming a WAD we do not have -- which the server accepted without checking
    // its own library -- reached that as a TypeError from inside the boot, past
    // the point where the landing page had already been hidden.  A refusal with
    // a reason is what the callers' .catch() is for.
    if (!Array.isArray(wads) || wads.length === 0 || !wads[0]?.file)
        throw new Error('this browser has no copy of that WAD — ask the host which one the game is using');
    const canvas = document.getElementById('screen');
    document.getElementById('landing').hidden = true;
    canvas.hidden = false;

    loading.show('LOADING ENGINE…');

    // --- fetch phase: engine module + WADs (may fail on network error) --------
    let createDoom, bytes, persisted;
    try {
        ({ default: createDoom } = await import('/engine/doom.js'));
        // In PARALLEL, with ONE aggregate bar.  The stack is an IWAD plus its
        // PWADs and patches, and they were fetched strictly one after another
        // -- so a 200 KB patch waited on a 12 MB IWAD for no reason.  The
        // shared bar sums every file, so it still means something; a
        // compressed response (no content-length) makes the WHOLE aggregate
        // indeterminate rather than reporting a false 0%.
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
        bytes = await Promise.all(wads.map((w, i) =>
            fetchWad(w.file, w.sha, (g, t) => { got[i] = g; tot[i] = t; report(); })));
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
    let relayHandle = null;  // set after the relay attaches; same reason

    // ── ONE owner for "the engine is gone — put the player back on the launcher"
    //
    // The quit path and the two error paths used to be different code, and only
    // one of them worked.  doom.onQuit tore everything down and then called the
    // CALLER's onQuit callback — which is the thing that re-renders the menu
    // (lobby.js returnToMenu).  onDoomError and the rAF catch called
    // restoreOnFailure() instead: un-hide #landing, and stop.
    //
    // But lobby.js calls menu.hide() before booting, and menu.render() opens
    // `root.replaceChildren(); if (hidden || !screen()) return;`.  So after any
    // post-boot I_Error the player got a VISIBLE landing page with an EMPTY menu
    // in it — `booted` still true, the fire still paused, the lobby socket still
    // open — and only a page reload recovered.  The comment here read "tenet-4
    // fail-soft: landing page restored".  The landing ELEMENT was restored; the
    // menu inside it was not, which is the half the player needs.
    //
    // Every exit path goes through endSession() now, so there is one answer to
    // "what happens when the engine stops" instead of three.
    let released = false;
    let releaseResources = () => {};   // reassigned below, once the handles exist
    const endSession = (reason) => {
        if (released) return;          // I_Error then a propagating throw is one exit
        released = true;
        running = false;
        // Reads fileMap directly — no wasm calls, so this is safe after abort().
        try { syncHandle?.flush?.(); } catch { /* dead instance */ }
        try { releaseResources(); } catch { /* boot died before construction */ }
        loading.hide();
        canvas.hidden = true;
        document.getElementById('landing').hidden = false;
        // The caller's callback is what re-renders the launcher.  It runs on
        // EVERY exit now, not only the clean one.
        try { onQuit?.(); } catch { /* launcher gone */ }
        // After the callback, so the launcher's own reset cannot overwrite it.
        if (reason) { try { status(reason); } catch { /* DOM unavailable */ } }
    };

    const doom = await createDoom({
        print: t => console.log(t),
        printErr: t => console.warn(t),
        // tenet-4 fail-soft: engine death (I_Error → abort()) ⇒ launcher menu
        // restored + user-visible error + canvas/game state torn down.
        onDoomError: msg => endSession(`engine error: ${msg}`),
    });

    // no filesystem: WADs live once in the heap, small files in a JS Map
    doom['fileMap'] = persisted;
    wads.forEach((w, i) => {
        const name = i === 0 ? (ENGINE_NAME[w.file] ?? w.file) : w.file;
        const p = doom._malloc(bytes[i].length);
        // _malloc returns 0 on failure, and HEAPU8.set(bytes, 0) then writes
        // the ENTIRE WAD over address 0 -- the null page, the shadow stack and
        // static data -- with no error.  Reachable: the WAD stack holds up to
        // 40 entries and imported files have no size cap.
        if (!p) throw new Error(`out of memory registering ${name} (${bytes[i].length} bytes)`);
        doom.HEAPU8.set(bytes[i], p);
        doom.ccall('web_register_file', null,
            ['string', 'number', 'number'], [name, p, bytes[i].length]);
    });

    const pwads = wads.slice(1).flatMap(w => ['-file', w.file]);
    const baseWsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const relay = net?.spectate
        ? attachSpectate(doom, baseWsUrl, net)
        : net ? attachRelay(doom, baseWsUrl, net) : null;
    relayHandle = relay;
    // engine/web/d_net.c calls Module["netQuit"] from D_QuitNetGame.  No client
    // file had ever assigned it, so that hook fired into nothing.
    doom.netQuit = () => { try { relay?.quit?.(); } catch { /* already closed */ } };

    // Arm demo recording via the -record callMain arg (safe path):
    // G_RecordDemo runs after Z_Init inside D_DoomMain, so the zone
    // allocator is live.  G_BeginRecording fires from D_DoomLoop.
    const recordArgs = record ? ['-record', 'webdemo'] : [];

    doom.callMain([...pwads, ...args, ...recordArgs]);
    if (net?.spectate) {
        // Spectate: stream the full history (receive-only, no slot).
        loading.show('SPECTATING — CATCHING UP');
        await relay.catchUp(net.frontier ?? 0, (done, total) =>
            loading.set('SPECTATING — CATCHING UP', total ? Math.min(1, done / total) : 0));
    } else if (net?.join) {
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

    // task 19.3: seek hook — scrubber.js / lobby.js call seekTo(n) to
    // request a seek.  The rAF loop consumes seekPending each frame so
    // the seek runs on the next animation callback rather than mid-frame.
    let seekPending  = null;   // tic to seek to, or null
    let scrubberHandle = null; // { onFrame, destroy } from createScrubberUI

    // attachScrubber: called by lobby.js after startReplay to wire up the UI.
    // demoBytes: raw Uint8Array from the .lmp; container: element for the panel.
    window.webdoom.attachScrubber = (demoBytes, container) => {
        if (scrubberHandle) { scrubberHandle.destroy(); scrubberHandle = null; }
        scrubberHandle = createScrubberUI(doom, demoBytes, {
            container,
            seekHook: (n) => { seekPending = n; },
        });
    };

    syncHandle = startSync(doom, wads[0].file);

    const renderer = createRenderer(canvas);
    window.webdoom._renderer = renderer;   // task 18.3: expose renderer for browser-pipeline.mjs canvas_info
    const fb = doom._web_framebuffer();
    const pal = doom._web_palette();
    let palVersion = -1;

    loading.hide();
    status('');
    canvas.focus();
    const input = createInput(doom, canvas, loadSettings());
    doom._web_set_smooth(input.settings.smooth ? 1 : 0);

    // DOOM's framebuffer is 320x200 and does not change size.  Task 18.3 made
    // the width runtime-variable for Hor+ widescreen; that is gone, so the
    // frame loop no longer has to watch web_screenwidth() for a resize.
    const SCREEN_W = 320, SCREEN_H = 200;

    // Apply persisted music backend (task 17.1: OPL2/OPL3; task 17.2b: GM).
    // musicBackend supersedes the legacy opl3 bool; fall back gracefully.
    const _musicBackend = input.settings.musicBackend
        ?? (input.settings.opl3 ? 'opl3' : 'opl2');
    doom._web_set_opl_mode(_musicBackend === 'opl3' ? 1 : 0);
    if (_musicBackend === 'gm') {
        // Load sf2 bytes from IDB (best-effort; GM frames flow even without sf2).
        // arm() fires on first user gesture — IDB reads complete well before that.
        sf2GetCurrentBytes()
            .then(bytes => { window.doomAudio?.setGmMode(true, bytes ?? null); })
            .catch(() => { window.doomAudio?.setGmMode(true, null); });
    }

    // Quit Game → Y calls I_Quit → this hook: stop the loop, tear down,
    // and let the front end return to the main menu (a fresh wasm boots
    // on the next PLAY — this instance force-exits).
    running = true;
    // Everything the boot allocated, released in one place.  doom.onQuit and
    // both error paths call this through endSession().
    releaseResources = () => {
        // Close the relay.  Nothing did: relay.quit() exists and was called
        // only from the node harnesses, and no client file ever assigned
        // doom.netQuit, so the engine's D_QuitNetGame hook fired into nothing.
        // The socket therefore outlived the engine — its onmessage kept calling
        // deliver(), which writes into doom.HEAPU8 and calls _web_net_bundle on
        // an instance I_Quit has force-exited — and it held the server slot, so
        // nobody else could take that colour.  Starting a second game made a
        // SECOND live relay beside the first (task 23.7).
        try { relay?.quit?.(); } catch { /* already closed */ }
        // Task 23.7b: input attached listeners and the renderer allocated GL
        // objects PER BOOT, with nothing removing them.  play -> quit -> play
        // left two of every keydown handler, an orphaned rAF loop, and a fresh
        // program/VBO/2 textures on the same GL context.
        for (const h of [input, renderer]) {
            try { h?.destroy?.(); h?.dispose?.(); } catch { /* dead instance */ }
        }
        document.exitPointerLock?.();
        canvas.hidden = true;
        document.getElementById('landing').hidden = false;
        try { window.doomAudio?.stop?.(); } catch { /* dead instance */ }
        try { syncHandle?.stop?.(); } catch { /* dead instance */ }
        // task 19.3: remove scrubber panel if present.
        try { scrubberHandle?.destroy?.(); scrubberHandle = null; } catch { /* no-op */ }
    };

    // I_Quit: a clean exit, so no reason string — the launcher just comes back.
    doom.onQuit = () => endSession(null);

    const frame = (rafTime) => {
        if (!running) return;
        perfMarks.begin(rafTime);
        try {
            // task 19.3: scrubber seek — consume pending seek before normal frame.
            // web_seek_demo(N) re-sims from tic 0 with nodrawers=1, then restores
            // nodrawers=0.  web_wipe_skip() clears any pending wipe so the final
            // rendering web_frame() immediately shows the sought position.
            if (seekPending !== null) {
                const n = seekPending;
                seekPending = null;
                if (typeof doom._web_seek_demo === 'function') {
                    doom._web_seek_demo(n);
                    doom._web_wipe_skip();
                    // One rendering frame at gametic==n; advances gametic to n+1.
                    doom._web_frame();
                    // Update scrubber position display after seek.
                    scrubberHandle?.onFrame?.();
                }
            } else {
                input.frame();
                doom._web_frame();
                // Update scrubber tic position display each playback frame.
                scrubberHandle?.onFrame?.();
            }
        } catch (err) {
            // ws-001 fix: surface the error, restore landing, tear down.
            // Guard on running: onDoomError (I_Error/abort) may have already
            // cleaned up before the throw propagates here — do not double-restore.
            if (running) endSession(`engine error: ${err?.message ?? String(err)}`);
            return;
        }
        // Test-harness hook: set window._doomFrameHook = fn() before boot
        // to intercept each frame (e.g. for per-tic hash collection in CDP
        // browser tests).  No-op in production (window._doomFrameHook is
        // undefined unless the test injects it).
        window._doomFrameHook?.();
        const v = doom._web_palette_version();
        renderer.draw(
            doom.HEAPU8.subarray(fb, fb + SCREEN_W * SCREEN_H),
            doom.HEAPU8.subarray(pal, pal + 768),
            v !== palVersion,
        );
        palVersion = v;
        perfMarks.end();
        if (running) requestAnimationFrame(frame);

    };
    requestAnimationFrame(frame);
    console.log(`webdoom up — renderer: ${renderer.kind}, ${net ? `netplay slot ${net.slot}/${net.numplayers}` : 'single player'}`);
    return doom;
}
