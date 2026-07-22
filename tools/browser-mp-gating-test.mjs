#!/usr/bin/env node
// Browser test for task 16.6b: MP gating — local WADs must not appear in MP picker.
//
// Tests covered:
//   (1) SP picker includes local WAD (local WADs are valid for SP play).
//   (2) MP CHOOSE GAME picker excludes local WAD (MP requires server library).
//   (3) Red-proof: with filter temporarily disabled, local WAD IS visible in MP
//       picker — verifying the filter is load-bearing, not accidental.
//
// Requires window.__testInjectManifest (test hook exposed by lobby.js).
//
// RED-PROOF (documented):
//   Without the serverGames() filter (i.e. using sortedGames() in gamePick()),
//   the local WAD appears in the MP CHOOSE GAME picker.  Test (3) below confirms
//   this by removing the filter in-page and asserting the WAD IS present — then
//   restoring the filter and asserting it is absent.
//
// usage: node tools/browser-mp-gating-test.mjs [url]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root     = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:8688/';
const CDP_PORT = 9268;
const DOOM_PORT = 8688;

const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-mpgate-'));

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

async function waitForMenu(tab, label = 'tab', timeoutSecs = 30) {
    for (let i = 0; i < timeoutSecs * 2; i++) {
        const ready = await tab.ev(
            `!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`,
        );
        if (ready) return;
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        if (s?.startsWith('cannot') || s?.startsWith('engine error')) {
            console.error(`FAIL: ${label}: error while waiting for menu: "${s}"`);
            cleanup(1);
        }
        await sleep(500);
    }
    console.error(`FAIL: ${label}: lobby menu did not appear within ${timeoutSecs}s`);
    cleanup(1);
}

async function clickItem(tab, text, retries = 15) {
    for (let i = 0; i < retries; i++) {
        const ok = await tab.ev(
            `(() => { const r = document.querySelector('#dmenu .row[data-label*=${JSON.stringify(text)}]');
                      return r ? (r.click(), true) : false; })()`,
        );
        if (ok) return true;
        await sleep(300);
    }
    return false;
}

async function pressEsc(tab) {
    await tab.cdp('Input.dispatchKeyEvent', {
        type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27,
    });
    await tab.cdp('Input.dispatchKeyEvent', {
        type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27,
    });
}

// ── Session ───────────────────────────────────────────────────────────────────
const tab = await openTab(BASE_URL);
await waitForMenu(tab, 'tab');

// Verify that the test hook is available (lobby.js must expose it).
const hasHook = await tab.ev(`typeof window.__testInjectManifest === 'function'`);
if (!hasHook) {
    console.error('FAIL: window.__testInjectManifest not found — lobby.js test hook missing');
    cleanup(1);
}

// ── Inject a fake local WAD entry into the in-memory manifest ─────────────────
// This simulates a user having imported a WAD in a previous session that was
// loaded from IDB on startup.  We inject directly rather than going through
// IDB/import to keep the test hermetic and fast.
const LOCAL_WAD = {
    file: 'localmod.wad',
    title: 'LOCAL-MOD-TEST',
    kind: 'PWAD',
    sha256: 'deadbeef'.repeat(8),
    size: 28,
    local: true,
    base: 'doom2.wad',
    maps: ['MAP01'],
};
await tab.ev(`window.__testInjectManifest(${JSON.stringify(LOCAL_WAD)})`);
console.log('Injected local WAD: localmod.wad (local:true)');

// ── Test 1: SP picker includes local WAD ─────────────────────────────────────
console.log('\n[1] SP picker should include local WAD...');
const spResult = await tab.ev(`
    (() => {
        const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
        if (!sp) return 'no SP row';
        sp.click();
        // SP picks from sortedGames() which includes local:true
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const found = rows.some(r => r.dataset.label?.includes('LOCAL-MOD-TEST'));
        return found ? 'found' : 'not found in: [' + rows.map(r => r.dataset.label).join(', ') + ']';
    })()
`);
if (spResult !== 'found') {
    console.error(`FAIL: local WAD should appear in SP picker: ${spResult}`);
    cleanup(1);
}
console.log('  ok  local WAD present in SP CHOOSE GAME picker');

// Return to root
await pressEsc(tab);
await sleep(300);

// ── Test 2: MP CHOOSE GAME picker excludes local WAD ─────────────────────────
// Open MULTIPLAYER → lobby connects → START GAME row appears →
// click GAME: row → CHOOSE GAME picker (gamePick()) → verify LOCAL-MOD-TEST absent.
console.log('\n[2] MP CHOOSE GAME picker should exclude local WAD...');

// Enter lobby
let inLobby = false;
for (let attempt = 0; attempt < 3 && !inLobby; attempt++) {
    if (!await clickItem(tab, 'MULTIPLAYER', 10)) {
        console.error('FAIL: MULTIPLAYER row not found');
        cleanup(1);
    }
    for (let i = 0; i < 20; i++) {
        if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
            { inLobby = true; break; }
        await sleep(300);
    }
    if (!inLobby) { await pressEsc(tab); await sleep(400); }
}
if (!inLobby) {
    console.error('FAIL: MP lobby (START GAME row) did not appear');
    cleanup(1);
}

// Click GAME: to open gamePick()
if (!await clickItem(tab, 'GAME:', 10)) {
    console.error('FAIL: GAME: row not found in lobby');
    cleanup(1);
}
await sleep(300);

// Check MP CHOOSE GAME screen: local WAD must be absent
const mpResult = await tab.ev(`
    (() => {
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const hasLocal = rows.some(r => r.dataset.label?.includes('LOCAL-MOD-TEST'));
        const allLabels = rows.map(r => r.dataset.label).join(', ');
        return JSON.stringify({ hasLocal, allLabels });
    })()
`);
const mpData = JSON.parse(mpResult);
if (mpData.hasLocal) {
    console.error(`FAIL: local WAD should NOT appear in MP CHOOSE GAME picker`);
    console.error(`  present rows: ${mpData.allLabels}`);
    cleanup(1);
}
console.log('  ok  local WAD absent from MP CHOOSE GAME picker');
console.log(`  MP game list: [${mpData.allLabels}]`);

// Return to root
await pressEsc(tab);
await sleep(200);
await pressEsc(tab);
await sleep(400);

// ── Test 3: Red-proof — verify filter is load-bearing ────────────────────────
// Temporarily patch serverGames (via test hook) to bypass the local filter,
// then verify LOCAL-MOD-TEST DOES appear (RED state). Restore → absent (GREEN).
console.log('\n[3] Red-proof: disable filter → local WAD appears in MP picker...');

const hasFilterHook = await tab.ev(`typeof window.__testSetServerGamesFilter === 'function'`);
if (!hasFilterHook) {
    console.error('FAIL: window.__testSetServerGamesFilter not found — lobby.js filter hook missing');
    cleanup(1);
}

// Disable filter (bypass local exclusion)
await tab.ev(`window.__testSetServerGamesFilter(false)`);

// Re-enter MP lobby
inLobby = false;
for (let attempt = 0; attempt < 3 && !inLobby; attempt++) {
    if (!await clickItem(tab, 'MULTIPLAYER', 10)) {
        console.error('FAIL: MULTIPLAYER not found for red-proof');
        cleanup(1);
    }
    for (let i = 0; i < 20; i++) {
        if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
            { inLobby = true; break; }
        await sleep(300);
    }
    if (!inLobby) { await pressEsc(tab); await sleep(400); }
}
if (!inLobby) {
    console.error('FAIL: MP lobby did not appear for red-proof');
    cleanup(1);
}

if (!await clickItem(tab, 'GAME:', 10)) {
    console.error('FAIL: GAME: row not found for red-proof');
    cleanup(1);
}
await sleep(300);

const redResult = await tab.ev(`
    (() => {
        const rows = [...document.querySelectorAll('#dmenu .row')];
        return rows.some(r => r.dataset.label?.includes('LOCAL-MOD-TEST'));
    })()
`);
if (!redResult) {
    console.error('FAIL: red-proof failed — local WAD did not appear even with filter disabled');
    console.error('  (this means the WAD injection or the filter hook is not working)');
    cleanup(1);
}
console.log('  ok  RED: with filter disabled, local WAD IS present in MP picker (expected FAIL state)');

// Restore filter
await pressEsc(tab);
await sleep(200);
await pressEsc(tab);
await sleep(400);

await tab.ev(`window.__testSetServerGamesFilter(true)`);

// Re-verify: filter restored → local WAD absent again
inLobby = false;
for (let attempt = 0; attempt < 3 && !inLobby; attempt++) {
    if (!await clickItem(tab, 'MULTIPLAYER', 10)) {
        console.error('FAIL: MULTIPLAYER not found after restoring filter');
        cleanup(1);
    }
    for (let i = 0; i < 20; i++) {
        if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
            { inLobby = true; break; }
        await sleep(300);
    }
    if (!inLobby) { await pressEsc(tab); await sleep(400); }
}
if (!inLobby) {
    console.error('FAIL: MP lobby did not appear after restoring filter');
    cleanup(1);
}

if (!await clickItem(tab, 'GAME:', 10)) {
    console.error('FAIL: GAME: row not found after restoring filter');
    cleanup(1);
}
await sleep(300);

const greenResult = await tab.ev(`
    (() => {
        const rows = [...document.querySelectorAll('#dmenu .row')];
        return rows.some(r => r.dataset.label?.includes('LOCAL-MOD-TEST'));
    })()
`);
if (greenResult) {
    console.error('FAIL: GREEN re-check failed — local WAD still present after restoring filter');
    cleanup(1);
}
console.log('  ok  GREEN: with filter restored, local WAD absent from MP picker');

// ── Final uncaught-exception sweep ────────────────────────────────────────────
const finalErrors = tab.errors.filter(e =>
    !e.includes('storage.persist') && !e.includes('IndexedDB'),
);
if (finalErrors.length > 0) {
    console.error(`FAIL: uncaught JS exceptions: ${finalErrors.join('; ')}`);
    cleanup(1);
}

tab.close();
console.log('\nPASS — SP includes local WAD, MP excludes it; red-proof confirms filter is load-bearing');
cleanup(0);
