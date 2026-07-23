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
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const srvUrl  = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir  = process.argv[3] ?? '/tmp';
const CDP_PORT = 9272;
const TARGET_TICKS = 50;   // 13 + 50*4 + 1 = 214 bytes — well below FRAGMENT_MAX=6000

const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required',
    // Prevent Chrome from throttling rAF to 0fps in background/second tabs.
    // Without these flags Tab B's requestAnimationFrame never fires (headless
    // multi-tab backgrounding), so _replayDone is never set → 90s timeout.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
], { stdio: 'ignore' });
const cleanup = code => { chrome.kill(); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);

// ── CDP helpers ───────────────────────────────────────────────────────────────

async function openTab(url) {
    const target = await (await fetch(
        `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
        { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let _id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown')
            errors.push(m.params.exceptionDetails?.text ?? JSON.stringify(m.params));
        // Capture console.error / warn output so main.js wasm-abort catch is visible.
        if (m.method === 'Runtime.consoleAPICalled' &&
            (m.params.type === 'error' || m.params.type === 'warning')) {
            const text = m.params.args?.map(a => a.value ?? a.description ?? '').join(' ');
            errors.push(`[console.${m.params.type}] ${text}`);
        }
        // Chrome Log domain: captures browser-generated errors (network, wasm trap, etc.).
        if (m.method === 'Log.entryAdded' &&
            (m.params.entry?.level === 'error' || m.params.entry?.level === 'warning')) {
            errors.push(`[Log.${m.params.entry.level}] ${m.params.entry.text}`);
        }
    };
    const cdp = (method, params = {}) => new Promise(res => {
        const i = ++_id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Log.enable');
    const eval_ = async expr => (await cdp('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    })).result?.result?.value;
    const click = async label => {
        for (let i = 0; i < 20; i++) {
            const ok = await eval_(
                `(() => { const r = document.querySelector('#dmenu .row[data-label*=${JSON.stringify(label)}]');
                          return r ? (r.click(), true) : false; })()`);
            if (ok) return true;
            await sleep(300);
        }
        return false;
    };
    const shot = async file => {
        const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(outdir, file), Buffer.from(result.data, 'base64'));
    };
    return { cdp, eval: eval_, click, shot, errors };
}

// Poll until fn() returns truthy or timeout.
async function waitFor(fn, timeoutMs = 60000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const v = await fn();
        if (v) return v;
        await sleep(intervalMs);
    }
    throw new Error('waitFor timed out');
}

// ── Test assertions ───────────────────────────────────────────────────────────

let passes = 0;
let failures = 0;
const fail = msg => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = msg => { passes++;  console.log(`  PASS  ${msg}`); };
function ok(label, cond, detail = '') {
    if (cond) pass(label);
    else       fail(`${label}${detail ? ' — ' + detail : ''}`);
}

// ── Main test body ────────────────────────────────────────────────────────────

console.log('\n── browser-demo-test: record → fragment URL → replay hash check ────');

let tabA, tabB, tabC;
try {
    // ── Tab A: wait for SW, navigate SINGLE PLAYER → RECORD & SHARE… → game ──

    tabA = await openTab(srvUrl);
    await sleep(2500);

    // Wait for service worker to control the page.
    await waitFor(() => tabA.eval(`!!navigator.serviceWorker.controller`), 20000);

    // Navigate: SINGLE PLAYER → RECORD & SHARE… → doom.wad game entry.
    // (Game row click now boots immediately; RECORD & SHARE is a separate item.)
    const spOk = await tabA.click('SINGLE PLAYER');
    ok('Tab A: SINGLE PLAYER menu item found', spOk);

    // Wait for SP game list, then click the RECORD & SHARE… item.
    await sleep(500);
    const recOk = await waitFor(async () => {
        const hit = await tabA.eval(
            `(() => { const r = document.querySelector('#dmenu .row[data-label*="RECORD"]');
                      return r ? (r.click(), true) : false; })()`);
        return hit;
    }, 10000, 300);
    ok('Tab A: RECORD & SHARE item clicked', recOk);

    // Wait for record-picker list, then click doom.wad's entry.
    await sleep(400);
    const doomOk = await waitFor(async () => {
        // Try common title strings for doom.wad
        for (const label of ['DOOM', 'ULTIMATE DOOM', 'THE ULTIMATE DOOM', 'ULTIMATE DOOM (V1.9)']) {
            const hit = await tabA.eval(
                `(() => { const r = document.querySelector('#dmenu .row[data-label*=${JSON.stringify(label)}]');
                          return r ? (r.click(), true) : false; })()`);
            if (hit) return true;
        }
        return false;
    }, 10000, 500);
    ok('Tab A: doom.wad game entry clicked (record picker)', doomOk);

    // Wait for bootDoom to complete: window.webdoom must be set.
    await waitFor(() => tabA.eval(`typeof window.webdoom?.doom?._web_demo_stop === 'function'`), 60000, 500);
    pass('Tab A: bootDoom complete, demo bridge available');

    // Set up frame hook BEFORE enabling singletics.
    // The hook collects per-tic hashes and auto-stops recording after TARGET_TICKS.
    // _recordStartTic is captured so Tab B can wait for the same gametic before
    // collecting — web_state_hash includes the absolute gametic value, so the
    // sequences must be compared at matching gametic positions.
    await tabA.eval(`
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
    pass('Tab A: frame hook + singletics installed');

    // Wait for TARGET_TICKS to be collected.
    await waitFor(() => tabA.eval(`window._demoStopped`), 30000, 200);
    pass(`Tab A: ${TARGET_TICKS} ticks recorded, demo stopped`);

    // Verify demo byte count.
    const demoSize = await tabA.eval(`window._demoByteCount`);
    const expectedMin = 13 + TARGET_TICKS * 4 + 1;   // header + ticks + marker
    ok(`Tab A: demo size >= ${expectedMin} bytes`, demoSize >= expectedMin, `size=${demoSize}`);

    // Collect the recording hash array and the starting gametic.
    // recordStartGamtic is passed to Tab B so it waits for the same gametic
    // before collecting — web_state_hash includes absolute gametic, so both
    // sequences must start at the same position to be comparable.
    const recordHashes = await tabA.eval(`window._recordHashes.slice()`);
    ok(`Tab A: collected ${TARGET_TICKS} record hashes`, recordHashes?.length >= TARGET_TICKS,
        `got=${recordHashes?.length}`);
    const recordStartGamtic = await tabA.eval(`window._recordStartTic ?? 0`);

    // Extract demo bytes from wasm heap as base64 for transport.
    const demoB64 = await tabA.eval(`
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
    ok('Tab A: demo bytes extracted', typeof demoB64 === 'string' && demoB64.length > 0,
        `b64 length=${demoB64?.length}`);

    // Generate the fragment URL (same algorithm as demo.js stopAndShare fragment path).
    // Convert base64 to base64url and construct the URL.
    const b64url = demoB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fragmentUrl = `${srvUrl}#demo=${encodeURIComponent(b64url)}&wad=${encodeURIComponent('doom.wad')}`;
    pass(`Tab A: fragment URL generated (${fragmentUrl.length} chars)`);

    await tabA.shot('demo-test-tabA.png');

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

    tabB = await openTab('about:blank');
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
    pass(`Tab B: replay hook pre-installed (start=${recordStartGamtic} end=${recordStartGamtic + TARGET_TICKS - 1})`);

    // Navigate to the fragment URL.  The pre-installed hook fires from frame 1.
    await tabB.cdp('Page.navigate', { url: fragmentUrl });
    await sleep(2000);
    await waitFor(() => tabB.eval(`!!navigator.serviceWorker.controller`), 20000);

    // Poll for window.webdoom.doom being available (bootDoom complete).
    await waitFor(() => tabB.eval(`typeof window.webdoom?.doom === 'object'`), 90000, 100);
    pass('Tab B: bootDoom complete, demo bridge available');

    // Diagnostic: gametic at this point.  With wipe_skip active from frame 1,
    // gametic should be advancing normally (> 1 and likely close to TARGET_TICKS).
    const tabBGameticAtBoot = await tabB.eval(`window.webdoom?.doom?._web_gametic?.() ?? -1`);
    console.log(`  [diag] Tab B gametic after bootDoom detect: ${tabBGameticAtBoot}`);

    // Wait for _replayDone.  Timeout is generous: WAD boot (~5 s) + replay to
    // the final expected gametic (~50/60 s ≈ 1 s).
    await waitFor(() => tabB.eval(`window._replayDone`), 90000, 200);
    pass(`Tab B: replay advanced to gametic ${recordStartGamtic + TARGET_TICKS - 1}`);

    const replayHashes   = await tabB.eval(`window._replayHashes.slice()`);
    const replayStartTic = await tabB.eval(`window._replayStartTic ?? ${recordStartGamtic}`);
    ok(`Tab B: collected ${replayHashes?.length} replay hashes`, (replayHashes?.length ?? 0) > 0);

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
    ok(`Tab B: overlap window is ${n} ticks (gametics ${overlapStart}..${overlapEnd})`, n >= TARGET_TICKS,
        `record=[${recordStartGamtic}..${recEnd}] replay=[${replayStartTic}..${repEnd}] (need >= ${TARGET_TICKS})`);

    let desynced = -1;
    for (let t = overlapStart; t <= overlapEnd; t++) {
        const ri = t - recordStartGamtic;
        const pi = t - replayStartTic;
        if (recordHashes[ri] !== replayHashes[pi]) { desynced = t; break; }
    }
    if (desynced >= 0) {
        fail(`Tab B: sim DESYNC at gametic ${desynced} — ` +
             `record=0x${recordHashes[desynced - recordStartGamtic].toString(16)} ` +
             `replay=0x${replayHashes[desynced - replayStartTic].toString(16)}`);
    } else {
        pass(`Tab B: ${n} ticks — recording and replay hash sequences IDENTICAL`);
    }

    await tabB.shot('demo-test-tabB.png');

    // ── Tab C: WAD ownership check ────────────────────────────────────────────

    // Construct a fragment URL with an unknown WAD.  The lobby should show
    // a warning and NOT boot the engine.
    const badWadB64url = b64url;  // same demo bytes, but wrong WAD name
    const badWadUrl = `${srvUrl}#demo=${encodeURIComponent(badWadB64url)}&wad=${encodeURIComponent('nonexistent.wad')}`;
    tabC = await openTab(badWadUrl);
    await sleep(2500);

    await waitFor(() => tabC.eval(`!!navigator.serviceWorker.controller`), 20000);
    await sleep(3000);   // let lobby.js run parseDemoUrl + ownership check

    const statusText = await tabC.eval(`document.getElementById('status')?.textContent ?? ''`);
    const warningShown = statusText.includes('nonexistent.wad') ||
                         statusText.includes('DEMO requires') ||
                         statusText.includes('own this WAD') ||
                         statusText.includes('you must own');
    ok('Tab C: WAD ownership warning shown for missing WAD', warningShown,
        `status="${statusText.slice(0, 80)}"`);

    // Engine must NOT have booted (no webdoom object).
    const noBoot = await tabC.eval(`!window.webdoom`);
    ok('Tab C: engine did NOT boot for missing WAD (ownership gate)', noBoot);

    await tabC.shot('demo-test-tabC.png');

} catch (err) {
    fail(`unexpected error: ${err.message ?? err}`);
    console.error(err);
} finally {
    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n  ${passes} passed, ${failures} failed`);
    const anyErrors = [...(tabA?.errors ?? []), ...(tabB?.errors ?? []), ...(tabC?.errors ?? [])];
    if (anyErrors.length)
        console.log('  page errors:', anyErrors.slice(0, 5).join('\n  '));
    cleanup(failures ? 1 : 0);
}
