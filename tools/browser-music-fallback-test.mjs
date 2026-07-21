#!/usr/bin/env node
// Browser test: music fallback sink for insecure origins (task 16.4).
//
// Overrides AudioContext.prototype.audioWorklet to undefined via Runtime.evaluate
// BEFORE sending the arm gesture (arm() only runs on user-gesture events, so the
// override is injected safely between page-load and first keydown).
//
// Asserts:
//   (i)   doomAudio.sinkKind() === 'buffer'  (fallback sink activated)
//   (ii)  doomAudio.lastChunk() has non-zero RMS  (OPL engine rendered audio)
//   (iii) #status text contains 'compatibility mode'  (user-visible notice)
//
// RED-PROOF: against unfixed audio.js the catch block swallows the TypeError
// silently, pumpTimer never starts, lastChunk()/sinkKind() do not exist →
// assertions (i)-(iii) all fail.
//
// usage: node tools/browser-music-fallback-test.mjs [url] [outdir]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const CDP_PORT = 9241;

// Resolve Chrome binary: CHROME_BIN env > /opt/google/chrome/chrome (container) >
// google-chrome-stable (system PATH).  Use --disable-gpu (not --use-angle=swiftshader)
// which is required in container/sandbox environments to avoid GPU process crashes.
const CHROME_BIN =
    process.env.CHROME_BIN ??
    (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome-stable');

const chrome = spawn(CHROME_BIN, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });
const cleanup = code => { chrome.kill(); process.exit(code); };

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);

// Open a target pointing directly at the game URL (same pattern as browser-test.mjs).
const target = await (await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }
)).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
        consoleErrors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown')
        consoleErrors.push(msg.params.exceptionDetails.text);
};
const cdp = (method, params = {}) => new Promise(res => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async expr =>
    (await cdp('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    })).result?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');

// Wait for the service worker to activate and claim this page (same as browser-test.mjs).
for (let i = 0; i < 30; i++) {
    const controlled = await evaluate(`!!navigator.serviceWorker.controller`);
    if (controlled) break;
    if (i === 29) {
        console.error('FAIL: service worker did not take control within 15s');
        cleanup(1);
    }
    await sleep(500);
}

// Inject the audioWorklet override NOW — before any arm() gesture.
// arm() only runs on keydown/mousedown/touchstart, so the page has loaded
// but no AudioContext exists yet.  This simulates an insecure origin where
// the browser provides no audioWorklet property.
await evaluate(`
    Object.defineProperty(AudioContext.prototype, 'audioWorklet', {
        get: () => undefined,
        configurable: true,
    });
`);

// Boot into single player (same menu navigation as browser-test.mjs).
let booted = false;
let clicked = false;
for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = await evaluate(`document.getElementById('status')?.textContent`);
    if (s?.startsWith('engine error') || s?.startsWith('Error') || s?.startsWith('cannot')) {
        console.error(`FAIL: ${s}`); cleanup(1);
    }
    if (!clicked) {
        clicked = await evaluate(`(() => {
            const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
            if (!sp) return false;
            sp.click();
            const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]');
            if (!g) return false;
            g.click();
            return true;
        })()`);
        continue;
    }
    const running = await evaluate(
        `document.getElementById('status')?.textContent === '' &&
         !document.getElementById('screen').hidden`);
    if (running) { booted = true; break; }
}
if (!booted) {
    console.error('FAIL: boot timeout');
    console.error('  status:', await evaluate(`document.getElementById('status')?.textContent`));
    console.error('  errors:', consoleErrors.slice(0, 5));
    cleanup(1);
}

const key = async (code, wkey, vk, holdMs = 60) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code, key: wkey, windowsVirtualKeyCode: vk });
    await sleep(holdMs);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', code, key: wkey, windowsVirtualKeyCode: vk });
    await sleep(60);
};

// Navigate to E1M1 so the music sequencer is running before arm().
await key('Escape', 'Escape', 27);
await sleep(400);
for (let i = 0; i < 3; i++) { await key('Enter', 'Enter', 13); await sleep(400); }
await sleep(2500); // melt wipe + level start; OPL sequencer now playing E1M1 music

// Arm the audio context via a real CDP-synthesized user gesture.
// keydown on 'w' triggers arm() → ctx.audioWorklet is undefined → TypeError
// → catch → BufferSink path → pump starts.
await key('KeyW', 'w', 87, 120);
await sleep(500); // allow arm() async completion + pump() first tick

// Give the pump a full cycle (PUMP_MS = 100ms) plus buffer margin.
await sleep(250);

// ── Assertion (i): sinkKind === 'buffer' ─────────────────────────────────
const sinkKind = await evaluate(`window.doomAudio?.sinkKind()`);
if (sinkKind !== 'buffer') {
    console.error(`FAIL (i): expected sinkKind 'buffer', got '${String(sinkKind)}'`);
    console.error('  audio armed:', await evaluate(`window.doomAudio?.armed()`));
    console.error('  doomAudio keys:', await evaluate(
        `window.doomAudio ? Object.keys(window.doomAudio).join(',') : 'null'`));
    console.error('  console errors:', consoleErrors.slice(0, 5));
    cleanup(1);
}

// ── Assertion (ii): non-zero RMS from last chunk ──────────────────────────
const rmsVal = await evaluate(`(() => {
    const chunk = window.doomAudio?.lastChunk();
    if (!chunk || !chunk.length) return -1;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    return Math.sqrt(sum / chunk.length);
})()`);
if (rmsVal === null || rmsVal === undefined || rmsVal < 0) {
    console.error(`FAIL (ii): lastChunk() returned null/empty — pump did not run (got ${rmsVal})`);
    cleanup(1);
}
if (rmsVal < 0.0005) {
    console.error(`FAIL (ii): non-zero RMS expected, got ${Number(rmsVal).toFixed(6)} — OPL silent`);
    cleanup(1);
}

// ── Assertion (iii): user-visible status message ──────────────────────────
const statusText = await evaluate(`document.getElementById('status')?.textContent`);
if (!statusText?.includes('compatibility mode')) {
    console.error(`FAIL (iii): expected status to include 'compatibility mode', got '${String(statusText)}'`);
    cleanup(1);
}

console.log(`sink: ${sinkKind}  rms: ${Number(rmsVal).toFixed(5)}  status: "${statusText}"`);
if (consoleErrors.length) console.log('console errors (non-fatal):', consoleErrors.slice(0, 3));
console.log('PASS — music fallback sink: buffer, frames non-zero, status visible');
cleanup(0);
