#!/usr/bin/env node
// Browser drop-in test through the DOOM menu: tab A starts a co-op game;
// tab C opens MULTIPLAYER, sees the GAME IN PROGRESS screen, hits DROP IN,
// catches up, and lands in the running game. Exercises the full client join
// path (inprogress summary → join → catch-up boot).
// usage: node tools/browser-join-test.mjs [url] [outdir]
//
// State-machine edge coverage (docs/state-machine.md):
//   T18 DROP-IN-OFFER → DROP-IN-LOADING  (click DROP IN → lobby.send join → server welcome+launch)
//   T19 DROP-IN-LOADING → IN-GAME-MP     (catch-up done, relay goes live)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const CDP_PORT = 9225;

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
        `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map(); const errors = [];
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    };
    const cdp = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await cdp('Runtime.enable'); await cdp('Page.enable');
    return {
        name, errors, cdp,
        eval: async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value,
        shot: async file => { const { result } = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outdir, file), Buffer.from(result.data, 'base64')); },
        async click(label) {
            for (let i = 0; i < 10; i++) {
                const ok = await this.eval(`(() => { const r = document.querySelector('#dmenu .row[data-label*=${JSON.stringify(label)}]'); return r ? (r.click(), true) : false; })()`);
                if (ok) return true;
                await sleep(300);
            }
            return false;
        },
        inGame() { return this.eval(`!document.getElementById('screen').hidden && document.getElementById('status')?.textContent === ''`); },
    };
}

const fail = msg => { console.error(`FAIL: ${msg}`); cleanup(1); };
const waitInGame = async (t, secs) => { for (let i = 0; i < secs * 2; i++) { if (await t.inGame()) return true; await sleep(500); } return false; };

const A = await openTab('A');
await sleep(2500);

// A: start a co-op game solo
if (!await A.click('MULTIPLAYER')) fail('A: MULTIPLAYER not found');
await sleep(700);
if (!await A.click('START GAME')) fail('A: START GAME not found');
if (!await waitInGame(A, 20)) fail('A: never reached in-game');
console.log('A is in-game; letting it run…');
await sleep(2500);   // build some history to catch up on

// C: open MULTIPLAYER → should get the GAME IN PROGRESS screen
const C = await openTab('C');
await sleep(2500);
if (!await C.click('MULTIPLAYER')) fail('C: MULTIPLAYER not found');
await sleep(1000);
const title = await C.eval(`document.querySelector('#dmenu .mtitle')?.textContent ?? document.querySelector('#dmenu')?.textContent`);
const hasDropIn = await C.eval(`!!document.querySelector('#dmenu .row[data-label*="DROP IN"]')`);
if (!hasDropIn) fail(`C: no DROP IN on the in-progress screen (menu text: ${String(title).slice(0, 80)})`);
console.log('C sees GAME IN PROGRESS with DROP IN');
await C.shot('webdoom-inprogress.png');

// C: drop in → catch up → in-game
if (!await C.click('DROP IN')) fail('C: DROP IN not clickable');
if (!await waitInGame(C, 30)) fail('C: never dropped in / reached in-game');
await sleep(2000);
if (!await C.inGame()) fail('C: fell out of the game after joining');
await C.shot('webdoom-droppedin.png');

const errs = [...A.errors, ...C.errors];
if (errs.length) { console.log('exceptions:', errs.slice(0, 3)); fail('page exceptions'); }
console.log('PASS — browser drop-in: GAME IN PROGRESS → DROP IN → caught up in-game');
cleanup(0);
