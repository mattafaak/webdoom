#!/usr/bin/env node
// A PWAD game is its own game: its saves and its demo links are not its base
// IWAD's.  Through the launcher, in one browser profile:
//
//   1. SIGIL (a doom.wad PWAD), RECORD DEMO on: start a game and save to slot
//      0 through the engine's menu.  The save must be stored under SIGIL's
//      namespace (doom.wad+sigil.wad), not Ultimate Doom's;
//   2. STOP & SHARE: the link must name sigil.wad, the WAD a replay needs;
//   3. reload, start The Ultimate Doom, open Load Game: slot 0 must be empty.
//      With one namespace per IWAD, SIGIL's save sat in Ultimate Doom's slot.
//
// usage: node tools/browser-pwad-session-test.mjs <url>
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? fatal('usage: browser-pwad-session-test.mjs <url>');
const chrome = await launchChrome();
process.on('exit', () => chrome.kill());
const tab = await chrome.tab(url);
const { ev, key } = tab;

const engine = () => ev(`!!window.webdoom?.doom && document.getElementById('status')?.textContent === ''`);
const menuActive = () => ev(`window.webdoom?.doom?.ccall('web_menu_active', 'number', [], []) === 1`);
const idbKeys = () => ev(`(async () => {
    const d = await new Promise((res, rej) => { const r = indexedDB.open('webdoom', 1);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const keys = await new Promise(res => { const t = d.transaction('files');
        const g = t.objectStore('files').getAllKeys(); t.oncomplete = () => res(g.result); });
    d.close(); return keys; })()`);

// 1. SIGIL, recording, save to slot 0
if (!await tab.waitForMenu()) fatal('the launcher menu never appeared');
if (!await tab.click('SINGLE PLAYER')) fatal('SINGLE PLAYER not found');
await sleep(400);
if (!await ev(`(() => { const r = document.querySelector('#dmenu .row[data-label^="RECORD DEMO:"]'); return r ? (r.click(), true) : false; })()`))
    fatal('RECORD DEMO row not found');
await sleep(300);
if (!await tab.click('SIGIL')) fatal('SIGIL is not in the game list');
if (!await tab.waitFor(engine, { timeout: 60000 })) fatal('SIGIL never booted');
await sleep(1500);
for (const [k, vk] of [['Escape', 27], ['Enter', 13], ['Enter', 13], ['Enter', 13]]) await key(k, vk);   // new game
await sleep(2500);
await key('F2', 0x71); await key('Enter', 13); await key('a', 65); await key('Enter', 13);
await tab.waitFor(async () => (await idbKeys()).some(k => k.endsWith('doomsav0.dsg')), { timeout: 8000 });
const keys = await idbKeys();
check('the SIGIL save is stored under doom.wad+sigil.wad', keys.includes('doom.wad+sigil.wad:doomsav0.dsg'), JSON.stringify(keys));
check('nothing was saved under The Ultimate Doom', !keys.includes('doom.wad:doomsav0.dsg'), JSON.stringify(keys));

// 2. the demo link names the game that was played
if (!await ev(`(() => { const b = document.getElementById('demo-stop-btn'); return b ? (b.click(), true) : false; })()`))
    fatal('STOP & SHARE button not found');
await tab.waitFor(() => ev(`!!document.querySelector('#demo-share-panel a')`), { timeout: 10000 });
const link = await ev(`document.querySelector('#demo-share-panel a')?.href ?? ''`);
check('the demo link names sigil.wad', /[?&#]wad=sigil\.wad\b/.test(link), link.slice(0, 120));

// 3. The Ultimate Doom's slot 0 is its own
await tab.cdp('Page.reload');
await sleep(1000);
if (!await tab.waitForMenu()) fatal('the launcher menu never came back after reload');
if (!await tab.bootSP()) fatal('The Ultimate Doom never booted');
await sleep(1500);
await key('F3', 0x72);
await sleep(400);
const opened = await menuActive();
await key('Enter', 13);              // on an empty slot this does nothing
await sleep(1200);
check('The Ultimate Doom opens its Load Game menu', opened);
check("The Ultimate Doom's slot 0 is empty (SIGIL's save is not offered)", opened && await menuActive());

const passed = summary('a PWAD game keeps its own saves and its own demo links');
chrome.kill();
process.exit(passed ? 0 : 1);
