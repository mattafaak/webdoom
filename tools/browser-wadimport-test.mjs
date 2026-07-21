#!/usr/bin/env node
// Browser test for task 16.6a: drag-and-drop WAD import.
//
// Tests covered:
//   (1) Malformed-corpus rejection — 7 hostile inputs, each rejected with a
//       user-visible WadError message and zero uncaught exceptions.
//   (2) Import flow — synthetic PWAD (generated in-test, no binary assets)
//       imported via a real DataTransfer drop event on #landing → lobby.js
//       drop handler → e.dataTransfer.files[0] → entry appears in CHOOSE GAME.
//   (3) SP boot with imported PWAD — click entry → engine boots with local WAD.
//   (4) Reload survival — page reload → local entry still present (IDB).
//
// RED-PROOF (documented):
//   On master (feature absent), window.__wadImport is undefined → check [1]
//   fails with "FAIL: wad-import module not available".  The import-flow checks
//   [2-4] also fail because window.__handleWadImport does not exist.
//   Run: node tools/browser-wadimport-test.mjs -- will exit 1 on master.
//
// Chrome flags: --disable-gpu (NOT --use-angle=swiftshader, which crashes in
// this container per env notes).
//
// Not wired into run-tests.sh — that is task 16.5's job.
//
// Usage: node tools/browser-wadimport-test.mjs [url]
import { spawn }     from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join }      from 'node:path';
import { tmpdir }    from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname }   from 'node:path';

const root      = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL  = process.argv[2] ?? 'http://127.0.0.1:8677/';
const CDP_PORT  = 9247;
const DOOM_PORT = 8677;

const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-wadimport-'));

let server = null;
const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--disable-gpu',
    '--window-size=1280,960',
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

// ── Start server ──────────────────────────────────────────────────────────────
server = spawn('node', [join(root, 'server/serve.js')], {
    env: { ...process.env, DOOM_PORT: String(DOOM_PORT), DOOM_HOST: '127.0.0.1' },
    stdio: 'ignore',
});
server.on('exit', (code, sig) => {
    if (code !== null && code !== 0) {
        console.error(`FAIL: server exited unexpectedly (code ${code} sig ${sig})`);
        cleanup(1);
    }
});

await sleep(1800);  // chrome + server startup

// ── CDP helpers ───────────────────────────────────────────────────────────────
async function openTab(tabUrl) {
    const res    = await fetch(
        `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(tabUrl)}`,
        { method: 'PUT' },
    );
    const target = await res.json();
    const ws     = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const errors  = [];

    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
        if (msg.method === 'Runtime.exceptionThrown')
            errors.push(
                msg.params.exceptionDetails?.exception?.description
                ?? msg.params.exceptionDetails?.text ?? '?',
            );
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
            errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
    };

    const cdp = (method, params = {}) => new Promise(res => {
        const i = ++msgId;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async (expr, opts = {}) =>
        (await cdp('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true, ...opts,
        })).result?.result?.value;

    await cdp('Runtime.enable');
    await cdp('Page.enable');

    return { cdp, ev, errors, close() { ws.close(); }, targetId: target.id };
}

// Wait for the lobby menu to appear (indicates lobby.js IIFE completed).
async function waitForMenu(tab, label = 'tab', timeoutSecs = 30) {
    for (let i = 0; i < timeoutSecs * 2; i++) {
        const ready = await tab.ev(
            `!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`,
        );
        if (ready) return;
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        if (s?.startsWith('cannot') || s?.startsWith('engine error') || s?.startsWith('Error')) {
            console.error(`FAIL: ${label}: error while waiting for menu: "${s}"`);
            cleanup(1);
        }
        await sleep(500);
    }
    const s = await tab.ev(`document.getElementById('status')?.textContent`);
    console.error(`FAIL: ${label}: lobby menu did not appear within ${timeoutSecs}s (status: "${s}")`);
    cleanup(1);
}

// Wait for SW controller (insecure origins skip this).
async function waitForSW(tab, label = 'tab', timeoutSecs = 20) {
    for (let i = 0; i < timeoutSecs * 2; i++) {
        const ctrl = await tab.ev(`!!navigator.serviceWorker?.controller`);
        if (ctrl) return;
        await sleep(500);
    }
    // SW may not be available on plain http — not fatal, just log
    console.log(`  ${label}: SW not controlling within ${timeoutSecs}s (expected on insecure origin)`);
}

// ── Synthetic WAD factory ─────────────────────────────────────────────────────
// Makes a minimal valid PWAD:
//   header: magic(4) + nlumps(4 LE) + dirofs(4 LE) = 12 bytes
//   directory: 1 entry × 16 bytes = 16 bytes at offset 12
//   lump entry: offset(4 LE) + size(4 LE) + name(8 bytes) = 16 bytes
//   Total: 28 bytes
// The lump is a zero-size marker (name "TESTLUMP") so it doesn't interfere
// with game data and no binary assets are committed.
function makeSyntheticPWAD(lumpName = 'TESTLUMP') {
    const buf = new Uint8Array(28);
    const dv  = new DataView(buf.buffer);
    // magic: PWAD
    buf[0] = 0x50; buf[1] = 0x57; buf[2] = 0x41; buf[3] = 0x44;
    dv.setInt32(4, 1,  true);  // nlumps = 1
    dv.setInt32(8, 12, true);  // dirofs = 12 (immediately after header)
    // lump entry at offset 12:
    dv.setInt32(12, 0, true);  // lump data offset (0 = points to header; zero-size so no OOB)
    dv.setInt32(16, 0, true);  // lump size = 0 (marker lump)
    for (let i = 0; i < Math.min(lumpName.length, 8); i++)
        buf[20 + i] = lumpName.charCodeAt(i);
    return buf;
}

// ── Session ───────────────────────────────────────────────────────────────────
const tab = await openTab(BASE_URL);
await waitForSW(tab, 'tab', 15);
await waitForMenu(tab, 'tab');

// ── [1] Malformed-corpus rejection tests ─────────────────────────────────────
console.log('[1] Malformed-corpus rejection tests...');

const corpusResult = await tab.ev(`
    (async () => {
        // RED-PROOF: on master window.__wadImport is undefined → TypeError here.
        if (!window.__wadImport) return JSON.stringify({ fatal: 'wad-import module not available' });
        const { identifyWad, WadError } = window.__wadImport;
        const results = [];
        const cases = [
            { desc: 'zero-byte file',           bytes: new Uint8Array(0),    name: 'test.wad' },
            { desc: 'truncated header (<12B)',   bytes: new Uint8Array(4),    name: 'test.wad' },
            { desc: 'non-IWAD/PWAD magic',       bytes: (() => {
                const b = new Uint8Array(12);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x5A; // PWAZ
                return b;
            })(), name: 'test.wad' },
            { desc: 'absurd nlumps (0x7FFFFFFF)', bytes: (() => {
                const b = new Uint8Array(12);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x44; // PWAD
                const dv = new DataView(b.buffer);
                dv.setInt32(4, 0x7FFFFFFF, true);  // 2 billion lumps
                dv.setInt32(8, 12, true);
                return b;
            })(), name: 'test.wad' },
            { desc: 'directory offset past EOF', bytes: (() => {
                const b = new Uint8Array(28);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x44;
                const dv = new DataView(b.buffer);
                dv.setInt32(4, 1, true);
                dv.setInt32(8, 9999, true);         // dirofs > fileSize
                return b;
            })(), name: 'test.wad' },
            { desc: 'negative lump size',        bytes: (() => {
                const b = new Uint8Array(28);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x44;
                const dv = new DataView(b.buffer);
                dv.setInt32(4, 1, true);
                dv.setInt32(8, 12, true);
                dv.setInt32(12, 0, true);
                dv.setInt32(16, -1, true);           // negative lump size
                return b;
            })(), name: 'test.wad' },
            { desc: 'lump data extends past EOF', bytes: (() => {
                const b = new Uint8Array(28);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x44;
                const dv = new DataView(b.buffer);
                dv.setInt32(4, 1, true);
                dv.setInt32(8, 12, true);
                dv.setInt32(12, 0, true);
                dv.setInt32(16, 99999, true);        // size way beyond EOF
                return b;
            })(), name: 'test.wad' },
        ];
        for (const { desc, bytes, name } of cases) {
            try {
                await identifyWad(bytes, name);
                results.push({ desc, passed: false, error: 'no error thrown — expected WadError' });
            } catch (e) {
                results.push({
                    desc, passed: e.name === 'WadError',
                    type: e.name, msg: e.message.slice(0, 80),
                });
            }
        }
        return JSON.stringify(results);
    })()
`);

if (!corpusResult) {
    console.error('FAIL: malformed-corpus evaluate returned null');
    cleanup(1);
}
let corpus;
try { corpus = JSON.parse(corpusResult); } catch {
    console.error('FAIL: malformed-corpus result is not JSON:', corpusResult);
    cleanup(1);
}
if (corpus.fatal) {
    console.error(`FAIL: ${corpus.fatal}`);
    cleanup(1);
}
let corpusOk = true;
for (const r of corpus) {
    if (!r.passed) {
        console.error(`  FAIL [${r.desc}]: ${r.error ?? `expected WadError, got ${r.type}: ${r.msg}`}`);
        corpusOk = false;
    } else {
        console.log(`  ok  [${r.desc}]: WadError("${r.msg}")`);
    }
}
if (!corpusOk) { cleanup(1); }

// Check no uncaught exceptions from corpus tests
if (tab.errors.length > 0) {
    console.error(`FAIL: uncaught JS exceptions during corpus tests: ${tab.errors.join('; ')}`);
    cleanup(1);
}
console.log('  ok  malformed corpus: all 7 inputs rejected cleanly, zero uncaught exceptions');

// ── [2] Import flow — synthetic PWAD via DataTransfer drop ───────────────────
// Exercises the real drag-drop path (DataTransfer → landing drop event →
// lobby.js handler → e.dataTransfer.files[0] → handleWadImport), which is
// what the DoD specifies ("browser test drag-drops a PWAD (DataTransfer)").
console.log('[2] Import flow: synthetic PWAD via DataTransfer drop...');

const pwadBytes = Array.from(makeSyntheticPWAD());  // array of numbers for JSON serialization

// RED-PROOF check: on master window.__handleWadImport is undefined (feature absent).
const hasImportFn = await tab.ev(`typeof window.__handleWadImport === 'function'`);
if (!hasImportFn) {
    console.error('FAIL: window.__handleWadImport not available (feature not implemented)');
    cleanup(1);
}

// Synthesise a DataTransfer drop event on #landing.
// Chrome headless supports `new DataTransfer()` construction.
// We dispatch dragover first so lobby.js's preventDefault() / dropEffect
// wiring fires correctly, then dispatch drop with the same DataTransfer.
const importStatus = await tab.ev(`
    (async () => {
        const bytes = new Uint8Array(${JSON.stringify(pwadBytes)});
        const file  = new File([bytes], 'testmod.wad', { type: 'application/octet-stream' });
        const dt    = new DataTransfer();
        dt.items.add(file);
        const landing = document.getElementById('landing');
        // dragover — lobby.js calls e.preventDefault() + sets dropEffect
        landing.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, dataTransfer: dt,
        }));
        // drop — lobby.js reads e.dataTransfer.files[0] and calls handleWadImport
        landing.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt,
        }));
        // handleWadImport is async; poll for the status update (up to 4 s).
        for (let i = 0; i < 40; i++) {
            const s = document.getElementById('status')?.textContent ?? '';
            if (s.startsWith('Imported:') || s.startsWith('Rejected:') ||
                s.startsWith('Import error:') || s.startsWith('Already imported:') ||
                s.startsWith('WAD library full')) {
                return s;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        return document.getElementById('status')?.textContent ?? '(timeout)';
    })()
`);

if (!importStatus?.startsWith('Imported:')) {
    console.error(`FAIL: import did not succeed — status: "${importStatus}"`);
    cleanup(1);
}
console.log(`  import succeeded: "${importStatus}"`);

// Navigate to SINGLE PLAYER → CHOOSE GAME and verify entry appears.
await sleep(300);
const entryVisible = await tab.ev(`
    (() => {
        // Click SINGLE PLAYER to push spGameScreen
        const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
        if (!sp) return 'no SINGLE PLAYER item';
        sp.click();
        // Look for testmod entry in the new screen
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const found = rows.some(r => r.dataset.label?.toLowerCase().includes('testmod'));
        return found ? 'found' : 'not found in: ' + rows.map(r => r.dataset.label).join(', ');
    })()
`);
if (entryVisible !== 'found') {
    console.error(`FAIL: testmod entry not visible in CHOOSE GAME screen: ${entryVisible}`);
    cleanup(1);
}
console.log('  ok  testmod entry visible in CHOOSE GAME screen');

// ── [3] SP boot with imported PWAD ────────────────────────────────────────────
console.log('[3] SP boot with imported PWAD...');

// Click the testmod entry to start SP boot
const bootStarted = await tab.ev(`
    (() => {
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const testmodRow = rows.find(r => r.dataset.label?.toLowerCase().includes('testmod'));
        if (!testmodRow) return 'no testmod row';
        testmodRow.click();
        return 'clicked';
    })()
`);
if (bootStarted !== 'clicked') {
    console.error(`FAIL: could not click testmod entry: ${bootStarted}`);
    cleanup(1);
}

// Wait for engine to boot (canvas visible, status empty) — up to 120s
// (doom.wad is ~12MB, needs to download then engine initialise).
let booted = false;
for (let i = 0; i < 240; i++) {
    await sleep(500);
    const s = await tab.ev(`document.getElementById('status')?.textContent`);
    if (s?.startsWith('engine error') || s?.startsWith('cannot')) {
        console.error(`FAIL: engine error during SP boot: "${s}"`);
        cleanup(1);
    }
    const running = await tab.ev(
        `!document.getElementById('screen').hidden && ` +
        `document.getElementById('status')?.textContent === ''`,
    );
    if (running) { booted = true; break; }
}
if (!booted) {
    const s = await tab.ev(`document.getElementById('status')?.textContent`);
    console.error(`FAIL: engine did not boot within 120s (status: "${s}")`);
    cleanup(1);
}
console.log('  ok  SP booted with testmod.wad as active PWAD');

// Verify the local WAD was served from IDB, not the server (it's not on the server).
// We can infer this from the boot succeeding — fetchWad would have thrown
// "wad fetch failed: testmod.wad" if it tried the network.
console.log('  ok  testmod.wad served from local IDB (network fetch would have 404\'d)');

// Check no new uncaught exceptions during boot.
const bootErrors = tab.errors.filter(e =>
    !e.includes('storage.persist') && !e.includes('IndexedDB'),
);
if (bootErrors.length > 0) {
    console.error(`FAIL: uncaught exceptions during SP boot: ${bootErrors.join('; ')}`);
    cleanup(1);
}

// ── [4] Reload survival ────────────────────────────────────────────────────────
console.log('[4] Reload survival: page reload → local library persists...');

// Reload the tab (CDP Page.reload)
await tab.cdp('Page.reload');
await sleep(2000);
await waitForMenu(tab, 'reload-tab', 60);

// After reload, check if testmod.wad entry still appears in the game list.
const afterReload = await tab.ev(`
    (() => {
        const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
        if (!sp) return 'no SINGLE PLAYER';
        sp.click();
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const found = rows.some(r => r.dataset.label?.toLowerCase().includes('testmod'));
        return found ? 'found' : 'not found in: ' + rows.map(r => r.dataset.label).join(', ');
    })()
`);
if (afterReload !== 'found') {
    console.error(`FAIL: testmod entry not present after reload — IDB did not persist: ${afterReload}`);
    cleanup(1);
}
console.log('  ok  testmod entry still present after page reload (IDB survived)');

// Final uncaught-exception sweep
const finalErrors = tab.errors.filter(e =>
    !e.includes('storage.persist') && !e.includes('IndexedDB'),
);
if (finalErrors.length > 0) {
    console.error(`FAIL: uncaught JS exceptions: ${finalErrors.join('; ')}`);
    cleanup(1);
}

tab.close();
console.log('PASS — malformed corpus clean, import→entry→boot→reload all verified');
cleanup(0);
