#!/usr/bin/env node
// End-to-end browser test via Chrome DevTools Protocol (no deps: node's
// built-in WebSocket). Boots the full client against a running server,
// screenshots the title screen, opens the menu with Escape, screenshots
// again. usage: node tools/browser-test.mjs [url] [outdir]
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
    (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');

// wait for boot: status element empties when the game is running
let booted = false;
for (let i = 0; i < 40; i++) {
    await sleep(500);
    const s = await evaluate(`document.getElementById('status')?.textContent`);
    if (s === '') { booted = true; break; }
    if (s?.startsWith('engine error') || s?.startsWith('Error')) {
        console.error(`FAIL: ${s}`); cleanup(1);
    }
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

if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 5));
if (png1 === png2) { console.error('FAIL: Escape did not open the menu — input dead'); cleanup(1); }
if (png2 === png3) { console.error('FAIL: game did not start from menu'); cleanup(1); }
if (png3 === png4) { console.error('FAIL: player did not move'); cleanup(1); }
if (!audioArmed) { console.error('FAIL: audio never armed after key input'); cleanup(1); }
if (consoleErrors.some(e => /worklet|audio/i.test(e))) { console.error('FAIL: audio errors'); cleanup(1); }
console.log(`PASS — title/menu/e1m1/moved screenshots in ${outdir}`);
cleanup(0);
