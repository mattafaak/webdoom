#!/usr/bin/env node
// Pass C browser test: record→URL (fragment embed)→second tab replay
// with identical per-tic sim hash sequence.  Also tests WAD ownership check.
//
// Test flow:
//   Tab A — navigates SINGLE PLAYER → doom.wad → RECORD & SHARE.
//            Injects window._doomFrameHook to collect per-tic hashes.
//            Enables singletics (1 tic per rAF).
//            Waits for TARGET_TICKS; frame hook auto-stops recording.
//            Extracts demo bytes from wasm heap → fragment URL.
//   Tab B — opens fragment URL.
//            Lobby auto-detects #demo=… → parseDemoUrl → startReplay.
//            Injects frame hook + singletics.
//            Waits for demo to finish (web_demo_playing() → false).
//            Asserts replay hashes == record hashes for all ticks.
//   Tab C — opens fragment URL with wad=nonexistent.wad (WAD ownership test).
//            Asserts the warning/status message is shown.
//
// usage: node tools/browser-demo-test.mjs [url] [outdir]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary } from './lib/report.mjs';

const srvUrl  = process.argv[2] ?? (await startServer()).url;
const outdir  = process.argv[3] ?? '/tmp';
const TARGET_TICKS = 50;   // 13 + 50*4 + 1 = 214 bytes — well below FRAGMENT_MAX=6000

// a hidden tab's rAF is throttled, and Tab B replays under a frame hook
const chrome = await launchChrome({ flags: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });

const shot = async (tab, file) => {
    const { result } = await tab.cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outdir, file), Buffer.from(result.data, 'base64'));
};
// Every step below needs the one before it, so a wait that times out ends the
// run (the catch below reports it) rather than letting the next step proceed.
async function until(tab, fn, timeoutMs = 60000, intervalMs = 200) {
    if (!await tab.waitFor(fn, { timeout: timeoutMs, every: intervalMs })) throw new Error('waitFor timed out');
    return true;
}

// ── Main test body ────────────────────────────────────────────────────────────

console.log('\n── browser-demo-test: record → fragment URL → replay hash check ────');

let tabA, tabB, tabC, tabD;
try {
    // ── Tab A: wait for SW, navigate SINGLE PLAYER → RECORD & SHARE… → game ──

    tabA = await chrome.tab(srvUrl);
    await sleep(2500);

    // Wait for service worker to control the page.
    await until(tabA, () => tabA.ev(`!!navigator.serviceWorker.controller`), 20000);

    // Navigate: SINGLE PLAYER → RECORD DEMO: ON → doom.wad game entry.
    const spOk = await tabA.click('SINGLE PLAYER', 20);
    check('Tab A: SINGLE PLAYER menu item found', spOk);

    // RECORD DEMO is a value row on the game list: one click turns it ON and
    // the row says so.  Asserting the label is what makes this a test of the
    // switch rather than of "a row containing RECORD took a click".
    await sleep(500);
    const recOk = await until(tabA, async () => tabA.ev(
        `(() => { const r = document.querySelector('#dmenu .row[data-label^="RECORD DEMO:"]');
                  return r ? (r.click(), true) : false; })()`), 10000, 300);
    check('Tab A: RECORD DEMO row clicked', recOk);
    await sleep(300);
    const recLabel = await tabA.ev(
        `document.querySelector('#dmenu .row[data-label^="RECORD DEMO:"]')?.dataset.label`);
    check(`Tab A: RECORD DEMO reads ON (${recLabel})`, recLabel === 'RECORD DEMO: < ON >');

    // Still on the game list: click doom.wad's entry.

    await sleep(400);
    const doomOk = await until(tabA, async () => {
        // Try common title strings for doom.wad
        for (const label of ['DOOM', 'ULTIMATE DOOM', 'THE ULTIMATE DOOM', 'ULTIMATE DOOM (V1.9)']) {
            const hit = await tabA.ev(
                `(() => { const r = document.querySelector('#dmenu .row[data-label*=${JSON.stringify(label)}]');
                          return r ? (r.click(), true) : false; })()`);
            if (hit) return true;
        }
        return false;
    }, 10000, 500);
    check('Tab A: doom.wad game entry clicked (record picker)', doomOk);

    // Wait for bootDoom to complete: window.webdoom must be set.
    await until(tabA, () => tabA.ev(`typeof window.webdoom?.doom?._web_demo_stop === 'function'`), 60000, 500);
    check('Tab A: bootDoom complete, demo bridge available', true);

    // Set up frame hook BEFORE enabling singletics.
    // The hook collects per-tic hashes and auto-stops recording after TARGET_TICKS.
    // _recordStartTic is captured so Tab B can wait for the same gametic before
    // collecting — web_state_hash includes the absolute gametic value, so the
    // sequences must be compared at matching gametic positions.
    await tabA.ev(`
        window._recordHashes    = [];
        window._recordStartTic  = null;
        window._lastTic         = -1;
        window._frameActive     = true;
        window._demoStopped     = false;
        window._demoByteCount   = 0;
        window._doomFrameHook = () => {
            if (!window._frameActive || !window.webdoom?.doom) return;
            const doom = window.webdoom.doom;
            // Clear any active melt wipe: wipes are wall-clock driven and cause
            // D_DoomFrame to early-return without advancing the sim (gametic freeze).
            // Mirror of demo-test.mjs:121 and demo-replay-test.mjs:83.
            if (typeof doom._web_wipe_skip === 'function') doom._web_wipe_skip();
            const tic  = doom._web_gametic();
            if (tic !== window._lastTic) {
                if (window._recordStartTic === null) window._recordStartTic = tic;
                window._recordHashes.push(doom._web_state_hash() >>> 0);
                window._lastTic = tic;
            }
            if (window._recordHashes.length >= ${TARGET_TICKS} && !window._demoStopped) {
                window._frameActive   = false;
                window._demoStopped   = true;
                window._demoByteCount = doom._web_demo_stop();
                window._demoBufPtr    = doom._web_demo_buf_ptr();
            }
        };
        window.webdoom.doom._web_set_singletics(1);
        true
    `);
    check('Tab A: frame hook + singletics installed', true);

    // Wait for TARGET_TICKS to be collected.
    await until(tabA, () => tabA.ev(`window._demoStopped`), 30000, 200);
    check(`Tab A: ${TARGET_TICKS} ticks recorded, demo stopped`, true);

    // Verify demo byte count.
    const demoSize = await tabA.ev(`window._demoByteCount`);
    const expectedMin = 13 + TARGET_TICKS * 4 + 1;   // header + ticks + marker
    check(`Tab A: demo size >= ${expectedMin} bytes`, demoSize >= expectedMin, `size=${demoSize}`);

    // Collect the recording hash array and the starting gametic.
    // recordStartGamtic is passed to Tab B so it waits for the same gametic
    // before collecting — web_state_hash includes absolute gametic, so both
    // sequences must start at the same position to be comparable.
    const recordHashes = await tabA.ev(`window._recordHashes.slice()`);
    check(`Tab A: collected ${TARGET_TICKS} record hashes`, recordHashes?.length >= TARGET_TICKS,
        `got=${recordHashes?.length}`);
    const recordStartGamtic = await tabA.ev(`window._recordStartTic ?? 0`);

    // Extract demo bytes from wasm heap as base64 for transport.
    const demoB64 = await tabA.ev(`
        (function() {
            const doom = window.webdoom.doom;
            const ptr  = doom._web_demo_buf_ptr();
            const size = window._demoByteCount;
            const bytes = doom.HEAPU8.slice(ptr, ptr + size);
            let b = '';
            for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
            return btoa(b);
        })()
    `);
    check('Tab A: demo bytes extracted', typeof demoB64 === 'string' && demoB64.length > 0,
        `b64 length=${demoB64?.length}`);

    // Generate the fragment URL (same algorithm as demo.js stopAndShare fragment path).
    // Convert base64 to base64url and construct the URL.
    const b64url = demoB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fragmentUrl = `${srvUrl}#demo=${encodeURIComponent(b64url)}&wad=${encodeURIComponent('doom.wad')}`;
    check(`Tab A: fragment URL generated (${fragmentUrl.length} chars)`, true);

    await shot(tabA, 'demo-test-tabA.png');

    // ── Tab B: open fragment URL, replay, compare hashes ─────────────────────
    // Root-cause: D_DoomFrame returns early when wipeactive=true (GS_DEMOSCREEN→
    // GS_LEVEL transition triggered by G_InitNew inside web_play_demo_buf).  The
    // gametic freezes at the level-start tic and the replay never advances.
    //
    // Node harness (demo-replay-test.mjs:152) fixes this by calling
    // doom._web_wipe_skip() before every frame.  Browser CDP injection is too
    // late: the replay completes (or the wipe thaws and races) before CDP gets to
    // inject the hook via Runtime.evaluate.
    //
    // Fix: open Tab B to about:blank first, pre-install the replay hook via
    // Page.addScriptToEvaluateOnNewDocument (runs before ANY page JS), then
    // navigate to fragmentUrl.  The hook — including the wipe_skip call — is
    // active on frame 1, preventing the freeze entirely.

    tabB = await chrome.tab('about:blank');
    await sleep(500);

    // Pre-install the replay hook.  Page.addScriptToEvaluateOnNewDocument runs
    // this source at the top of every future document in this tab, before any
    // page script.  When we navigate to fragmentUrl below, the hook is in place
    // before main.js schedules its first requestAnimationFrame.
    await tabB.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
        window._replayHashes   = [];
        window._replayStartTic = null;
        window._lastTicB       = -1;
        window._replayDone     = false;
        window._doomFrameHook = () => {
            if (!window.webdoom?.doom || window._replayDone) return;
            const doom = window.webdoom.doom;
            // Clear any active melt wipe before sampling gametic: GS_DEMOSCREEN →
            // GS_LEVEL transition in G_DoLoadLevel sets wipeactive, causing D_DoomFrame
            // to early-return every frame without advancing the sim (gametic freeze).
            // Must call before doom._web_frame(), so pre-installed here rather than
            // injected late via Runtime.evaluate after bootDoom detection.
            if (typeof doom._web_wipe_skip === 'function') doom._web_wipe_skip();
            const tic  = doom._web_gametic();
            if (tic !== window._lastTicB) {
                window._lastTicB = tic;
                if (tic >= ${recordStartGamtic}) {
                    if (window._replayStartTic === null) window._replayStartTic = tic;
                    window._replayHashes.push(doom._web_state_hash() >>> 0);
                }
            }
            // Done once the engine has advanced to the last gametic Tab A recorded.
            if (window._lastTicB >= ${recordStartGamtic + TARGET_TICKS - 1}) {
                window._replayDone = true;
            }
        };
    ` });
    check(`Tab B: replay hook pre-installed (start=${recordStartGamtic} end=${recordStartGamtic + TARGET_TICKS - 1})`, true);

    // Navigate to the fragment URL.  The pre-installed hook fires from frame 1.
    await tabB.cdp('Page.navigate', { url: fragmentUrl });
    await sleep(2000);
    await until(tabB, () => tabB.ev(`!!navigator.serviceWorker.controller`), 20000);

    // Poll for window.webdoom.doom being available (bootDoom complete).
    await until(tabB, () => tabB.ev(`typeof window.webdoom?.doom === 'object'`), 90000, 100);
    check('Tab B: bootDoom complete, demo bridge available', true);

    // Diagnostic: gametic at this point.  With wipe_skip active from frame 1,
    // gametic should be advancing normally (> 1 and likely close to TARGET_TICKS).
    const tabBGameticAtBoot = await tabB.ev(`window.webdoom?.doom?._web_gametic?.() ?? -1`);
    console.log(`  [diag] Tab B gametic after bootDoom detect: ${tabBGameticAtBoot}`);

    // Wait for _replayDone.  Timeout is generous: WAD boot (~5 s) + replay to
    // the final expected gametic (~50/60 s ≈ 1 s).
    await until(tabB, () => tabB.ev(`window._replayDone`), 90000, 200);
    check(`Tab B: replay advanced to gametic ${recordStartGamtic + TARGET_TICKS - 1}`, true);

    const replayHashes   = await tabB.ev(`window._replayHashes.slice()`);
    const replayStartTic = await tabB.ev(`window._replayStartTic ?? ${recordStartGamtic}`);
    check(`Tab B: collected ${replayHashes?.length} replay hashes`, (replayHashes?.length ?? 0) > 0);

    // Align the two sequences by gametic and compare the overlapping window.
    //   recordHashes[i]  ↔  gametic recordStartGamtic + i
    //   replayHashes[j]  ↔  gametic replayStartTic    + j
    // Overlap: overlapStart..overlapEnd (both ends inclusive).
    const recEnd      = recordStartGamtic + recordHashes.length - 1;
    const repEnd      = replayStartTic    + replayHashes.length - 1;
    const overlapStart = Math.max(recordStartGamtic, replayStartTic);
    const overlapEnd   = Math.min(recEnd, repEnd);
    const n = Math.max(0, overlapEnd - overlapStart + 1);
    // Full-trace contract: the overlap must cover the whole recording, not
    // merely be non-empty (a 1-tick overlap is not a FULL trace comparison).
    check(`Tab B: overlap window is ${n} ticks (gametics ${overlapStart}..${overlapEnd})`, n >= TARGET_TICKS,
        `record=[${recordStartGamtic}..${recEnd}] replay=[${replayStartTic}..${repEnd}] (need >= ${TARGET_TICKS})`);

    let desynced = -1;
    for (let t = overlapStart; t <= overlapEnd; t++) {
        const ri = t - recordStartGamtic;
        const pi = t - replayStartTic;
        if (recordHashes[ri] !== replayHashes[pi]) { desynced = t; break; }
    }
    check(desynced < 0 ? `Tab B: ${n} ticks — recording and replay hash sequences IDENTICAL`
                       : `Tab B: sim DESYNC at gametic ${desynced} — ` +
                         `record=0x${recordHashes[desynced - recordStartGamtic].toString(16)} ` +
                         `replay=0x${replayHashes[desynced - replayStartTic].toString(16)}`,
          desynced < 0);

    await shot(tabB, 'demo-test-tabB.png');

    // ── Tab C: WAD ownership check ────────────────────────────────────────────

    // Construct a fragment URL with an unknown WAD.  The lobby should show
    // a warning and NOT boot the engine.
    const badWadB64url = b64url;  // same demo bytes, but wrong WAD name
    const badWadUrl = `${srvUrl}#demo=${encodeURIComponent(badWadB64url)}&wad=${encodeURIComponent('nonexistent.wad')}`;
    tabC = await chrome.tab(badWadUrl);
    await sleep(2500);

    await until(tabC, () => tabC.ev(`!!navigator.serviceWorker.controller`), 20000);
    await sleep(3000);   // let lobby.js run parseDemoUrl + ownership check

    const statusText = await tabC.ev(`document.getElementById('status')?.textContent ?? ''`);
    const warningShown = statusText.includes('nonexistent.wad') ||
                         statusText.includes('DEMO requires') ||
                         statusText.includes('own this WAD') ||
                         statusText.includes('you must own');
    check('Tab C: WAD ownership warning shown for missing WAD', warningShown,
        `status="${statusText.slice(0, 80)}"`);

    // Engine must NOT have booted (no webdoom object).
    const noBoot = await tabC.ev(`!window.webdoom`);
    check('Tab C: engine did NOT boot for missing WAD (ownership gate)', noBoot);

    await shot(tabC, 'demo-test-tabC.png');

    // ── Tab D: a demo the engine BOOTS for and then refuses ───────────────────
    //
    // Tab C covers the ownership gate, which refuses BEFORE booting.  This is
    // the other path and the one that was broken: the WAD is owned, so
    // enterGame boots the engine, and the failure happens in the `after`
    // callback when web_play_demo_buf rejects the header.  lobby.js handled
    // that by calling resetToLauncher(), which reset menu state and never
    // touched the DOM or the rAF loop -- so the launcher re-rendered into a
    // still-hidden #landing, the canvas stayed visible over it, the status
    // message explaining the failure was unreadable, window input listeners
    // kept feeding a live engine, and `booted` was false again, so a keypress
    // could boot a SECOND engine onto the same canvas.
    //
    // RED-PROOF: remove the endActiveSession(null) call from resetToLauncher
    // in client/js/lobby.js and the landing/canvas assertions below fail.
    {
        // A header the engine parses and refuses: version 42 is neither
        // VERSION nor 109.  Same shape as a real one so nothing earlier
        // rejects it.
        const bad = Buffer.alloc(18);
        bad[0] = 42; bad[1] = 2; bad[2] = 1; bad[3] = 1; bad[8] = 0; bad[9] = 1;
        bad[13] = 0x11; bad[14] = 0x22; bad[15] = 0x33; bad[16] = 0x44; bad[17] = 0x80;
        const badB64 = bad.toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const badUrl = `${srvUrl}#demo=${encodeURIComponent(badB64)}&wad=${encodeURIComponent('doom.wad')}`;
        // The session ends as soon as the replay is refused, and the page drops
        // window.webdoom with it, so a poll for the handle can miss the whole
        // session.  A setter installed before the page loads sees it published.
        tabD = await chrome.tab('about:blank');
        await tabD.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
            let wd; window.__published = 0;
            Object.defineProperty(window, 'webdoom', { configurable: true, get: () => wd,
                set: v => { wd = v; if (v && v.doom) window.__published++; } });
        })()` });
        await tabD.cdp('Page.navigate', { url: badUrl });
        await until(tabD, () => tabD.ev(`!!navigator.serviceWorker.controller`), 20000);
        // the engine has to boot and then fail, so give it the boot budget
        await tabD.waitFor(() => tabD.ev(`window.__published > 0`), { timeout: 90000, every: 250 });
        const booted = await tabD.ev(`window.__published > 0`);
        check('Tab D: the engine DID boot (this is the post-boot failure path, not the ownership gate)',
           booted);
        await sleep(3000);   // let the after-callback failure settle

        const landingHidden = await tabD.ev(`document.getElementById('landing')?.hidden ?? null`);
        check('Tab D: #landing is visible again after a refused replay', landingHidden === false,
           `landing.hidden=${landingHidden}`);

        const canvasHidden = await tabD.ev(`document.getElementById('screen')?.hidden ?? null`);
        check('Tab D: the canvas is hidden again', canvasHidden === true,
           `screen.hidden=${canvasHidden}`);

        const st = await tabD.ev(`window.__wdLastStatus ?? document.getElementById('status')?.textContent ?? ''`);
        check('Tab D: the failure is stated on the status line', /demo replay failed/i.test(String(st)),
           `status="${String(st).slice(0, 80)}"`);

        await shot(tabD, 'demo-test-tabD.png');
    }

} catch (err) {
    check(`unexpected error: ${err.message ?? err}`, false);
    console.error(err);
} finally {
    const anyErrors = [...(tabA?.errors ?? []), ...(tabB?.errors ?? []), ...(tabC?.errors ?? []), ...(tabD?.errors ?? [])];
    if (anyErrors.length)
        console.log('  page errors:', anyErrors.slice(0, 5).join('\n  '));
    // a run that stopped part way is not a pass, however clean its first steps
    summary('browser-demo: demo permalink record -> share -> replay', { min: 16 });
    process.exit();
}
