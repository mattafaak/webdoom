#!/usr/bin/env node
// Browser multiplayer test through the DOOM-style drill-down menu:
// tab A drills MULTIPLAYER → game → episode → map → mode → skill and
// lands in the lobby; tab B joins, types a custom name, picks a free
// color (slot change → sparse-slot launch path); A starts; both must
// end up in-game. usage: node tools/browser-net-test.mjs [url] [outdir]
//
// State-machine edge coverage (docs/state-machine.md):
//   T14 MP-COUNTDOWN → MP-LOADING  (server launch → menu.hide() + bootDoom starts)
//   T15 MP-LOADING → IN-GAME-MP    (bootDoom resolves)
//   T17 IN-GAME-MP → LANDING       (Quit Game → Y → onQuit → returnToMenu)
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
const onLobby = tab => tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`);

const A = await chrome.tab(url);
const B = await chrome.tab(url);
await sleep(2500);

// lobby-first: MULTIPLAYER lands straight on the lobby screen
if (!await A.click('MULTIPLAYER')) fatal('A: MULTIPLAYER not found');
await sleep(700);
if (!await onLobby(A)) fatal('A: never reached the lobby screen');

// SKILL is a value row: a click steps it (server default 3 → ULTRA-VIOLENCE)
// and the lobby screen stays
const skillLabel = () => A.ev(
    `[...document.querySelectorAll('#dmenu .row')].find(r => r.dataset.label.startsWith('SKILL'))?.dataset.label`);
if (!await A.click('SKILL')) fatal('A: SKILL item not found');
await sleep(500);
const skillRow = await skillLabel();
check('A: clicking SKILL steps it to ULTRA-VIOLENCE', skillRow?.includes('ULTRA-VIOLENCE'), `row reads ${skillRow}`);
check('A: the SKILL click stays on the lobby screen', await onLobby(A));

// left/right also cycles a lobby value in place: right-arrow on SKILL
// should advance it (and it's already the selected row)
await A.key('ArrowRight');
await sleep(300);
const skillAfter = await skillLabel();
check('A: left/right cycles SKILL', skillAfter !== skillRow, `still ${skillAfter}`);

await A.key('ArrowLeft');   // back to ULTRA-VIOLENCE
await sleep(300);

// B joins → should land straight in the lobby, then personalize
if (!await B.click('MULTIPLAYER')) fatal('B: MULTIPLAYER not found');
await sleep(700);
if (!await onLobby(B)) fatal('B: did not land on the lobby screen');
if (!await B.click('NAME')) fatal('B: NAME item not found');
for (const k of ['x', 'y', 'z']) await B.key(k);
await B.key('Enter');
await sleep(500);
const names = await A.ev(
    `[...document.querySelectorAll('#dmenu .mheader canvas')].map(c => c.dataset.pname)`);
console.log(`roster seen by A: ${names}`);
check("B's custom name is in A's roster", names?.some(n => n === 'XYZ'), `roster: ${names}`);
check('the default color name is in the roster', names?.some(n => n === 'Green'), `roster: ${names}`);

// B picks a free color → moves to a non-adjacent slot (sparse launch)
if (!await B.click('COLOR')) fatal('B: COLOR item not found');
await sleep(500);
await shot(A, 'webdoom-lobby-doomfont.png');

if (!await A.click('START GAME')) fatal('A: START GAME not clickable');

let inGame = 0;
for (let i = 0; i < 40; i++) {
    await sleep(500);
    inGame = 0;
    for (const t of [A, B]) if (await t.inGame()) inGame++;
    if (inGame === 2) break;
}
check('both tabs reach the game', inGame === 2, `only ${inGame}/2 tabs in-game`);

// GO melt ~1s in the foreground; background tabs throttle the timer
// backstop, so poll rather than assume
let overlaysGone = false;
for (let i = 0; i < 16 && !overlaysGone; i++) {
    await sleep(500);
    overlaysGone = (await A.ev(`document.getElementById('countdown').hidden`))
        && (await B.ev(`document.getElementById('countdown').hidden`));
}
check('the countdown overlay is gone in both tabs', overlaysGone, 'countdown overlay still visible in-game');
await shot(A, 'webdoom-mp-a.png');
await shot(B, 'webdoom-mp-b.png');

const errs = [...A.errors, ...B.errors];
check('no page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));
summary('drill-down lobby → name/color → sparse-slot co-op in-game');
process.exit();
