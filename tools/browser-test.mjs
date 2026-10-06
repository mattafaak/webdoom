#!/usr/bin/env node
// End-to-end browser test via Chrome DevTools Protocol (no deps: node's
// built-in WebSocket). Boots the full client against a running server,
// screenshots the title screen, opens the menu with Escape, screenshots
// again. usage: node tools/browser-test.mjs [url] [outdir]
//
// State-machine edge coverage (docs/state-machine.md):
//   T03 SP-PICK → SP-LOADING  (click game title → bootDoom starts)
//   T04 SP-LOADING → IN-GAME-SP  (bootDoom resolves)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? (await startServer()).url;
const outdir = process.argv[3] ?? '/tmp';
const chrome = await launchChrome();
const tab = await chrome.tab(url);
const { cdp, ev: evaluate, errors: consoleErrors } = tab;

// Wait for the service worker to activate and claim this page.
// sw.js uses skipWaiting()+clients.claim() so this is typically <2s on a
// local server, but the installation (c.addAll of ~14 shell files) is async.
// If we let the boot loop start before the SW is controlling, the WAD fetch
// goes directly to the server and is NOT intercepted/cached by the SW.
if (!await tab.waitForSW(15)) fatal('service worker did not take control within 15s');

// landing page → SINGLE PLAYER → THE ULTIMATE DOOM → the engine running
if (!await tab.bootSP(30).catch(e => fatal(e.message))) {
    console.error('  status:', await evaluate(`document.getElementById('status')?.textContent`));
    console.error('  errors:', consoleErrors.slice(0, 5));
    fatal('boot timeout');
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
check('Escape opened the menu (title and menu screenshots differ)', png1 !== png2, 'input dead');
check('the game started from the menu (menu and E1M1 screenshots differ)', png2 !== png3);
check('the player moved (E1M1 screenshots before and after W differ)', png3 !== png4);
check('audio armed after key input', !!audioArmed);
check('the service worker cached a WAD', !!wadsCached);
check('no audio errors in the console', !consoleErrors.some(e => /worklet|audio/i.test(e)));
summary(`title/menu/e1m1/moved screenshots in ${outdir}`);
process.exit();
