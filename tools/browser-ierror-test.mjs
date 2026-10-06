#!/usr/bin/env node
// Browser test: I_Error / onDoomError recovery (spec.md tenet 4).
//
// Verifies that when the engine fires I_Error (onDoomError callback), the page
// recovers gracefully:
//   • landing page is restored (not left on a blank canvas)
//   • THE MENU INSIDE IT IS RENDERED — see below
//   • a user-visible error message is shown in #status
//   • the game canvas is hidden
//
// WHAT THIS TEST USED TO MISS
// ---------------------------
// It asserted `!#landing.hidden` and called that "landing page restored", and
// its failure string said "user stuck on blank canvas".  The canvas was
// correctly hidden; the player was stuck on a blank PAGE.  lobby.js calls
// menu.hide() before booting, and menu.render() opens
// `root.replaceChildren(); if (hidden || !screen()) return;` — so #landing came
// back VISIBLE AND EMPTY, because the error path never called the caller's
// onQuit callback and so lobby.js's returnToMenu() never ran.  Only a reload
// recovered.  The assertion checked the container, not the contents.
//
// The selector that catches it was already in this file: the boot step below
// waits for `#dmenu .row[data-label="SINGLE PLAYER"]` before clicking it.  The
// recovery assertion uses the same one now.
//
// Trigger: after the game boots, we call doom.onDoomError() directly via CDP.
// This is the exact JS handler fixed in client/js/main.js — the "call path"
// through Emscripten EM_ASM is equivalent (both call the same function object).
// Running against the real server + real engine is required so the module
// structure and DOM wiring are exercised exactly as in production.
//
// Usage: node tools/browser-ierror-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? (await startServer()).url;
const chrome = await launchChrome();
const tab = await chrome.tab(url);
const { ev, errors } = tab;

if (!await tab.waitForSW(15)) fatal('service worker did not take control within 15s');
if (!await tab.waitForMenu(20).catch(e => fatal(`lobby error: ${e.message}`))) fatal('lobby menu did not appear within 20s');
// Boot the game (click SINGLE PLAYER → first available game); an engine error
// before the trigger below is a failure of the boot, not of the recovery.
if (!await tab.bootSP(60).catch(e => fatal(`unexpected engine error before test trigger: ${e.message}`))) {
    console.error('  status:', await ev(`document.getElementById('status')?.textContent`));
    fatal('game did not boot within 60s');
}

// ── Trigger onDoomError — simulates I_Error from engine ───────────────────────
// window.webdoom.doom is the Emscripten Module; onDoomError is the handler
// set in client/js/main.js (the fix under test). Calling it directly exercises
// the same code path that EM_ASM invokes in i_system.c I_Error().
const TEST_MSG = 'no player 1 start in E1M1';
const handlerExists = await ev(`typeof window.webdoom?.doom?.onDoomError === 'function'`);
if (!handlerExists) fatal('window.webdoom.doom.onDoomError is not a function — fix not applied or module did not export it');

await ev(`window.webdoom.doom.onDoomError(${JSON.stringify(TEST_MSG)})`);
await sleep(300);

// ── Assert recovery ────────────────────────────────────────────────────────────
const landingVisible = await ev(`!document.getElementById('landing').hidden`);
const canvasHidden   = await ev(`document.getElementById('screen').hidden`);
const statusText     = await ev(`document.getElementById('status')?.textContent`);
// The same selector the boot step waits on, asked again after the error.
const menuRows       = await ev(`document.querySelectorAll('#dmenu .row').length`);
const canPlayAgain   = await ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`);

check('landing page restored after I_Error', landingVisible, 'user stuck on blank canvas');
check(`launcher menu re-rendered: ${menuRows} rows, SINGLE PLAYER reachable`, menuRows && canPlayAgain,
      !menuRows ? '#landing is visible but the menu inside it is EMPTY (0 rows) — '
                + 'the container was restored, not the launcher; only a reload recovers'
                : `menu rendered ${menuRows} row(s) after I_Error but SINGLE PLAYER is not among them — `
                + 'the player cannot start another game');
check('game canvas hidden after I_Error', canvasHidden);
check('user-visible error message shown in #status', statusText?.includes('engine error'), `got: ${JSON.stringify(statusText)}`);
check(`error message contains "${TEST_MSG}"`, statusText?.includes(TEST_MSG), `got: ${JSON.stringify(statusText)}`);

// Unexpected uncaught exceptions (not the abort from I_Error)
const unexpectedErrors = errors.filter(e =>
    !/(abort|RuntimeError|unreachable|onDoomError)/i.test(e));
check('no unexpected JS exceptions', unexpectedErrors.length === 0, unexpectedErrors.join('; '));

summary(`I_Error recovery — landing restored, launcher menu re-rendered (${menuRows} rows), `
      + 'SINGLE PLAYER reachable, canvas hidden, error message shown');
process.exit();
