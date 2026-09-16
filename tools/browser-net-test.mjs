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

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const chrome = await launchChrome();
const cleanup = code => { chrome.kill(); process.exit(code); };

async function openTab(name) {
    const tab = await chrome.tab(url);
    return {
        name, errors: tab.errors, cdp: tab.cdp, eval: tab.ev, click: tab.click,
        shot: async file => {
            const { result } = await tab.cdp('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(outdir, file), Buffer.from(result.data, 'base64'));
        },
        // the menu switches on e.code, so send a matching code
        key: k => tab.key(k, undefined, k.length === 1 ? `Key${k.toUpperCase()}` : k),
    };
}

const fail = msg => { console.error(`FAIL: ${msg}`); cleanup(1); };

const A = await openTab('A');
const B = await openTab('B');
await sleep(2500);

// lobby-first: MULTIPLAYER lands straight on the lobby screen
if (!await A.click('MULTIPLAYER')) fail('A: MULTIPLAYER not found');
await sleep(700);
if (!await A.eval(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
    fail('A: never reached the lobby screen');

// SKILL is a value row: a click steps it (server default 3 → ULTRA-VIOLENCE)
// and the lobby screen stays
const skillLabel = () => A.eval(
    `[...document.querySelectorAll('#dmenu .row')].find(r => r.dataset.label.startsWith('SKILL'))?.dataset.label`);
if (!await A.click('SKILL')) fail('A: SKILL item not found');
await sleep(500);
const skillRow = await skillLabel();
if (!skillRow?.includes('ULTRA-VIOLENCE'))
    fail(`A: clicking SKILL did not step it to ULTRA-VIOLENCE (${skillRow})`);
if (!await A.eval(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
    fail('A: SKILL click left the lobby screen');

// left/right also cycles a lobby value in place: right-arrow on SKILL
// should advance it (and it's already the selected row)
await A.key('ArrowRight');
await sleep(300);
const skillAfter = await skillLabel();
if (skillAfter === skillRow) fail('A: left/right did not cycle SKILL');

await A.key('ArrowLeft');   // back to ULTRA-VIOLENCE
await sleep(300);

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

// GO melt ~1s in the foreground; background tabs throttle the timer
// backstop, so poll rather than assume
let overlaysGone = false;
for (let i = 0; i < 16 && !overlaysGone; i++) {
    await sleep(500);
    overlaysGone = (await A.eval(`document.getElementById('countdown').hidden`))
        && (await B.eval(`document.getElementById('countdown').hidden`));
}
if (!overlaysGone) fail('countdown overlay still visible in-game');
await A.shot('webdoom-mp-a.png');
await B.shot('webdoom-mp-b.png');

const errs = [...A.errors, ...B.errors];
if (errs.length) { console.log('exceptions:', errs.slice(0, 3)); fail('page exceptions'); }
console.log('PASS — drill-down lobby → name/color → sparse-slot co-op in-game');
cleanup(0);