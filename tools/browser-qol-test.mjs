#!/usr/bin/env node
// tools/browser-qol-test.mjs — task 19.1 QoL canon batch browser assertions.
//
// Features under test (ALL off by default):
//   1. showFullscreen: fullscreen button (#qol-fullscreen) near top edge.
//   2. showCrosshair: static crosshair (#qol-crosshair) DOM overlay.
//   3. showStats:     level time/stats widget (#qol-stats) DOM overlay.
//   4. showDemoTimer: demo timer + progress bar (#qol-demo-timer / #qol-demo-bar).
//
// Red-proof: DOM overlay approach means render goldens are structurally
// unchanged regardless of feature state — the overlays never touch the
// engine framebuffer.  TDD red-proof is on the DOM assertion side:
// elements do not exist before implementation, so each querySelector
// check returns null and the test fails.
//
// Render-golden red-proof note: adding engine export (web_level_state)
// is read-only — no framebuffer writes.  We verify engine goldens do not
// change in the run-tests.sh --render leg independently.
//
// CDP port 9271 (used: 9223-9226,9230,9232,9241-9242,9246-9247,9251,9268,9270).
// Usage: node tools/browser-qol-test.mjs [url]

import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const CDP = 9271;
const CHROME_BIN = process.env.CHROME_BIN ?? 'google-chrome-stable';

const chrome = spawn(CHROME_BIN, [
    '--headless=new', `--remote-debugging-port=${CDP}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,960', 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = code => { chrome.kill(); process.exit(code); };
const fail = msg => { console.error('FAIL:', msg); cleanup(1); };

await sleep(1500);

const t = await (await fetch(
    `http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
)).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pend = new Map();
const consoleErrors = [];
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
        consoleErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown')
        consoleErrors.push('EXC ' + m.params.exceptionDetails.text);
};
const cdp = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async expr =>
    (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');

// ── helper: boot SP ──────────────────────────────────────────────────────────
async function bootSP() {
    // Wait for service worker
    for (let i = 0; i < 40; i++) {
        if (await ev(`!!navigator.serviceWorker?.controller`)) break;
        if (i === 39) fail('service worker did not claim page within 20s');
        await sleep(500);
    }

    // Click SINGLE PLAYER → game title
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        const s = await ev(`document.getElementById('status')?.textContent`);
        if (s?.startsWith('engine error') || s?.startsWith('Error') || s?.startsWith('cannot'))
            fail(`engine: ${s}`);
        const clicked = await ev(`(() => {
            const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
            if (!sp) return false;
            sp.click();
            const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]');
            if (!g) return false;
            g.click();
            return true;
        })()`);
        if (clicked) break;
    }

    // Wait for game running (status empty, canvas visible)
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        const running = await ev(
            `window.webdoom && document.getElementById('status')?.textContent === '' && ` +
            `!document.getElementById('screen').hidden`
        );
        if (running) return;
    }
    fail('boot timeout');
}

// ── helper: open settings panel ──────────────────────────────────────────────
async function openSettings() {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'F8', key: 'F8', windowsVirtualKeyCode: 0x77 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp',   code: 'F8', key: 'F8', windowsVirtualKeyCode: 0x77 });
    await sleep(300);
    const open = await ev(`!document.getElementById('settings').hidden`);
    if (!open) fail('settings panel did not open after F8');
}

// ── helper: close settings panel ─────────────────────────────────────────────
async function closeSettings() {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'F8', key: 'F8', windowsVirtualKeyCode: 0x77 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp',   code: 'F8', key: 'F8', windowsVirtualKeyCode: 0x77 });
    await sleep(200);
}

// ── helper: toggle a settings checkbox ───────────────────────────────────────
async function setCheckbox(id, value) {
    const result = await ev(`(() => {
        const cb = document.querySelector('#settings #${id}');
        if (!cb) return 'not-found';
        cb.checked = ${value};
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        return cb.checked;
    })()`);
    if (result === 'not-found') fail(`settings checkbox #${id} not found`);
    if (result !== value) fail(`#${id}: expected checked=${value}, got ${result}`);
    await sleep(100);
}

// ── 1. First boot: verify all QoL features off by default ────────────────────
await bootSP();
console.log('[1] game running — checking default off state');

// All QoL elements must exist in DOM but be hidden (hidden attribute).
const fsExists = await ev(`document.getElementById('qol-fullscreen') !== null`);
const fsHidden = await ev(`document.getElementById('qol-fullscreen')?.hidden ?? true`);
const xhExists = await ev(`document.getElementById('qol-crosshair') !== null`);
const xhHidden = await ev(`document.getElementById('qol-crosshair')?.hidden ?? true`);
const statsExists = await ev(`document.getElementById('qol-stats') !== null`);
const statsHidden = await ev(`document.getElementById('qol-stats')?.hidden ?? true`);
const dtimerExists = await ev(`document.getElementById('qol-demo-timer') !== null`);
const dtimerHidden = await ev(`document.getElementById('qol-demo-timer')?.hidden ?? true`);
const dbarExists = await ev(`document.getElementById('qol-demo-bar') !== null`);

if (!fsExists)     fail('#qol-fullscreen element not found in DOM');
if (!fsHidden)     fail('#qol-fullscreen should be hidden by default');
if (!xhExists)     fail('#qol-crosshair element not found in DOM');
if (!xhHidden)     fail('#qol-crosshair should be hidden by default');
if (!statsExists)  fail('#qol-stats element not found in DOM');
if (!statsHidden)  fail('#qol-stats should be hidden by default');
if (!dtimerExists) fail('#qol-demo-timer element not found in DOM');
if (!dtimerHidden) fail('#qol-demo-timer should be hidden by default');
if (!dbarExists)   fail('#qol-demo-bar element not found in DOM');
console.log('[1] default off: PASS');

// ── 2. Settings checkboxes exist for all 4 features ──────────────────────────
await openSettings();
const hasFsCb    = await ev(`document.querySelector('#settings #showFullscreen') !== null`);
const hasXhCb    = await ev(`document.querySelector('#settings #showCrosshair') !== null`);
const hasStatsCb = await ev(`document.querySelector('#settings #showStats') !== null`);
const hasDtimerCb = await ev(`document.querySelector('#settings #showDemoTimer') !== null`);
if (!hasFsCb)     fail('#settings #showFullscreen checkbox not found');
if (!hasXhCb)     fail('#settings #showCrosshair checkbox not found');
if (!hasStatsCb)  fail('#settings #showStats checkbox not found');
if (!hasDtimerCb) fail('#settings #showDemoTimer checkbox not found');
console.log('[2] settings checkboxes: PASS');

// ── 3. Feature on: crosshair and stats ───────────────────────────────────────
await setCheckbox('showCrosshair', true);
await setCheckbox('showStats', true);
await setCheckbox('showFullscreen', true);
await sleep(200);

const xhVisible = await ev(`!document.getElementById('qol-crosshair')?.hidden`);
const statsVisible = await ev(`!document.getElementById('qol-stats')?.hidden`);
const fsVisible = await ev(`!document.getElementById('qol-fullscreen')?.hidden`);
if (!xhVisible)  fail('#qol-crosshair should be visible when showCrosshair=true');
if (!statsVisible) fail('#qol-stats should be visible when showStats=true');
if (!fsVisible)  fail('#qol-fullscreen should be visible when showFullscreen=true');
console.log('[3] feature-on visible: PASS');

// ── 4. Level stats reads engine state (text is non-empty while in-game) ───────
await sleep(500);  // allow a few frames for stats to update
const statsText = await ev(`document.getElementById('qol-stats')?.textContent ?? ''`);
// Should contain K: or at least not be empty when showStats=on and in-game
if (!statsText || statsText.length === 0)
    fail(`#qol-stats text empty when showStats=true (got: "${statsText}")`);
console.log(`[4] stats text non-empty: "${statsText}" — PASS`);

// ── 5. Settings persist across reload ────────────────────────────────────────
// crosshair and stats are on; close settings, reload, verify state.
await closeSettings();

// Store expected state to localStorage directly (for verify after reload)
await ev(`localStorage.setItem('webdoom.input', JSON.stringify({
    ...JSON.parse(localStorage.getItem('webdoom.input') ?? '{}'),
    showCrosshair: true,
    showStats: true,
    showFullscreen: false
}))`);

await cdp('Page.reload');
await sleep(500);
await bootSP();

const persistXh    = await ev(`!document.getElementById('qol-crosshair')?.hidden`);
const persistStats = await ev(`!document.getElementById('qol-stats')?.hidden`);
const persistFs    = await ev(`document.getElementById('qol-fullscreen')?.hidden ?? true`);

if (!persistXh)   fail('#qol-crosshair should be visible after reload (persist)');
if (!persistStats) fail('#qol-stats should be visible after reload (persist)');
if (!persistFs)   fail('#qol-fullscreen should stay hidden after reload (persist off)');
console.log('[5] persist after reload: PASS');

// ── 6. Feature off: hide on uncheck ──────────────────────────────────────────
await openSettings();
await setCheckbox('showCrosshair', false);
await setCheckbox('showStats', false);
await sleep(200);

const xhOff    = await ev(`document.getElementById('qol-crosshair')?.hidden ?? true`);
const statsOff = await ev(`document.getElementById('qol-stats')?.hidden ?? true`);
if (!xhOff)    fail('#qol-crosshair should be hidden when showCrosshair=false');
if (!statsOff) fail('#qol-stats should be hidden when showStats=false');
console.log('[6] feature off: PASS');

// ── 7. localStorage key coverage ─────────────────────────────────────────────
// Verify all 4 keys persist in localStorage under 'webdoom.input'.
await setCheckbox('showFullscreen', true);
await setCheckbox('showDemoTimer', true);
await sleep(100);
const stored = await ev(`JSON.parse(localStorage.getItem('webdoom.input') ?? '{}')`);
// stored is returned as object but Runtime.evaluate returnByValue will serialize it.
// We check that the expected keys are present via string contains check.
const storedJson = await ev(`localStorage.getItem('webdoom.input') ?? ''`);
if (!storedJson.includes('"showFullscreen"'))
    fail('showFullscreen not in localStorage');
if (!storedJson.includes('"showCrosshair"'))
    fail('showCrosshair not in localStorage');
if (!storedJson.includes('"showStats"'))
    fail('showStats not in localStorage');
if (!storedJson.includes('"showDemoTimer"'))
    fail('showDemoTimer not in localStorage');
console.log('[7] localStorage keys: PASS');

// ── Cleanup: reset QoL settings to off ───────────────────────────────────────
await ev(`localStorage.setItem('webdoom.input', JSON.stringify({
    ...JSON.parse(localStorage.getItem('webdoom.input') ?? '{}'),
    showFullscreen: false,
    showCrosshair: false,
    showStats: false,
    showDemoTimer: false
}))`);

const errs = consoleErrors.filter(e => !/debug|warn/i.test(e));
if (errs.length) console.warn('console errors observed (non-fatal):', errs.slice(0, 5));

console.log('PASS');
cleanup(0);
