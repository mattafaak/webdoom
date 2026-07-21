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
// Note: this test is NOT wired into run-tests.sh — that is task 16.5's job.
//
// Usage: node tools/browser-insecure-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSECURE_PORT = 8674;
const insecureUrl = `http://insecure.test:${INSECURE_PORT}/`;
const CDP_PORT = 9246;

// A fixed user-data-dir shared across both sessions: IDB survives between
// tab opens within the same Chrome instance (same profile = same IDB origin).
const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-insecure-test-'));

// Track /wads/ server hits per session via LOG_REQUESTS stderr output.
const wadHits = { s1: 0, s2: 0 };
let activeSession = 0;

let server = null;
const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960',
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
tabCheck.close();

// ── Session 1: boot SP — WAD must come from network ───────────────────────────
console.log('[1] Session 1: boot SP on insecure origin...');
activeSession = 1;
const tab1 = await openTab(insecureUrl);
await waitForMenu(tab1, 'tab1 (session 1)');

// Assert degraded-mode status message is visible.
const degradedMsg = await tab1.ev(`document.getElementById('status')?.textContent`);
if (!degradedMsg?.includes('insecure origin')) {
    console.error(`FAIL: degraded-mode status not shown (got: "${degradedMsg}")`);
    cleanup(1);
}
console.log(`  degraded-mode status: "${degradedMsg}"`);

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

// Confirm degraded-mode status still shown.
const degradedMsg2 = await tab2.ev(`document.getElementById('status')?.textContent`);
if (!degradedMsg2?.includes('insecure origin')) {
    console.error(`FAIL: session 2 degraded-mode status not shown (got: "${degradedMsg2}")`);
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

// Check for uncaught JS exceptions during both sessions.
const allErrors = [...tab1.errors, ...tab2.errors].filter(
    e => !/wad-cache|IndexedDB|idb/i.test(e),
);
if (allErrors.length > 0) {
    console.error(`FAIL: uncaught JS exceptions: ${allErrors.join('; ')}`);
    cleanup(1);
}

tab2.close();
console.log('PASS — session 2 booted SP with zero /wads/ server hits; WAD served from IDB on insecure origin');
cleanup(0);
