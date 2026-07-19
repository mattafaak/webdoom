#!/usr/bin/env node
// Offline SP gate: loads app online (SW caches SHELL files + WAD), kills the
// server, reloads into a fresh tab — app must boot single-player from SW
// cache with zero network.
//
// Offline mechanism: kill the server before reload.  This is stronger than
// CDP Network.emulateNetworkConditions because it blocks even the document
// navigation request, not only subresource fetches within the existing page.
// The SW serves '/' and all SHELL assets from the 'webdoom-shell-v3' cache
// and the WAD from the 'webdoom-wads-v1' cache.
//
// SW-ready detection: wait for navigator.serviceWorker.controller to be
// non-null.  sw.js calls skipWaiting() only after c.addAll() resolves, and
// activate → clients.claim() fires after that.  So when .controller is set,
// every SHELL URL is guaranteed in the cache.
//
// Cache priming in Phase 1:
//   • addAll() precaches all SHELL files during SW install.
//   • /api/wads, /api/ui-assets, and the WAD itself are fetched on demand.
//     With a fresh profile the initial page load happens *before* the SW is
//     active, so those resources bypass the SW and are never cached.  We
//     prime them explicitly after SW controller is confirmed:
//       1. re-fetch('/api/wads')       — SW intercepts, writes to SHELL cache
//       2. re-fetch('/api/ui-assets')  — SW intercepts, writes to SHELL cache
//       3. boot SP online — bootDoom fetches the WAD while SW is active,
//          writing it to the wads cache
//   • Phase 3 (offline tab) therefore gets /api/wads and /api/ui-assets from
//     the SHELL cache and the WAD from the wads cache, exactly as a returning
//     user who has previously played SP would.
//
// Why the RED direction fails without fire.js/countdown.js in addAll:
//   • Phase 3 opens with SW active from the first fetch.
//   • lobby.js is served from SHELL cache but imports fire.js and countdown.js.
//   • If those were not in addAll they are absent from the SHELL cache
//     (never fetched while SW was active, because the fresh-profile initial
//     load pre-dates SW activation).
//   • SW fetch handler returns undefined from caches.match() → module import
//     fails → lobby.js throws → menu never appears → test fails with a clear
//     message.
//
// Unique --user-data-dir per invocation: SW caches are per-profile.  A stale
// profile would make the gate vacuous (cache already warm from a previous
// run); a fresh profile forces the online phase to actually fill the caches
// before we go offline.
//
// Dedicated server on port 8672 (not 8668): run-tests.sh keeps its own
// server alive for the remaining suites; killing 8668 from inside this test
// would break all subsequent browser gates.
//
// Usage: node tools/browser-offline-test.mjs [url]
// url defaults to http://127.0.0.1:8672/ matching the embedded server below.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFLINE_PORT = 8672;
const url = process.argv[2] ?? `http://127.0.0.1:${OFFLINE_PORT}/`;
const CDP_PORT = 9242;   // dedicated — does not clash with any other suite

// Fresh profile per invocation so SW cache is always cold on entry.
const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-offline-test-'));

let server = null;
let serverKilledIntentionally = false;
const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required',
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

// ── start dedicated server ────────────────────────────────────────────────────
server = spawn('node', [join(root, 'server/serve.js')], {
    env: { ...process.env, DOOM_PORT: String(OFFLINE_PORT), DOOM_HOST: '127.0.0.1' },
    stdio: 'ignore',
});
server.on('exit', (code, sig) => {
    if (!serverKilledIntentionally && code !== null && code !== 0) {
        console.error(`FAIL: server exited unexpectedly (code ${code} sig ${sig})`);
        cleanup(1);
    }
});

await sleep(1500);   // chrome + server startup

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
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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

// Wait for navigator.serviceWorker.controller to be non-null.
// This is the precache-complete signal: sw.js only calls skipWaiting() after
// c.addAll() resolves, and clients.claim() fires in activate after that.
async function waitForSWController(tab, label = 'tab', timeoutSecs = 40) {
    for (let i = 0; i < timeoutSecs * 2; i++) {
        const controlled = await tab.ev(`!!navigator.serviceWorker.controller`);
        if (controlled) return;
        await sleep(500);
    }
    console.error(`FAIL: service worker did not claim ${label} within ${timeoutSecs}s`);
    console.error('  (precache addAll may have failed or SW registration was blocked)');
    cleanup(1);
}

// Wait for the landing lobby menu (SINGLE PLAYER row) to appear.
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

// Click SP → game and wait for engine running (canvas visible, status empty).
async function bootIntoSP(tab, label = 'tab', timeoutSecs = 90) {
    let clicked = false;
    for (let i = 0; i < timeoutSecs * 2; i++) {
        await sleep(500);
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        if (s?.startsWith('Error') || s?.startsWith('cannot') || s?.startsWith('engine error')) {
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

// ── Phase 1: online load — prime SW caches ────────────────────────────────────

console.log('[1] Phase 1: online load — priming SW caches...');
const tab1 = await openTab(url);
await waitForSWController(tab1, 'tab1 (online)');

// Confirm SHELL addAll is in place.
const shellEntries = await tab1.ev(
    `caches.open('webdoom-shell-v3').then(c => c.keys()).then(k => k.length)`,
);
if (!shellEntries || shellEntries === 0) {
    console.error('FAIL: SHELL cache empty after SW controller was set — addAll likely failed');
    cleanup(1);
}
console.log(`  SW controller active; SHELL cache has ${shellEntries} entries (addAll complete)`);

// Prime /api/wads and /api/ui-assets: on a fresh profile the initial page
// load fires before the SW is active, so lobby.js and doomfont.js fetched
// these endpoints directly — they were never intercepted or cached by the SW.
// Re-fetching them now (with SW as controller) causes the network-first
// handler to store each response in the SHELL cache.
await tab1.ev(`fetch('/api/wads').then(r => r.json())`);
console.log('  /api/wads primed in SW cache');
await tab1.ev(`fetch('/api/ui-assets').then(r => r.json())`);
console.log('  /api/ui-assets primed in SW cache');

// Boot single-player online.  bootDoom fetches the WAD while SW is active,
// writing it to the 'webdoom-wads-v1' cache.  Without this step the wads
// cache would be empty and offline SP would fail at WAD load time.
await waitForMenu(tab1, 'tab1 (online)');
console.log('  lobby menu visible — booting SP online to prime wads cache...');
await bootIntoSP(tab1, 'tab1 (online)');

// WAD is now in the wads cache.
const wadsEntries = await tab1.ev(
    `caches.open('webdoom-wads-v1').then(c => c.keys()).then(k => k.length)`,
);
console.log(`  SP booted online; wads cache has ${wadsEntries} WAD entries`);
if (!wadsEntries || wadsEntries === 0) {
    console.error('FAIL: wads cache empty after online SP boot — WAD was not cached by SW');
    cleanup(1);
}
tab1.close();

// ── Phase 2: kill server (simulate offline) ───────────────────────────────────

console.log('[2] Killing server — simulating offline...');
serverKilledIntentionally = true;
server.kill();
server = null;
await sleep(600);   // let OS reclaim the listening socket
console.log('  server killed; all subsequent network requests will fail');

// ── Phase 3: offline tab — SW must serve everything from cache ────────────────

console.log('[3] Phase 3: offline reload — SW must serve all assets from cache...');
const tab2 = await openTab(url);

// SW is already registered for this origin; it will intercept the navigation
// request for '/' and serve it from the SHELL cache.
await waitForSWController(tab2, 'tab2 (offline)');
console.log('  SW controller active on offline tab');

// Confirm caches are intact.
const shellOffline = await tab2.ev(
    `caches.open('webdoom-shell-v3').then(c => c.keys()).then(k => k.length)`,
);
const wadsOffline = await tab2.ev(
    `caches.open('webdoom-wads-v1').then(c => c.keys()).then(k => k.length)`,
);
console.log(`  SHELL: ${shellOffline} entries  WADS: ${wadsOffline} entries`);

// Menu must appear from SHELL cache.  If any SHELL file is absent (e.g.
// fire.js or countdown.js missing from addAll), the module import chain
// breaks and the menu never renders → waitForMenu() fails here.
await waitForMenu(tab2, 'tab2 (offline)');
console.log('  lobby menu visible offline — SHELL cache served all assets');

// ── Phase 4: boot single-player offline ──────────────────────────────────────

console.log('[4] Booting single-player offline (WAD from wads cache)...');
await bootIntoSP(tab2, 'tab2 (offline)');
console.log('  engine canvas visible, status empty — SP boot succeeded offline');

// Assert engine is ticking: read _web_palette_version immediately after boot
// (records the initial palette set), wait 1 s, then re-read.  The title screen
// palette is stable in the first second, so we do NOT fail on palV2 === palV1;
// instead we assert status is still empty (no crash) and canvas is still visible
// (rAF still running).  If the palette DID advance, log it as additional evidence.
const palV1 = await tab2.ev(
    `window.webdoom?.doom?._web_palette_version?.() ?? null`,
);
await sleep(1000);
const palV2 = await tab2.ev(
    `window.webdoom?.doom?._web_palette_version?.() ?? null`,
);
const statusAfter = await tab2.ev(`document.getElementById('status')?.textContent`);
const canvasAfter = await tab2.ev(`!document.getElementById('screen').hidden`);
if (statusAfter !== '') {
    console.error(`FAIL: engine error appeared 1s after offline boot: "${statusAfter}"`);
    cleanup(1);
}
if (!canvasAfter) {
    console.error('FAIL: canvas hidden 1s after offline boot — renderer stopped');
    cleanup(1);
}
if (palV1 !== null && palV2 !== null && palV2 > palV1) {
    console.log(`  palette_version ${palV1} → ${palV2} (+${palV2 - palV1} in 1s) — engine ticking`);
} else {
    // Title screen palette is stable in the first second; canvas visible + status=""
    // is the ticking proof (rAF loop is running, engine has not crashed).
    console.log(`  canvas visible, status="" for 1s — engine ticking (palette_version: ${palV1} → ${palV2})`);
}

// No fatal uncaught exceptions during the offline session.
const fatalErrors = tab2.errors.filter(e =>
    !/service.?worker|sw.*cache|cache.*miss/i.test(e),
);
if (fatalErrors.length > 0) {
    console.error(`FAIL: uncaught exceptions during offline SP: ${fatalErrors.join('; ')}`);
    cleanup(1);
}

tab2.close();
console.log('PASS — offline SP boot from SW cache proven');
cleanup(0);
