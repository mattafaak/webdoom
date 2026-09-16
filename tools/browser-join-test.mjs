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
//   T31 DROP-IN-OFFER → IN-GAME-MP       (click SPECTATE → receive-only boot)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const chrome = await launchChrome();
const cleanup = code => { chrome.kill(); process.exit(code); };

async function openTab(name) {
    const tab = await chrome.tab(url);
    return {
        name, errors: tab.errors, cdp: tab.cdp, eval: tab.ev, click: tab.click, inGame: tab.inGame,
        shot: async file => {
            const { result } = await tab.cdp('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(outdir, file), Buffer.from(result.data, 'base64'));
        },
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

// D: SPECTATE from the same screen → a receive-only boot into the running game
const D = await openTab('D');
await sleep(2500);
if (!await D.click('MULTIPLAYER')) fail('D: MULTIPLAYER not found');
if (!await D.click('SPECTATE')) fail('D: SPECTATE not offered on the in-progress screen');
if (!await waitInGame(D, 30)) fail('D: spectator never reached in-game');
await sleep(1500);
if (!await D.inGame()) fail('D: spectator fell out of the game');
console.log('D is spectating');

const errs = [...A.errors, ...C.errors, ...D.errors];
if (errs.length) { console.log('exceptions:', errs.slice(0, 3)); fail('page exceptions'); }
console.log('PASS — browser drop-in: GAME IN PROGRESS → DROP IN → caught up in-game; SPECTATE → watching');

cleanup(0);
