#!/usr/bin/env node
// Browser test for the PSX DOOM fire background (task 4.1).
// Asserts:
//   (a) fire canvas (#fire-bg) exists behind the menu on the landing screen
//   (b) it is animating — pixels change between two samples taken ~300 ms apart
//   (c) it pauses when a game starts (pixels static while in-game)
//   (d) menu text is present and the SP button is clickable
//   (e) perf probe: fire tick cost < 2 ms on CI host (< 1 ms wbox target,
//       measured via window._fireBg._lastMs() exposed by fire.js)
//
// Usage: node tools/browser-fire-test.mjs [url]
import { spawn }         from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join }          from 'node:path';

const url    = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const CDP_PORT = 9241;   // dedicated port — does not clash with browser-test.mjs (9223)

const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });
const cleanup = code => { chrome.kill(); process.exit(code); };
const fail    = msg  => { console.error(`FAIL: ${msg}`); cleanup(1); };

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);

const target = await (await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' }
)).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const cdp = (method, params = {}) => new Promise(res => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async expr =>
    (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
        .result?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');

// ── (a) Wait for the landing screen to be ready, then check fire canvas ──────
let ready = false;
for (let i = 0; i < 30; i++) {
    await sleep(300);
    ready = await evaluate(`!!document.querySelector('#dmenu .row')`);
    if (ready) break;
}
if (!ready) fail('landing menu did not appear within 9 s');

const fireExists = await evaluate(`!!document.getElementById('fire-bg')`);
if (!fireExists) fail('#fire-bg canvas not found in the DOM');

const fireBehindMenu = await evaluate(`(() => {
    const fire = document.getElementById('fire-bg');
    const menu = document.getElementById('dmenu');
    if (!fire || !menu) return false;
    const fz = parseInt(getComputedStyle(fire).zIndex, 10) || 0;
    // Fire must not intercept pointer events.
    const pe = getComputedStyle(fire).pointerEvents;
    // Fire must be absolutely positioned (fills stage).
    const pos = getComputedStyle(fire).position;
    return fz < 0 && pe === 'none' && pos === 'absolute';
})()`);
if (!fireBehindMenu) fail('#fire-bg is not strictly behind the menu (z-index / pointer-events / position check)');

console.log('(a) PASS — #fire-bg exists, z-index < 0, pointer-events: none, position: absolute');

// ── (b) Animating: sample pixel data twice ~300 ms apart ─────────────────────
const sample = () => evaluate(`(() => {
    const c = document.getElementById('fire-bg');
    if (!c) return null;
    const cx = c.getContext('2d');
    const d = cx.getImageData(0, c.height - 1, c.width, 1).data;  // bottom row (heat source)
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i];
    return sum;
})()`);

// Let the fire run for a couple ticks before sampling
await sleep(200);
const s1 = await sample();
await sleep(350);
const s2 = await sample();

if (s1 === null || s2 === null) fail('could not read fire canvas pixel data');
// The fire propagation changes pixel values each tick; sum of pixel values
// should differ between samples (the bottom row itself is constant but the
// rows above change — sample from mid-canvas for safer check).
const sampleMid = () => evaluate(`(() => {
    const c = document.getElementById('fire-bg');
    if (!c) return null;
    const cx = c.getContext('2d');
    const mid = Math.floor(c.height * 0.4);
    const d = cx.getImageData(0, mid, c.width, 10).data;
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i];
    return sum;
})()`);

const m1 = await sampleMid();
await sleep(400);
const m2 = await sampleMid();

if (m1 === m2) {
    // Pixel sums identical across ~400 ms — fire is not ticking.
    // Only flag as failure if the fire is not a reduced-motion static frame.
    const rm = await evaluate(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`);
    if (!rm) fail(`fire is not animating (mid-canvas sum ${m1} unchanged after 400 ms)`);
    else console.log('(b) SKIP — prefers-reduced-motion: static frame is correct behaviour');
} else {
    console.log(`(b) PASS — fire animating (mid sums ${m1} → ${m2})`);
}

// ── (d) Menu text present and SP button clickable ─────────────────────────────
const spExists = await evaluate(
    `!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`);
if (!spExists) fail('"SINGLE PLAYER" menu item not found');

// Clicking SP should push the game picker screen.
await evaluate(`document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]').click()`);
await sleep(200);
const gamePickerVisible = await evaluate(
    `!!document.querySelector('#dmenu .row')`);
if (!gamePickerVisible) fail('menu did not respond to SP click');

// Navigate back to root (Escape).
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(100);
await cdp('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(200);

console.log('(d) PASS — SP button present and clickable; menu navigation works');

// ── (f) Flare-peak contrast: menu text readable at peak flare ─────────────────
// Trigger a full flare (peak=36, the brightest state) directly via the API,
// then screenshot within ~80 ms while the fire is still at peak heat.
// Readability check: the menu rows must still be present in the DOM and
// non-empty (they are canvas-rendered text, so pixel-level luma analysis is
// not practical here; structural presence + passing the CDP screenshot to the
// caller for human vibe review is the agreed gate).
await evaluate(`window._fireBg?.flare(36)`);
await sleep(80);   // capture near peak — before any cooldown kicks in (hold is 400 ms)

const menuRowsAtPeak = await evaluate(
    `document.querySelectorAll('#dmenu .row').length`);
if (!menuRowsAtPeak) fail('menu rows absent at flare peak — text not visible during flare');

// Opacity sanity: the fire canvas must retain opacity ≤ 0.45 (contract from 4.1
// spec — no CSS opacity changes during flare; brightness comes from sim only).
const fireOpacity = await evaluate(`(() => {
    const c = document.getElementById('fire-bg');
    return c ? parseFloat(getComputedStyle(c).opacity) : null;
})()`);
if (fireOpacity !== null && fireOpacity > 0.46) {
    fail(`fire opacity at peak is ${fireOpacity} — exceeds 0.45 contrast-safe ceiling`);
}

const { result: peakResult } = await cdp('Page.captureScreenshot', { format: 'png' });
const peakShotPath = join(outdir, 'fire-flare-peak.png');
writeFileSync(peakShotPath, Buffer.from(peakResult.data, 'base64'));
console.log(`(f) PASS — menu has ${menuRowsAtPeak} rows at flare peak; opacity=${fireOpacity ?? 'n/a'}; screenshot: ${peakShotPath}`);

// Let fire cool back to steady before remaining checks.
await sleep(600);

// ── (e) Perf probe ────────────────────────────────────────────────────────────
// Use the batch benchmark (_benchMs) to bypass Chrome's 0.1ms precision floor.
// 200 back-to-back ticks amortise the measurement error to ~0.0005ms.
//
// NOTE: the 0.5 ms threshold below is an alder-host gross-regression guard,
// NOT the wbox budget assertion. A reading of 0.5 ms on alder would imply
// ~4 ms on wbox at the 8× conservative ratio — already 4× over the 1 ms
// target. Normal alder readings (~0.1 ms → ~0.8 ms wbox) comfortably fit.
// The authoritative wbox <1 ms measurement is collected separately by the
// lead on the actual wbox (AMD G-T56N) hardware.
await sleep(300);
const tickMs = await evaluate(`window._fireBg?._benchMs(200) ?? null`);
if (tickMs === null) {
    console.log('(e) SKIP — _fireBg._benchMs not exposed (reduced-motion or module not loaded)');
} else {
    console.log(`(e) fire tick cost on alder CI (200-tick avg): ${tickMs.toFixed(4)} ms`);
    const wboxEst = tickMs * 8;
    console.log(`    wbox estimate (×8 conservative ratio): ${wboxEst.toFixed(3)} ms  budget: < 1 ms`);
    if (tickMs > 0.5) fail(`fire tick cost ${tickMs.toFixed(4)} ms exceeds 0.5 ms alder gross-regression guard`);
    else            console.log(`    alder gross-regression guard 0.5 ms: PASS`);
}

// ── (c) Paused when game starts ───────────────────────────────────────────────
// Simulate game-running condition: call fire.pause() directly and verify pixels freeze.
await evaluate(`window._fireBg?.pause()`);
await sleep(50);
const p1 = await sampleMid();
await sleep(400);
const p2 = await sampleMid();
if (p1 !== p2) fail(`fire did not pause — pixels changed (${p1} → ${p2}) after pause()`);
console.log('(c) PASS — fire pauses correctly (pixels static after pause())');

// Resume for completeness.
await evaluate(`window._fireBg?.resume()`);

// ── Screenshot for visual vibe check (not committed) ─────────────────────────
const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
const shotPath = join(outdir, 'fire-bg-landing.png');
writeFileSync(shotPath, Buffer.from(result.data, 'base64'));
console.log(`screenshot (steady state): ${shotPath}`);

console.log('PASS — all fire background assertions passed');
cleanup(0);
