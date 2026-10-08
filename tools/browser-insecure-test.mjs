#!/usr/bin/env node
// Insecure-origin WAD cache gate.
//
// Proves that the IDB fallback tier in wad-cache.js caches WADs on insecure
// origins where the service worker cannot engage.
//
// Mechanism:
//   --host-resolver-rules="MAP insecure.test 127.0.0.1" routes the hostname
//   to the local server.  http://insecure.test:<port> is NOT a secure context
//   (unlike http://127.0.0.1 which Chrome treats as loopback-secure): the SW
//   registration guard in lobby.js never fires, navigator.serviceWorker is
//   absent, and wad-cache.js IDB path activates.
//
// Session 1: boot SP → WAD downloaded from network (server logs /wads/ hit),
//            and its IndexedDB copy committed before the tab is closed.
// Session 2: fresh tab, same Chrome profile (same IDB), the HTTP cache
//            bypassed → WAD served from IDB; server receives ZERO /wads/
//            requests, and a WAD seeded between the sessions under a sha256
//            the server does not serve is pruned.
//
// RED-PROOF: stash the wad-cache.js + main.js changes and run — session 2
// will re-download the WAD (wadHits.s2 > 0) and the assertion fails.
//
// Wired into run-tests.sh as the browser-insecure leg.
//
// Usage: node tools/browser-insecure-test.mjs
import { join } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
import { startServer } from './lib/server.mjs';
import { sleep } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

// the server logs each request; the test counts /wads/ hits per session, and
// keeps the names session 1 fetched
const wadHits = { s1: 0, s2: 0 };
const wadFiles1 = new Set();
let activeSession = 0;
const srv = await startServer({ env: { LOG_REQUESTS: '1' }, onStderr: chunk => {
    for (const line of chunk.split('\n'))
        if (line.includes('/wads/')) {
            if (activeSession === 1) {
                wadHits.s1++;
                const m = /^GET \/wads\/(\S+)/.exec(line);
                if (m) wadFiles1.add(decodeURIComponent(m[1]));
            } else if (activeSession === 2) wadHits.s2++;
        }
} });

// The keys of the webdoom-wads store, or null when it cannot be read.  The
// open creates the store if this read comes first, as client/js/idb.js does,
// so a read can never leave a version-1 database without it.
const IDB_KEYS = `(async () => {
    try {
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open('webdoom-wads', 1);
            r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('wads')) r.result.createObjectStore('wads'); };
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
        const keys = await new Promise((res, rej) => {
            const t = db.transaction('wads', 'readonly');
            const r = t.objectStore('wads').getAllKeys();
            t.oncomplete = () => res(r.result);
            t.onerror = () => rej(t.error);
        });
        db.close();
        return keys;
    } catch (e) { return null; }
})()`;
const insecureUrl = `http://insecure.test:${srv.port}/`;
// a fresh profile per run (launchChrome), so the SW cache is always cold on entry
const chrome = await launchChrome({ gpu: 'none', flags: ['--host-resolver-rules=MAP insecure.test 127.0.0.1'] });
const openTab = tabUrl => chrome.tab(tabUrl);

// Wait for lobby menu (#dmenu .row[data-label="SINGLE PLAYER"]).
// The poll, the selector and the error-status check are tab.waitForMenu() in
// tools/lib/cdp.mjs; this wrapper is only this file's FAILURE POLICY.  Keeping
// the policy local is the point: the shared primitive returns false on timeout,
// and these call sites ignore the return value, so adopting it bare would have
// turned every timeout into a silent continue.
async function waitForMenu(tab, label = 'tab', timeoutSecs = 30) {
    let ok;
    try { ok = await tab.waitForMenu(timeoutSecs); }
    catch (e) { fatal(`${label}: ${e.message}`); }
    if (ok) return;
    const s = await tab.ev(`document.getElementById('status')?.textContent`);
    fatal(`${label}: lobby menu did not appear within ${timeoutSecs}s (status: "${s}")`);
}

// Click SP → game and wait for engine canvas + empty status.
async function bootIntoSP(tab, label = 'tab', timeoutSecs = 90) {
    let clicked = false;
    for (let i = 0; i < timeoutSecs * 2; i++) {
        await sleep(500);
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        // Allow the degraded-mode notice in status while waiting for menu click
        if (s?.startsWith('engine error') || s?.startsWith('cannot') || s?.startsWith('Error'))
            fatal(`${label}: engine error during SP boot: "${s}"`);
        if (!clicked) {
            clicked = await tab.ev(`(() => {
                const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
                if (!sp) return false;
                sp.click();
                const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]')
                       || document.querySelector('#dmenu .row[data-label*="DOOM"]');
                if (!g) return false;
                g.click();
                return true;
            })()`);
            continue;
        }
        // The engine running, not the boot begun: bootDoom un-hides the
        // canvas before it fetches anything (client/js/main.js), so the canvas
        // and an empty status line hold from the first moment of a boot, and a
        // check of the server's /wads/ log made then sees no request yet.  The
        // engine handle is published, and the loading panel hidden, only once
        // the WAD is in the heap and the frame loop starts.
        const running = await tab.ev(
            `!!window.webdoom?.doom && document.getElementById('loading')?.hidden === true &&
             !document.getElementById('screen').hidden &&
             document.getElementById('status')?.textContent === ''`,
        );
        if (running) return;
    }
    const s = await tab.ev(`document.getElementById('status')?.textContent`);
    fatal(`${label}: engine did not boot within ${timeoutSecs}s (status: "${s}")`);
}

// ── Pre-flight: confirm insecure context ──────────────────────────────────────
console.log('[0] Pre-flight: verifying insecure context...');
const tabCheck = await openTab(insecureUrl);
await sleep(1000);
const swInNav = await tabCheck.ev(`'serviceWorker' in navigator`);
if (swInNav) {
    fatal(`navigator.serviceWorker exists on ${insecureUrl} — this is NOT an insecure context.` +
          ' Check --host-resolver-rules and Chrome version.');
}
console.log(`  confirmed: navigator.serviceWorker absent on ${insecureUrl} (insecure context)`);

// First-ever load in this fresh profile: the one-shot plain-HTTP notice must
// be visible here (and only here — later sessions assert suppression).
await waitForMenu(tabCheck, 'tabCheck (pre-flight)');
const noticeMsg = await tabCheck.ev(`document.getElementById('status')?.textContent`);
check('the one-shot plain-HTTP notice is shown on first load', noticeMsg?.includes('cached locally'),
      `got: "${noticeMsg}"`);
console.log(`  one-shot notice on first load: "${noticeMsg}"`);
tabCheck.close();

// ── Session 1: boot SP — WAD must come from network ───────────────────────────
console.log('[1] Session 1: boot SP on insecure origin...');
activeSession = 1;
const tab1 = await openTab(insecureUrl);
await waitForMenu(tab1, 'tab1 (session 1)');

// The one-shot notice was consumed by the pre-flight load: later sessions
// must NOT show it again (field report: an every-launch banner reads as an
// error).
const degradedMsg = await tab1.ev(`document.getElementById('status')?.textContent`);
check('session 1: the plain-HTTP notice is not shown again', !degradedMsg?.includes('cached locally'),
      `it reappeared — should be one-shot (got: "${degradedMsg}")`);
console.log(`  session 1: notice suppressed (status: "${degradedMsg}")`);

await bootIntoSP(tab1, 'tab1 (session 1)');
console.log('  SP booted — checking server WAD hit count...');
// Flush any buffered stderr output.
await sleep(500);
check('session 1: the WAD was downloaded from the server', wadHits.s1 > 0,
      'session 1 made zero /wads/ server requests');
console.log(`  session 1: ${wadHits.s1} /wads/ server hit(s) — WAD downloaded from network`);

// The IndexedDB copy is written fire-and-forget once the download is in the
// engine's heap (client/js/main.js fetchWad: wadCachePut(...).catch(() => {})),
// so a running engine says nothing about whether that write has committed, and
// closing the tab can abort a transaction still in flight.  Wait for the copy
// itself, under the sha256 the server lists for each file session 1 fetched,
// before anything closes the tab.
const listed = (await tab1.ev(`fetch('/api/wads').then(r => r.json()).catch(() => null)`))?.wads ?? [];
const wantShas = [...wadFiles1].map(f => listed.find(w => w.file === f)?.sha256).filter(Boolean);
if (!wantShas.length) fatal(`session 1 fetched ${[...wadFiles1].join(', ') || 'no WAD'}, none of which /api/wads lists`);
const idbT0 = Date.now();
const inIdb1 = await tab1.waitFor(async () => {
    const k = await tab1.ev(IDB_KEYS);
    return Array.isArray(k) && wantShas.every(sha => k.includes(sha));
}, { timeout: 20000, every: 250 });
check('session 1: the downloaded WAD reached IndexedDB before the tab closed', inIdb1,
      `${[...wadFiles1].join(', ')} (${wantShas.map(x => x.slice(0, 8)).join(', ')}…) not in webdoom-wads after 20 s; ` +
      `keys: ${JSON.stringify(await tab1.ev(IDB_KEYS))}`);
if (inIdb1) console.log(`  session 1: ${[...wadFiles1].join(', ')} in IndexedDB ${Date.now() - idbT0} ms after the boot`);

// A WAD the server no longer serves: a sha256 no manifest lists.  The next
// launcher load must prune it, keeping the WAD it does serve.
const STALE = 'f'.repeat(64);
const seeded = await tab1.ev(`(async () => {
    try {
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open('webdoom-wads', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('wads');
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        await new Promise((res, rej) => {
            const t = db.transaction('wads', 'readwrite');
            t.objectStore('wads').put(new Uint8Array(4096), '${STALE}');
            t.oncomplete = res; t.onerror = () => rej(t.error);
        });
        db.close();
        return true;
    } catch (e) { return String(e); }
})()`);
if (seeded !== true) fatal(`could not seed a stale WAD into IndexedDB: ${seeded}`);
tab1.close();

// ── Session 2: fresh tab, same IDB — WAD must NOT hit network ────────────────
console.log('[2] Session 2: fresh tab, same profile — IDB must serve WAD...');
activeSession = 2;
// Chrome's HTTP cache must not answer for IndexedDB: the server sends /wads/
// as `public, max-age=31536000, immutable` (server/serve.js), so a session 2
// that read nothing from IndexedDB still made zero /wads/ requests (measured
// both ways: with the IndexedDB write delayed past the tab's close, the store
// held 0 keys after session 2 while the zero-request check passed; with the
// client's IndexedDB read disabled, every check passed).  The tab bypasses the
// HTTP cache from before its first request, so a WAD not taken from
// IndexedDB is a request the server sees.
const tab2 = await openTab('about:blank');
await tab2.cdp('Network.enable');
await tab2.cdp('Network.setCacheDisabled', { cacheDisabled: true });
await tab2.cdp('Page.navigate', { url: insecureUrl });
await waitForMenu(tab2, 'tab2 (session 2)');

// One-shot notice must stay suppressed in session 2 as well.
const degradedMsg2 = await tab2.ev(`document.getElementById('status')?.textContent`);
check('session 2: the plain-HTTP notice is not shown again', !degradedMsg2?.includes('cached locally'),
      `it reappeared — should be one-shot (got: "${degradedMsg2}")`);

await bootIntoSP(tab2, 'tab2 (session 2)');
// Flush any buffered stderr output.
await sleep(500);

check('session 2: the WAD came from IndexedDB, with no /wads/ request', wadHits.s2 === 0,
      `session 2 made ${wadHits.s2} /wads/ server request(s).` +
      ' RED-PROOF: on unfixed client session 2 always re-downloads.');
console.log(`  session 2: ${wadHits.s2} /wads/ server request(s)${wadHits.s2 === 0 ? ' — WAD served from IDB cache' : ''}`);

// Confirm IDB has the WAD stored, and only the WADs the server serves.
const idbKeys = await tab2.ev(IDB_KEYS) ?? [];
const served = new Set(((await tab2.ev(`fetch('/api/wads').then(r => r.json()).catch(() => null)`))?.wads ?? []).map(w => w.sha256));
const servedKeys = idbKeys.filter(k => served.has(k));
console.log(`  IDB webdoom-wads keys after session 2: ${idbKeys.length} (${servedKeys.length} the server serves)`);
check('the IDB webdoom-wads store holds the WAD', servedKeys.length > 0,
      'the store holds no WAD the server serves after session 2 (wad was not persisted in session 1)');
check('a cached WAD the server no longer serves was pruned', !idbKeys.includes(STALE),
      `the stale ${STALE.slice(0, 8)}… entry is still there: ${idbKeys.length} keys`);
check('nothing but served WADs is left in the cache', idbKeys.length === servedKeys.length,
      `${idbKeys.length - servedKeys.length} unserved keys remain`);

// ── Music fallback assertion (real insecure context, no synthetic forcing) ────
// arm() has not been called yet: JS-simulated element.click() calls in
// bootIntoSP dispatch only click events, NOT keydown/mousedown, so the
// arm() listener was never triggered.  A CDP-synthesized keydown triggers it
// here, and on an insecure origin ctx.audioWorklet is genuinely undefined
// (browser restriction) — the BufferSink path activates without any synthetic
// override.  This is the real insecure-context music path.
console.log('[3] Music: assert BufferSink activated on real insecure context (no synthetic forcing)...');
await tab2.cdp('Input.dispatchKeyEvent', {
    type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87,
});
await sleep(60);
await tab2.cdp('Input.dispatchKeyEvent', {
    type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87,
});
// arm() is async (it awaits ctx.resume() before choosing a sink), and the
// first chunk exists once pump(), every PUMP_MS = 100 ms, has run: wait for a
// sink and a chunk, with a deadline, rather than a fixed 700 ms.  A timeout
// falls through to the checks below, which say what was missing.
const armT0 = Date.now();
const armed = await tab2.waitFor(
    () => tab2.ev(`!!window.doomAudio?.sinkKind?.() && (window.doomAudio.lastChunk?.()?.length ?? 0) > 0`),
    { timeout: 20000, every: 100 });
console.log(`  music: ${armed ? `a sink and a first chunk ${Date.now() - armT0} ms after the key-up` : 'no sink with a chunk within 20 s'}`);

const musicSinkKind = await tab2.ev(`window.doomAudio?.sinkKind()`);
if (musicSinkKind !== 'buffer') {
    console.error('  doomAudio armed:', await tab2.ev(`window.doomAudio?.armed()`));
    console.error('  doomAudio keys:', await tab2.ev(
        `window.doomAudio ? Object.keys(window.doomAudio).join(',') : 'null'`));
}
check(`the music sink on a real insecure origin is 'buffer'`, musicSinkKind === 'buffer',
      `got '${String(musicSinkKind)}'`);

const musicRms = await tab2.ev(`(() => {
    const chunk = window.doomAudio?.lastChunk();
    if (!chunk || !chunk.length) return -1;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    return Math.sqrt(sum / chunk.length);
})()`);
check('lastChunk() holds samples: the pump ran', musicRms !== null && musicRms !== undefined && musicRms >= 0,
      `got ${musicRms}`);
check('the music is audible: RMS >= 0.0005', musicRms >= 0.0005,
      `RMS ${Number(musicRms).toFixed(6)} — OPL silent`);

// The written message, not the live element: the compatibility notice has an
// 8 s ttl, so a live read would be a race against this test's own speed.
const musicStatus = await tab2.ev(`window.__wdLastStatus ?? document.getElementById('status')?.textContent`);
check(`the status line says 'compatibility mode'`, musicStatus?.includes('compatibility mode'),
      `got '${String(musicStatus)}'`);
console.log(`  music sink=${musicSinkKind}  rms=${Number(musicRms).toFixed(5)}  status="${musicStatus}"`);

// ── Sustained playback: the pump must keep pushing past the first backlog. ──
// A cached BufferSink.queued deadlocked the pump after ~0.25 s for months
// (music died after 1-2 notes in the field) while this test's single-chunk
// RMS assert stayed green.  Two samples 1.5 s apart must differ.
const sig = async () => tab2.ev(
    `(() => { const c = window.doomAudio?.lastChunk(); if (!c) return 'null';
       return c.length + ':' + c[0] + ':' + (c[64] ?? 0) + ':' + (c[400] ?? 0); })()`);
const sustainA = await sig();
await sleep(1500);
const sustainB = await sig();
check('the pump is still pushing after 1.5 s', sustainA !== sustainB,
      'pump stalled — lastChunk unchanged over 1.5 s (BufferSink starvation)');

// Check for uncaught JS exceptions during both sessions.
const allErrors = [...tab1.errors, ...tab2.errors].filter(
    e => !/wad-cache|IndexedDB|idb/i.test(e),
);
check('no uncaught JS exceptions in either session', allErrors.length === 0, allErrors.join('; '));

tab2.close();
summary('insecure origin: IDB WAD cache hit, an unserved WAD pruned, BufferSink music fallback confirmed (no synthetic forcing)',
        { min: 15 });
process.exit();
