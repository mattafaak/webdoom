#!/usr/bin/env node
// Insecure-origin WAD cache gate (ws-014).
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
// Session 1: boot SP → WAD downloaded from network (server logs /wads/ hit).
// Session 2: fresh tab, same Chrome profile (same IDB) → WAD served from IDB;
//            server receives ZERO /wads/ requests.
//
// RED-PROOF: stash the wad-cache.js + main.js changes and run — session 2
// will re-download the WAD (wadHits.s2 > 0) and the assertion fails.
//
// Wired into run-tests.sh as the insecure-origin CI leg (task 16.5).
//
// Usage: node tools/browser-insecure-test.mjs
import { join } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
import { startServer } from './lib/server.mjs';
import { sleep } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

// the server logs each request; the test counts /wads/ hits per session
const wadHits = { s1: 0, s2: 0 };
let activeSession = 0;
const srv = await startServer({ env: { LOG_REQUESTS: '1' }, onStderr: chunk => {
    for (const line of chunk.split('\n'))
        if (line.includes('/wads/')) { if (activeSession === 1) wadHits.s1++; else if (activeSession === 2) wadHits.s2++; }
} });
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
        const running = await tab.ev(
            `!document.getElementById('screen').hidden &&
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
tab1.close();

// Brief pause to let IDB write settle (wadCachePut is fire-and-forget async).
await sleep(2000);

// ── Session 2: fresh tab, same IDB — WAD must NOT hit network ────────────────
console.log('[2] Session 2: fresh tab, same profile — IDB must serve WAD...');
activeSession = 2;
const tab2 = await openTab(insecureUrl);
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
console.log(`  session 2: ${wadHits.s2} /wads/ server request(s) — WAD served from IDB cache`);

// Confirm IDB has the WAD stored.
const idbHasWad = await tab2.ev(`
    (async () => {
        try {
            const db = await new Promise((res, rej) => {
                const r = indexedDB.open('webdoom-wads', 1);
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
            return keys.length > 0;
        } catch (e) { return false; }
    })()
`);
check('the IDB webdoom-wads store holds the WAD', idbHasWad,
      'the store is empty after session 2 (wad was not persisted in session 1)');
console.log('  IDB webdoom-wads store has entries — WAD cached in IndexedDB');

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
// arm() is async; pump() runs every PUMP_MS=100ms.  Wait for at least one
// full pump cycle plus arm() async completion margin.
await sleep(700);

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
summary('insecure origin: IDB WAD cache hit + BufferSink music fallback confirmed (no synthetic forcing)');
process.exit();
