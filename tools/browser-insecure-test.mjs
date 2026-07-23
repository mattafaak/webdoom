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
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSECURE_PORT = 8674;
const insecureUrl = `http://insecure.test:${INSECURE_PORT}/`;
const CDP_PORT = 9246;

// Resolve Chrome binary: CHROME_BIN env > /opt/google/chrome/chrome (container) >
// google-chrome-stable (system PATH).  Use --disable-gpu (not --use-angle=swiftshader)
// which is required in container/sandbox environments to avoid GPU process crashes.
const CHROME_BIN =
    process.env.CHROME_BIN ??
    (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome-stable');

// A fixed user-data-dir shared across both sessions: IDB survives between
// tab opens within the same Chrome instance (same profile = same IDB origin).
const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-insecure-test-'));

// Track /wads/ server hits per session via LOG_REQUESTS stderr output.
const wadHits = { s1: 0, s2: 0 };
let activeSession = 0;

let server = null;
const chrome = spawn(CHROME_BIN, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required',
    '--host-resolver-rules=MAP insecure.test 127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
], { stdio: 'ignore' });

const cleanup = code => {
    if (server) { try { server.kill(); } catch (_) {} }
    chrome.kill();
    process.exit(code);
};
process.on('SIGINT',  () => cleanup(1));
process.on('SIGTERM', () => cleanup(1));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── start server with request logging ─────────────────────────────────────────
server = spawn('node', [join(root, 'server/serve.js')], {
    env: {
        ...process.env,
        DOOM_PORT: String(INSECURE_PORT),
        DOOM_HOST: '127.0.0.1',
        LOG_REQUESTS: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
        if (line.includes('/wads/')) {
            if (activeSession === 1) wadHits.s1++;
            else if (activeSession === 2) wadHits.s2++;
        }
    }
});
server.on('exit', (code, sig) => {
    if (code !== null && code !== 0) {
        console.error(`FAIL: server exited unexpectedly (code ${code} sig ${sig})`);
        cleanup(1);
    }
});

await sleep(1500);  // chrome + server startup

// ── CDP helpers ───────────────────────────────────────────────────────────────
async function openTab(tabUrl) {
    const res = await fetch(
        `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(tabUrl)}`,
        { method: 'PUT' },
    );
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const errors = [];

    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
        if (msg.method === 'Runtime.exceptionThrown')
            errors.push(
                msg.params.exceptionDetails?.exception?.description
                ?? msg.params.exceptionDetails?.text
                ?? '?',
            );
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
            errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
    };

    const cdp = (method, params = {}) => new Promise(res => {
        const i = ++msgId;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async expr =>
        (await cdp('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true,
        })).result?.result?.value;

    await cdp('Runtime.enable');
    await cdp('Page.enable');

    return { cdp, ev, errors, close() { ws.close(); } };
}

// Wait for lobby menu (#dmenu .row[data-label="SINGLE PLAYER"]).
async function waitForMenu(tab, label = 'tab', timeoutSecs = 30) {
    for (let i = 0; i < timeoutSecs * 2; i++) {
        const ready = await tab.ev(
            `!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`,
        );
        if (ready) return;
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        if (s?.startsWith('cannot') || s?.startsWith('engine error') || s?.startsWith('Error')) {
            console.error(`FAIL: ${label}: status error while waiting for menu: "${s}"`);
            cleanup(1);
        }
        await sleep(500);
    }
    const s = await tab.ev(`document.getElementById('status')?.textContent`);
    console.error(`FAIL: ${label}: lobby menu did not appear within ${timeoutSecs}s (status: "${s}")`);
    cleanup(1);
}

// Click SP → game and wait for engine canvas + empty status.
async function bootIntoSP(tab, label = 'tab', timeoutSecs = 90) {
    let clicked = false;
    for (let i = 0; i < timeoutSecs * 2; i++) {
        await sleep(500);
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        // Allow the degraded-mode notice in status while waiting for menu click
        if (s?.startsWith('engine error') || s?.startsWith('cannot') || s?.startsWith('Error')) {
            console.error(`FAIL: ${label}: engine error during SP boot: "${s}"`);
            cleanup(1);
        }
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
    console.error(`FAIL: ${label}: engine did not boot within ${timeoutSecs}s (status: "${s}")`);
    cleanup(1);
}

// ── Pre-flight: confirm insecure context ──────────────────────────────────────
console.log('[0] Pre-flight: verifying insecure context...');
const tabCheck = await openTab(insecureUrl);
await sleep(1000);
const swInNav = await tabCheck.ev(`'serviceWorker' in navigator`);
if (swInNav) {
    console.error(
        `FAIL: navigator.serviceWorker exists on ${insecureUrl} — this is NOT an insecure context.` +
        ' Check --host-resolver-rules and Chrome version.',
    );
    cleanup(1);
}
console.log(`  confirmed: navigator.serviceWorker absent on ${insecureUrl} (insecure context)`);

// First-ever load in this fresh profile: the one-shot plain-HTTP notice must
// be visible here (and only here — later sessions assert suppression).
await waitForMenu(tabCheck, 'tabCheck (pre-flight)');
const noticeMsg = await tabCheck.ev(`document.getElementById('status')?.textContent`);
if (!noticeMsg?.includes('cached locally')) {
    console.error(`FAIL: one-shot plain-HTTP notice not shown on first load (got: "${noticeMsg}")`);
    cleanup(1);
}
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
if (degradedMsg?.includes('cached locally')) {
    console.error(`FAIL: plain-HTTP notice reappeared in session 1 — should be one-shot (got: "${degradedMsg}")`);
    cleanup(1);
}
console.log(`  session 1: notice suppressed (status: "${degradedMsg}")`);

await bootIntoSP(tab1, 'tab1 (session 1)');
console.log('  SP booted — checking server WAD hit count...');
// Flush any buffered stderr output.
await sleep(500);
if (wadHits.s1 === 0) {
    console.error('FAIL: session 1 made zero /wads/ server requests — WAD should have been downloaded');
    cleanup(1);
}
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
if (degradedMsg2?.includes('cached locally')) {
    console.error(`FAIL: plain-HTTP notice reappeared in session 2 — should be one-shot (got: "${degradedMsg2}")`);
    cleanup(1);
}

await bootIntoSP(tab2, 'tab2 (session 2)');
// Flush any buffered stderr output.
await sleep(500);

if (wadHits.s2 > 0) {
    console.error(
        `FAIL: session 2 made ${wadHits.s2} /wads/ server request(s) — WAD should have come from IDB.` +
        ' RED-PROOF: on unfixed client session 2 always re-downloads.',
    );
    cleanup(1);
}
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
if (!idbHasWad) {
    console.error('FAIL: IDB webdoom-wads store is empty after session 2 (wad was not persisted in session 1)');
    cleanup(1);
}
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
    console.error(`FAIL: music sink on real insecure origin expected 'buffer', got '${String(musicSinkKind)}'`);
    console.error('  doomAudio armed:', await tab2.ev(`window.doomAudio?.armed()`));
    console.error('  doomAudio keys:', await tab2.ev(
        `window.doomAudio ? Object.keys(window.doomAudio).join(',') : 'null'`));
    cleanup(1);
}

const musicRms = await tab2.ev(`(() => {
    const chunk = window.doomAudio?.lastChunk();
    if (!chunk || !chunk.length) return -1;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    return Math.sqrt(sum / chunk.length);
})()`);
if (musicRms === null || musicRms === undefined || musicRms < 0) {
    console.error(`FAIL: lastChunk() empty on insecure origin — pump did not run (got ${musicRms})`);
    cleanup(1);
}
if (musicRms < 0.0005) {
    console.error(`FAIL: music RMS on insecure origin too low: ${Number(musicRms).toFixed(6)} — OPL silent`);
    cleanup(1);
}

const musicStatus = await tab2.ev(`document.getElementById('status')?.textContent`);
if (!musicStatus?.includes('compatibility mode')) {
    console.error(`FAIL: status should include 'compatibility mode', got '${String(musicStatus)}'`);
    cleanup(1);
}
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
if (sustainA === sustainB) {
    console.error('FAIL: pump stalled — lastChunk unchanged over 1.5 s (BufferSink starvation)');
    cleanup(1);
}
console.log('  sustained playback confirmed: pump still pushing after 1.5 s');
console.log('  real insecure context confirmed: BufferSink active, OPL frames non-zero, status visible');

// Check for uncaught JS exceptions during both sessions.
const allErrors = [...tab1.errors, ...tab2.errors].filter(
    e => !/wad-cache|IndexedDB|idb/i.test(e),
);
if (allErrors.length > 0) {
    console.error(`FAIL: uncaught JS exceptions: ${allErrors.join('; ')}`);
    cleanup(1);
}

tab2.close();
console.log('PASS — insecure origin: IDB WAD cache hit + BufferSink music fallback confirmed (no synthetic forcing)');
cleanup(0);
