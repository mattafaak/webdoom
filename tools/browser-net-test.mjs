#!/usr/bin/env node
// Browser multiplayer test through the DOOM-style drill-down menu:
// tab A drills MULTIPLAYER → game → episode → map → mode → skill and
// lands in the lobby; tab B joins, types a custom name, picks a free
// color (slot change → sparse-slot launch path); A starts; both must
// end up in-game. usage: node tools/browser-net-test.mjs [url] [outdir]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const CDP_PORT = 9224;

const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });
const cleanup = code => { chrome.kill(); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);

async function openTab(name) {
    const target = await (await fetch(
        `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
        { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown')
            errors.push(m.params.exceptionDetails.text);
    };
    const cdp = (method, params = {}) => new Promise(res => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    return {
        name, errors, cdp,
        eval: async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value,
        shot: async file => {
            const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(outdir, file), Buffer.from(result.data, 'base64'));
        },
        async click(label) {
            for (let i = 0; i < 10; i++) {
                const ok = await this.eval(
                    `(() => { const r = document.querySelector('#dmenu .row[data-label*=${JSON.stringify(label)}]');
                              return r ? (r.click(), true) : false; })()`);
                if (ok) return true;
                await sleep(300);
            }
            return false;
        },
        async key(key) {
            await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key.length === 1 ? key : undefined });
            await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key });
            await sleep(80);
        },
    };
}

const fail = msg => { console.error(`FAIL: ${msg}`); cleanup(1); };

const A = await openTab('A');
const B = await openTab('B');
await sleep(2500);

// A drills the whole setup
for (const step of ['MULTIPLAYER', 'ULTIMATE', 'EPISODE 1', 'E1M1', 'COOPERATIVE', 'HURT ME PLENTY'])
    if (!await A.click(step)) fail(`A: menu item not found: ${step}`);
await sleep(500);
if (!await A.eval(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
    fail('A: never reached the lobby screen');

// B joins → should land straight in the lobby, then personalize
if (!await B.click('MULTIPLAYER')) fail('B: MULTIPLAYER not found');
await sleep(700);
if (!await B.eval(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
    fail('B: did not land on the lobby screen');
if (!await B.click('NAME')) fail('B: NAME item not found');
for (const k of ['x', 'y', 'z']) await B.key(k);
await B.key('Enter');
await sleep(500);
const names = await A.eval(
    `[...document.querySelectorAll('#dmenu .mheader canvas')].map(c => c.dataset.pname)`);
console.log(`roster seen by A: ${names}`);
if (!names?.some(n => n === 'XYZ')) fail("B's custom name not in A's roster");
if (!names?.some(n => n === 'Green')) fail('default color name missing');

// B picks a free color → moves to a non-adjacent slot (sparse launch)
if (!await B.click('COLOR')) fail('B: COLOR item not found');
await sleep(500);
await A.shot('webdoom-lobby-doomfont.png');

if (!await A.click('START GAME')) fail('A: START GAME not clickable');

let inGame = 0;
for (let i = 0; i < 40; i++) {
    await sleep(500);
    inGame = 0;
    for (const t of [A, B])
        if (await t.eval(`!document.getElementById('screen').hidden && document.getElementById('status')?.textContent === ''`))
            inGame++;
    if (inGame === 2) break;
}
if (inGame !== 2) fail(`only ${inGame}/2 tabs in-game`);

await sleep(2000);
await A.shot('webdoom-mp-a.png');
await B.shot('webdoom-mp-b.png');

const errs = [...A.errors, ...B.errors];
if (errs.length) { console.log('exceptions:', errs.slice(0, 3)); fail('page exceptions'); }
console.log('PASS — drill-down lobby → name/color → sparse-slot co-op in-game');
cleanup(0);