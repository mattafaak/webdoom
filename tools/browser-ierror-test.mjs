#!/usr/bin/env node
// Browser test: I_Error / onDoomError recovery (task 12.3 tenet-4 closure).
//
// Verifies that when the engine fires I_Error (onDoomError callback), the page
// recovers gracefully:
//   • landing page is restored (not left on a blank canvas)
//   • a user-visible error message is shown in #status
//   • the game canvas is hidden
//
// Trigger: after the game boots, we call doom.onDoomError() directly via CDP.
// This is the exact JS handler fixed in client/js/main.js — the "call path"
// through Emscripten EM_ASM is equivalent (both call the same function object).
// Running against the real server + real engine is required so the module
// structure and DOM wiring are exercised exactly as in production.
//
// Usage: node tools/browser-ierror-test.mjs [url]
import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const CDP_PORT = 9230;

const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

const cleanup = code => { chrome.kill(); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);

const target = await (await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
)).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const errors = [];
ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown')
        errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '?');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
        errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
};
const cdp = (method, params = {}) => new Promise(res => {
    const i = ++msgId;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async expr =>
    (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');

// ── Wait for service worker ────────────────────────────────────────────────────
for (let i = 0; i < 30; i++) {
    if (await ev(`!!navigator.serviceWorker.controller`)) break;
    if (i === 29) { console.error('FAIL: service worker did not take control within 15s'); cleanup(1); }
    await sleep(500);
}

// ── Wait for lobby menu ────────────────────────────────────────────────────────
let menuReady = false;
for (let i = 0; i < 40; i++) {
    menuReady = await ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`);
    if (menuReady) break;
    const s = await ev(`document.getElementById('status')?.textContent`);
    if (s?.startsWith('cannot')) { console.error(`FAIL: lobby error: ${s}`); cleanup(1); }
    await sleep(500);
}
if (!menuReady) { console.error('FAIL: lobby menu did not appear within 20s'); cleanup(1); }

// ── Boot the game (click SINGLE PLAYER → first available game) ────────────────
let clicked = false;
let booted = false;
for (let i = 0; i < 120; i++) {
    await sleep(500);
    const s = await ev(`document.getElementById('status')?.textContent`);
    // Abort if the engine errors before we trigger our test
    if (s?.startsWith('engine error') || s?.startsWith('Error')) {
        console.error(`FAIL: unexpected engine error before test trigger: ${s}`);
        cleanup(1);
    }
    if (!clicked) {
        clicked = await ev(`(() => {
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
    const running = await ev(
        `!document.getElementById('screen').hidden &&
         document.getElementById('status')?.textContent === ''`);
    if (running) { booted = true; break; }
}
if (!booted) {
    console.error('FAIL: game did not boot within 60s');
    console.error('  status:', await ev(`document.getElementById('status')?.textContent`));
    cleanup(1);
}

// ── Trigger onDoomError — simulates I_Error from engine ───────────────────────
// window.webdoom.doom is the Emscripten Module; onDoomError is the handler
// set in client/js/main.js (the fix under test). Calling it directly exercises
// the same code path that EM_ASM invokes in i_system.c I_Error().
const TEST_MSG = 'no player 1 start in E1M1';
const handlerExists = await ev(`typeof window.webdoom?.doom?.onDoomError === 'function'`);
if (!handlerExists) {
    console.error('FAIL: window.webdoom.doom.onDoomError is not a function — fix not applied or module did not export it');
    cleanup(1);
}

await ev(`window.webdoom.doom.onDoomError(${JSON.stringify(TEST_MSG)})`);
await sleep(300);

// ── Assert recovery ────────────────────────────────────────────────────────────
const landingVisible = await ev(`!document.getElementById('landing').hidden`);
const canvasHidden   = await ev(`document.getElementById('screen').hidden`);
const statusText     = await ev(`document.getElementById('status')?.textContent`);

let failed = false;

if (!landingVisible) {
    console.error('FAIL: landing page not restored after I_Error — user stuck on blank canvas');
    failed = true;
}
if (!canvasHidden) {
    console.error('FAIL: game canvas still visible after I_Error');
    failed = true;
}
if (!statusText?.includes('engine error')) {
    console.error(`FAIL: user-visible error message not shown in #status (got: ${JSON.stringify(statusText)})`);
    failed = true;
}
if (!statusText?.includes(TEST_MSG)) {
    console.error(`FAIL: error message does not contain expected text "${TEST_MSG}" (got: ${JSON.stringify(statusText)})`);
    failed = true;
}

// Unexpected uncaught exceptions (not the abort from I_Error)
const unexpectedErrors = errors.filter(e =>
    !/(abort|RuntimeError|unreachable|onDoomError)/i.test(e));
if (unexpectedErrors.length > 0) {
    console.error(`FAIL: unexpected JS exceptions: ${unexpectedErrors.join('; ')}`);
    failed = true;
}

if (failed) {
    cleanup(1);
}

console.log('PASS — I_Error recovery: landing restored, error message shown, canvas hidden');
cleanup(0);
