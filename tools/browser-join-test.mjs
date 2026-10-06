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
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? (await startServer()).url;
const outdir = process.argv[3] ?? '/tmp';
const chrome = await launchChrome();
const shot = async (tab, file) => {
    const { result } = await tab.cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outdir, file), Buffer.from(result.data, 'base64'));
};
const waitInGame = (t, secs) => t.waitFor(t.inGame, { timeout: secs * 1000, every: 500 });

const A = await chrome.tab(url);
await sleep(2500);

// A: start a co-op game solo
if (!await A.click('MULTIPLAYER')) fatal('A: MULTIPLAYER not found');
await sleep(700);
if (!await A.click('START GAME')) fatal('A: START GAME not found');
if (!await waitInGame(A, 20)) fatal('A: never reached in-game');
console.log('A is in-game; letting it run…');
await sleep(2500);   // build some history to catch up on

// C: open MULTIPLAYER → should get the GAME IN PROGRESS screen
const C = await chrome.tab(url);
await sleep(2500);
if (!await C.click('MULTIPLAYER')) fatal('C: MULTIPLAYER not found');
await sleep(1000);
const title = await C.ev(`document.querySelector('#dmenu .mtitle')?.textContent ?? document.querySelector('#dmenu')?.textContent`);
const hasDropIn = await C.ev(`!!document.querySelector('#dmenu .row[data-label*="DROP IN"]')`);
if (!hasDropIn) fatal(`C: no DROP IN on the in-progress screen (menu text: ${String(title).slice(0, 80)})`);
console.log('C sees GAME IN PROGRESS with DROP IN');
await shot(C, 'webdoom-inprogress.png');

// C: drop in → catch up → in-game
if (!await C.click('DROP IN')) fatal('C: DROP IN not clickable');
check('C: drops in, catches up and reaches the game', await waitInGame(C, 30), 'never dropped in / reached in-game');
await sleep(2000);
check('C: stays in the game after joining', await C.inGame(), 'fell out of the game after joining');
await shot(C, 'webdoom-droppedin.png');

// D: SPECTATE from the same screen → a receive-only boot into the running game
const D = await chrome.tab(url);
await sleep(2500);
if (!await D.click('MULTIPLAYER')) fatal('D: MULTIPLAYER not found');
if (!await D.click('SPECTATE')) fatal('D: SPECTATE not offered on the in-progress screen');
check('D: the spectator reaches the game', await waitInGame(D, 30), 'spectator never reached in-game');
await sleep(1500);
check('D: the spectator stays in the game', await D.inGame(), 'spectator fell out of the game');
console.log('D is spectating');

const errs = [...A.errors, ...C.errors, ...D.errors];
check('no page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));
summary('browser drop-in: GAME IN PROGRESS → DROP IN → caught up in-game; SPECTATE → watching');
process.exit();
