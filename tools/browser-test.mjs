#!/usr/bin/env node
// End-to-end browser test via Chrome DevTools Protocol (no deps: node's
// built-in WebSocket). Boots the full client against a running server,
// screenshots the title screen, opens the menu with Escape, screenshots
// again. usage: node tools/browser-test.mjs [url] [outdir]
//
// State-machine edge coverage (docs/state-machine.md):
//   T03 SP-PICK → SP-LOADING  (click game title → bootDoom starts)
//   T04 SP-LOADING → IN-GAME-SP  (bootDoom resolves)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const CDP_PORT = 9223;

const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });
const cleanup = code => { chrome.kill(); process.exit(code); };

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);

const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
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
    (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');

// Wait for the service worker to activate and claim this page.
// sw.js uses skipWaiting()+clients.claim() so this is typically <2s on a
// local server, but the installation (c.addAll of ~14 shell files) is async.
// If we let the boot loop start before the SW is controlling, the WAD fetch
// goes directly to the server and is NOT intercepted/cached by the SW.
for (let i = 0; i < 30; i++) {
    const controlled = await evaluate(`!!navigator.serviceWorker.controller`);
    if (controlled) break;
    if (i === 29) {
        console.error('FAIL: service worker did not take control within 15s');
        cleanup(1);
    }
    await sleep(500);
}

// landing page → click PLAY → wait for the engine to run
// (canvas unhidden + status empty)
let booted = false;
let clicked = false;
for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = await evaluate(`document.getElementById('status')?.textContent`);
    if (s?.startsWith('engine error') || s?.startsWith('Error') || s?.startsWith('cannot')) {
        console.error(`FAIL: ${s}`); cleanup(1);
    }
    if (!clicked) {
        // drill: SINGLE PLAYER → THE ULTIMATE DOOM
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

const shot = async name => {
    const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outdir, name), Buffer.from(result.data, 'base64'));
    return result.data;
};

await sleep(1000);

const key = async (code, wkey, vk, holdMs = 60) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code, key: wkey, windowsVirtualKeyCode: vk });
    await sleep(holdMs);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', code, key: wkey, windowsVirtualKeyCode: vk });
    await sleep(60);
};

const png1 = await shot('webdoom-title.png');

// menu: Escape → New Game → episode 1 → Hurt Me Plenty → E1M1
await key('Escape', 'Escape', 27);
await sleep(400);
const png2 = await shot('webdoom-menu.png');
for (let i = 0; i < 3; i++) { await key('Enter', 'Enter', 13); await sleep(400); }
await sleep(2500);                                   // melt wipe + level start
const png3 = await shot('webdoom-e1m1.png');

await key('KeyW', 'w', 87, 700);                     // walk forward
await sleep(300);
const png4 = await shot('webdoom-e1m1-moved.png');

const audioArmed = await evaluate(`window.doomAudio?.armed()`);
console.log(`audio armed: ${audioArmed}`);

const wadsCached = await evaluate(
    `caches.open('webdoom-wads-v1').then(c => c.keys()).then(k => k.length)`);
console.log(`service worker WAD cache entries: ${wadsCached}`);

if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 5));
if (png1 === png2) { console.error('FAIL: Escape did not open the menu — input dead'); cleanup(1); }
if (png2 === png3) { console.error('FAIL: game did not start from menu'); cleanup(1); }
if (png3 === png4) { console.error('FAIL: player did not move'); cleanup(1); }
if (!audioArmed) { console.error('FAIL: audio never armed after key input'); cleanup(1); }
if (!wadsCached) { console.error('FAIL: service worker cached no WADs'); cleanup(1); }
if (consoleErrors.some(e => /worklet|audio/i.test(e))) { console.error('FAIL: audio errors'); cleanup(1); }
console.log(`PASS — title/menu/e1m1/moved screenshots in ${outdir}`);
cleanup(0);
