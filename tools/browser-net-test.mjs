#!/usr/bin/env node
// Browser multiplayer test: two Chrome tabs join the lobby UI, one hits
// START, both must end up in-game with the roster having shown both
// colors. usage: node tools/browser-net-test.mjs [url] [outdir]
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
        name, errors,
        eval: async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value,
        shot: async file => {
            const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(outdir, file), Buffer.from(result.data, 'base64'));
        },
    };
}

const fail = msg => { console.error(`FAIL: ${msg}`); cleanup(1); };

const A = await openTab('A');
const B = await openTab('B');

// wait for landing, open the MP panel in both
for (const t of [A, B]) {
    for (let i = 0; i < 20 && !(await t.eval(`!!document.getElementById('mp')`)); i++) await sleep(300);
    await t.eval(`document.getElementById('mp').open = true`);
    await sleep(400);
}
await sleep(600);

const rosterA = await A.eval(`document.getElementById('mp-roster').textContent`);
console.log(`roster seen by A: ${rosterA}`);
if (!/Green/.test(rosterA) || !/Indigo/.test(rosterA)) fail('both colors not in roster');

await A.shot('webdoom-lobby.png');
await A.eval(`document.getElementById('mp-start').click()`);

// countdown is 3s; wait for both to be in-game
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

await sleep(2000);      // let the level render + tics flow
await A.shot('webdoom-mp-green.png');
await B.shot('webdoom-mp-indigo.png');

const errs = [...A.errors, ...B.errors];
if (errs.length) { console.log('exceptions:', errs.slice(0, 3)); fail('page exceptions'); }
console.log('PASS — 2-tab lobby → countdown → co-op in-game');
cleanup(0);