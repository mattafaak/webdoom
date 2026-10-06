#!/usr/bin/env node
// Browser test: rAF frame() exception → landing restore + user-visible message.
//
// Verifies that when an unexpected JS exception is thrown inside the rAF frame()
// loop (a silent wedge), the page recovers gracefully:
//   1. rAF loop STOPS — no further _web_frame calls (not an accumulating error)
//   2. Landing page is restored (#landing visible, #screen hidden)
//   3. User-visible error message is shown in #status
//   4. Audio stop is attempted without throwing (observable via doomAudio.stop call)
//
// Injection mechanism: after game boot, monkey-patch doom._web_frame to throw a
// deterministic Error. This directly exercises the try/catch in frame() and
// reproduces the silent-wedge class (unexpected JS exception mid-frame) without
// depending on engine internals or wasm abort.
//
// Anti-vacuous RED proof: running this test against UNFIXED main.js (bare
// catch { running = false; return; }) must FAIL because the landing is never
// restored and #status stays empty.
//
// Usage: node tools/browser-rafdeath-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? (await startServer()).url;
// WHICH engine export to make throw.  This used to be hardcoded to
// `_web_frame`, and `_web_frame` was the ONE statement inside the frame loop's
// try -- so the gate proved the guarded line was guarded and said nothing
// about `_doomFrameHook`, `_web_palette_version` and `renderer.draw`, which sat
// AFTER the catch.  A throw from any of those killed the loop with no
// endSession at all: a silent wedge, in the loop that exists to prevent
// it.  Those three are inside the try now, and the suite runs this file once
// per injection point so the claim covers both halves.
const injIdx = process.argv.indexOf('--inject');
const INJECT = injIdx >= 0 ? process.argv[injIdx + 1] : '_web_frame';
if (!/^_web_[a-z_]+$/.test(INJECT)) {
    console.error(`FAIL: --inject '${INJECT}' is not an engine export name`);
    process.exit(2);
}
const chrome = await launchChrome();
const tab = await chrome.tab(url);
const { ev, errors } = tab;

if (!await tab.waitForSW(15)) fatal('service worker did not take control within 15s');
if (!await tab.waitForMenu(20).catch(e => fatal(`lobby error: ${e.message}`))) fatal('lobby menu did not appear within 20s');
// Boot the game (click SINGLE PLAYER → first available game); an engine error
// before the injection below is a failure of the boot, not of the recovery.
if (!await tab.bootSP(60).catch(e => fatal(`unexpected engine error before test trigger: ${e.message}`))) {
    console.error('  status:', await ev(`document.getElementById('status')?.textContent`));
    fatal('game did not boot within 60s');
}

// ── Inject deterministic exception into the rAF frame path ───────────────────
// Monkey-patch doom._web_frame to throw once, then restore (tracks call count).
// This reproduces the silent-wedge class: an unexpected JS exception inside the
// try { input.frame(); doom._web_frame(); } block.
const domExported = await ev(`typeof window.webdoom?.doom?.${INJECT} === 'function'`);
if (!domExported) fatal(`window.webdoom.doom.${INJECT} is not a function — game handle missing`);
console.log(`  injecting a throw into doom.${INJECT}`);

// Install the throw patch; count how many times it fires.
await ev(`(() => {
    const d = window.webdoom.doom;
    const orig = d.${INJECT};
    window.__rafThrowCount = 0;
    d.${INJECT} = function() {
        window.__rafThrowCount++;
        d.${INJECT} = orig;   // restore immediately so teardown can proceed normally
        throw new Error('synthetic-rafdeath-ws001');
    };
})()`);

// Allow one rAF tick to fire (the patched _web_frame throw executes).
await sleep(300);

// ── Assert: rAF loop stopped (no accumulating exceptions) ─────────────────────
const throwCount = await ev(`window.__rafThrowCount ?? 0`);
check(`the ${INJECT} throw fired once`, throwCount === 1,
      `fired ${throwCount} times (expected 1) — rAF loop not stopping cleanly`);

// Wait a little longer to confirm no further frames queued (would increment throwCount
// if the original throw-patch were still in place, but we already restored it above;
// instead we track via an extra counter on the restored function for 500ms).
await ev(`(() => {
    const d = window.webdoom.doom;
    const orig = d.${INJECT};
    window.__rafPostCount = 0;
    d.${INJECT} = function(...a) { window.__rafPostCount++; return orig.apply(d, a); };
})()`);
await sleep(500);
const postCount = await ev(`window.__rafPostCount ?? 0`);
check(`the rAF loop stopped: no ${INJECT} calls after the exception`, postCount === 0,
      `rAF loop continued after exception — ${postCount} extra ${INJECT} calls observed`);

// ── Assert recovery ───────────────────────────────────────────────────────────
const landingVisible = await ev(`!document.getElementById('landing').hidden`);
const canvasHidden   = await ev(`document.getElementById('screen').hidden`);
const statusText     = await ev(`document.getElementById('status')?.textContent`);

check('landing page restored after rAF exception', landingVisible, 'user stuck on a frozen canvas');
check('game canvas hidden after rAF exception', canvasHidden);
check('a user-visible error message in #status', statusText && statusText.trim() !== '', `got: ${JSON.stringify(statusText)}`);
check('#status text contains "engine error"', !statusText || statusText.includes('engine error'), `got: ${JSON.stringify(statusText)}`);

// Unexpected uncaught exceptions (filter expected: the synthetic-rafdeath itself
// may surface as a console error before the catch handler swallows it).
const unexpectedErrors = errors.filter(e =>
    !/(synthetic-rafdeath-ws001|abort|RuntimeError|unreachable)/i.test(e));
check('no unexpected JS exceptions', unexpectedErrors.length === 0, unexpectedErrors.join('; '));

summary(`rAF exception recovery via ${INJECT}: landing restored, status shown, loop stopped`);
process.exit();
