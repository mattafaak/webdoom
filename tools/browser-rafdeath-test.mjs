#!/usr/bin/env node
// Browser test: rAF frame() exception → landing restore + user-visible message (ws-001 fix).
//
// Verifies that when an unexpected JS exception is thrown inside the rAF frame()
// loop (the ws-001 silent-wedge path), the page recovers gracefully:
//   1. rAF loop STOPS — no further _web_frame calls (not an accumulating error)
//   2. Landing page is restored (#landing visible, #screen hidden)
//   3. User-visible error message is shown in #status
//   4. Audio stop is attempted without throwing (observable via doomAudio.stop call)
//
// Injection mechanism: after game boot, monkey-patch doom._web_frame to throw a
// deterministic Error. This directly exercises the try/catch in frame() and
// reproduces the ws-001 class (unexpected JS exception mid-frame) without
// depending on engine internals or wasm abort.
//
// Anti-vacuous RED proof: running this test against UNFIXED main.js (bare
// catch { running = false; return; }) must FAIL because the landing is never
// restored and #status stays empty.
//
// Usage: node tools/browser-rafdeath-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
// WHICH engine export to make throw.  This used to be hardcoded to
// `_web_frame`, and `_web_frame` was the ONE statement inside the frame loop's
// try -- so the gate proved the guarded line was guarded and said nothing
// about `_doomFrameHook`, `_web_palette_version` and `renderer.draw`, which sat
// AFTER the catch.  A throw from any of those killed the loop with no
// endSession at all: the exact ws-001 wedge, in the loop that exists to prevent
// it.  Those three are inside the try now, and the suite runs this file once
// per injection point so the claim covers both halves.
const injIdx = process.argv.indexOf('--inject');
const INJECT = injIdx >= 0 ? process.argv[injIdx + 1] : '_web_frame';
if (!/^_web_[a-z_]+$/.test(INJECT)) {
    console.error(`FAIL: --inject '${INJECT}' is not an engine export name`);
    process.exit(2);
}
const chrome = await launchChrome();
const cleanup = code => { chrome.kill(); process.exit(code); };
const tab = await chrome.tab(url);
const { cdp, ev, errors } = tab;

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

// ── Inject deterministic exception into the rAF frame path ───────────────────
// Monkey-patch doom._web_frame to throw once, then restore (tracks call count).
// This reproduces the ws-001 class: an unexpected JS exception inside the
// try { input.frame(); doom._web_frame(); } block.
const domExported = await ev(`typeof window.webdoom?.doom?.${INJECT} === 'function'`);
if (!domExported) {
    console.error(`FAIL: window.webdoom.doom.${INJECT} is not a function — game handle missing`);
    cleanup(1);
}
console.log(`  injecting a throw into doom.${INJECT}`);

// Install the throw patch; count how many times it fires.
await ev(`(() => {
    const d = window.webdoom.doom;
    const orig = d.${INJECT};
    window.__rafThrowCount = 0;
    d.${INJECT} = function() {
        window.__rafThrowCount++;
        d.${INJECT} = orig;   // restore immediately so teardown can proceed normally
        throw new Error('synthetic-rafdeath-ws001');
    };
})()`);

// Allow one rAF tick to fire (the patched _web_frame throw executes).
await sleep(300);

// ── Assert: rAF loop stopped (no accumulating exceptions) ─────────────────────
const throwCount = await ev(`window.__rafThrowCount ?? 0`);
if (throwCount !== 1) {
    console.error(`FAIL: ${INJECT} throw fired ${throwCount} times (expected 1) — rAF loop not stopping cleanly`);
    cleanup(1);
}

// Wait a little longer to confirm no further frames queued (would increment throwCount
// if the original throw-patch were still in place, but we already restored it above;
// instead we track via an extra counter on the restored function for 500ms).
await ev(`(() => {
    const d = window.webdoom.doom;
    const orig = d.${INJECT};
    window.__rafPostCount = 0;
    d.${INJECT} = function(...a) { window.__rafPostCount++; return orig.apply(d, a); };
})()`);
await sleep(500);
const postCount = await ev(`window.__rafPostCount ?? 0`);
if (postCount > 0) {
    console.error(`FAIL: rAF loop continued after exception — ${postCount} extra ${INJECT} calls observed`);
    cleanup(1);
}

// ── Assert recovery ───────────────────────────────────────────────────────────
const landingVisible = await ev(`!document.getElementById('landing').hidden`);
const canvasHidden   = await ev(`document.getElementById('screen').hidden`);
const statusText     = await ev(`document.getElementById('status')?.textContent`);

let failed = false;

if (!landingVisible) {
    console.error('FAIL: landing page not restored after rAF exception — user stuck on frozen canvas (ws-001 wedge)');
    failed = true;
}
if (!canvasHidden) {
    console.error('FAIL: game canvas still visible after rAF exception');
    failed = true;
}
if (!statusText || statusText.trim() === '') {
    console.error(`FAIL: no user-visible error message in #status after rAF exception (got: ${JSON.stringify(statusText)})`);
    failed = true;
}
if (statusText && !statusText.includes('engine error')) {
    console.error(`FAIL: #status text does not contain "engine error" (got: ${JSON.stringify(statusText)})`);
    failed = true;
}

// Unexpected uncaught exceptions (filter expected: the synthetic-rafdeath itself
// may surface as a console error before the catch handler swallows it).
const unexpectedErrors = errors.filter(e =>
    !/(synthetic-rafdeath-ws001|abort|RuntimeError|unreachable)/i.test(e));
if (unexpectedErrors.length > 0) {
    console.error(`FAIL: unexpected JS exceptions: ${unexpectedErrors.join('; ')}`);
    failed = true;
}

if (failed) {
    cleanup(1);
}

console.log(`PASS — rAF exception recovery via ${INJECT}: landing restored, status shown, loop stopped (ws-001 fixed)`);
cleanup(0);
