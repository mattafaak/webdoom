#!/usr/bin/env node
// tools/browser-wide-toggle-test.mjs — end-to-end wide-mode toggle + persist test.
//
// task 18.3 / wide-fix: verifies dynamic canvas/texture sizing, aspect-bucket
// selection, and localStorage persistence of the wideMode setting.
//
// Chrome launched at 1280×720 (16:9) so wideBucket() returns 426.
// Tests:
//   1. Default state: canvas.width == 320, web_screenwidth() == 320.
//   2. Toggle-on: open settings (F8), click wide mode checkbox.
//      After the next rAF frame: canvas.width == 426, web_screenwidth() == 426.
//   3. Toggle-off: uncheck wide mode.
//      After the next rAF frame: canvas.width == 320, web_screenwidth() == 320.
//   4. Persist: toggle wide on, reload page.
//      After reload + boot: canvas.width == 426, web_screenwidth() == 426.
//
// Red-proof:  Steps 2 (wide on) and 3 (toggle-off → 320) are captured in the
// same run, proving pre-existing behaviour (320) is restored when wide is off.
// Window at 1280×720 = 16:9: wideBucket() == 426 (threshold: aspect > 1.55).
//
// Usage: node tools/browser-wide-toggle-test.mjs [url]
//   url defaults to http://127.0.0.1:8666/

import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const CDP = 9270;
const CHROME_BIN = process.env.CHROME_BIN ?? 'google-chrome-stable';

// 1280×720 = 16:9 aspect → wideBucket() returns 426.
// (1280/720 = 1.78 which is > 1.55 and ≤ 2.0 → bucket 426)
const WIDE_BUCKET = 426; // expected render width for 16:9 display
const chrome = spawn(CHROME_BIN, [
    '--headless=new', `--remote-debugging-port=${CDP}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720', 'about:blank',
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

// ── 1. First boot: default state ─────────────────────────────────────────────
await bootSP();

const defaultCanvasW = await ev(`document.getElementById('screen').width`);
const defaultScreenW = await ev(`window.webdoom.doom._web_screenwidth()`);
console.log(`[1] default: canvas.width=${defaultCanvasW} web_screenwidth=${defaultScreenW}`);
if (defaultCanvasW !== 320) fail(`expected canvas.width=320 by default, got ${defaultCanvasW}`);
if (defaultScreenW !== 320) fail(`expected web_screenwidth=320 by default, got ${defaultScreenW}`);

// ── 2. Toggle wide mode ON via settings ──────────────────────────────────────
// Open settings panel (F8), click wide mode checkbox.
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'F8', key: 'F8', windowsVirtualKeyCode: 0x77 });
await cdp('Input.dispatchKeyEvent', { type: 'keyUp',   code: 'F8', key: 'F8', windowsVirtualKeyCode: 0x77 });
await sleep(300);

const settingsOpen = await ev(`!document.getElementById('settings').hidden`);
if (!settingsOpen) fail('settings panel did not open after F8');

// Check the wideMode checkbox.
const wideCbChecked = await ev(`(() => {
    const cb = document.querySelector('#settings #wideMode');
    if (!cb) return 'not-found';
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return cb.checked;
})()`);
if (wideCbChecked !== true) fail(`could not check #wideMode checkbox (got: ${wideCbChecked})`);

// Wait 2 rAF frames for the deferred resize to propagate.
await sleep(200);

const wideCanvasW = await ev(`document.getElementById('screen').width`);
const wideScreenW = await ev(`window.webdoom.doom._web_screenwidth()`);
const wideHasClass = await ev(`document.getElementById('screen').classList.contains('wide')`);
console.log(`[2] wide on: canvas.width=${wideCanvasW} web_screenwidth=${wideScreenW} .wide=${wideHasClass}`);
if (wideCanvasW !== WIDE_BUCKET) fail(`expected canvas.width=${WIDE_BUCKET} after wide toggle (16:9 bucket), got ${wideCanvasW}`);
if (wideScreenW !== WIDE_BUCKET) fail(`expected web_screenwidth=${WIDE_BUCKET} after wide toggle (16:9 bucket), got ${wideScreenW}`);
if (!wideHasClass) fail('canvas should have .wide class when wide mode is active');

// ── 3. Toggle wide mode OFF — red-proof of pre-existing 320 behaviour ────────
const narrowCbChecked = await ev(`(() => {
    const cb = document.querySelector('#settings #wideMode');
    if (!cb) return 'not-found';
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return cb.checked;
})()`);
if (narrowCbChecked !== false) fail(`could not uncheck #wideMode checkbox (got: ${narrowCbChecked})`);

await sleep(200);

const narrowCanvasW = await ev(`document.getElementById('screen').width`);
const narrowScreenW = await ev(`window.webdoom.doom._web_screenwidth()`);
const narrowHasClass = await ev(`document.getElementById('screen').classList.contains('wide')`);
console.log(`[3] wide off: canvas.width=${narrowCanvasW} web_screenwidth=${narrowScreenW} .wide=${narrowHasClass}`);
if (narrowCanvasW !== 320)
    fail(`expected canvas.width=320 after toggle-off (pre-existing), got ${narrowCanvasW}`);
if (narrowScreenW !== 320)
    fail(`expected web_screenwidth=320 after toggle-off (pre-existing), got ${narrowScreenW}`);
if (narrowHasClass)
    fail('.wide class should be removed when wide mode is off');

// ── 4. Persistence: toggle wide on, reload, assert state survives ─────────────
// Re-enable wide via the checkbox.
await ev(`(() => {
    const cb = document.querySelector('#settings #wideMode');
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
})()`);
await sleep(100);

// Close settings then reload.
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'F8', key: 'F8', windowsVirtualKeyCode: 0x77 });
await cdp('Input.dispatchKeyEvent', { type: 'keyUp',   code: 'F8', key: 'F8', windowsVirtualKeyCode: 0x77 });

// Reload and wait for the new page.
await cdp('Page.reload');
await sleep(500);

await bootSP();

const persistCanvasW = await ev(`document.getElementById('screen').width`);
const persistScreenW = await ev(`window.webdoom.doom._web_screenwidth()`);
console.log(`[4] persist after reload: canvas.width=${persistCanvasW} web_screenwidth=${persistScreenW}`);
if (persistCanvasW !== WIDE_BUCKET)
    fail(`expected canvas.width=${WIDE_BUCKET} after reload (persist, 16:9 bucket), got ${persistCanvasW}`);
if (persistScreenW !== WIDE_BUCKET)
    fail(`expected web_screenwidth=${WIDE_BUCKET} after reload (persist, 16:9 bucket), got ${persistScreenW}`);

// Clean up: reset wide mode setting so the browser leaves no persistent state.
await ev(`localStorage.setItem('webdoom.input', JSON.stringify({
    ...JSON.parse(localStorage.getItem('webdoom.input') ?? '{}'),
    wideMode: false
}))`);

const errs = consoleErrors.filter(e => !/debug|warn/i.test(e));
if (errs.length) console.warn('console errors observed (non-fatal):', errs.slice(0, 5));

console.log('PASS');
cleanup(0);
