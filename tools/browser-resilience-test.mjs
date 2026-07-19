#!/usr/bin/env node
// Browser resilience tests: 5 failure-path subtests.
// usage: node tools/browser-resilience-test.mjs [url] [outdir]
//
// State-machine edge coverage (docs/state-machine.md):
//   T05 SP-LOADING → LANDING  (bootDoom rejects: WAD fetch / engine fail)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const CDP_PORT = 9224;

const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

const cleanup = code => { chrome.kill(); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);

// ── CDP helper ────────────────────────────────────────────────────────────────

async function openTab() {
    const target = await (await fetch(
        `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
        { method: 'PUT' },
    )).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const errors = [];
    const evHandlers = new Map();

    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
        if (msg.method === 'Runtime.exceptionThrown')
            errors.push(
                msg.params.exceptionDetails?.exception?.description
                ?? msg.params.exceptionDetails?.text
                ?? '?',
            );
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
            errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
        const h = evHandlers.get(msg.method);
        if (h) h(msg.params);
    };

    const cdp = (method, params = {}) => new Promise(res => {
        const i = ++msgId;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async expr =>
        (await cdp('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true,
        })).result?.result?.value;

    await cdp('Runtime.enable');
    await cdp('Page.enable');

    return { cdp, ev, errors, on(m, h) { evHandlers.set(m, h); }, close() { ws.close(); } };
}

// Wait for lobby menu to be rendered
async function waitForMenu(tab, secs = 25) {
    for (let i = 0; i < secs * 2; i++) {
        const ready = await tab.ev(
            `!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`,
        );
        if (ready) return true;
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        if (s?.startsWith('cannot')) throw new Error(`lobby: ${s}`);
        await sleep(500);
    }
    return false;
}

// Click through SP menu and wait until engine canvas is live
async function bootIntoGame(tab, secs = 60) {
    let clicked = false;
    for (let i = 0; i < secs * 2; i++) {
        await sleep(500);
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        if (s?.startsWith('Error') || s?.startsWith('cannot') || s?.startsWith('engine error'))
            throw new Error(`boot error: ${s}`);
        if (!clicked) {
            clicked = await tab.ev(`(() => {
                const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
                if (!sp) return false;
                sp.click();
                const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]')
                       || document.querySelector('#dmenu .row[data-label*="DOOM"]');
                if (!g) return false;
                g.click();
                return true;
            })()`);
            continue;
        }
        const running = await tab.ev(
            `!document.getElementById('screen').hidden && document.getElementById('status')?.textContent === ''`,
        );
        if (running) return true;
    }
    return false;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const results = [];
async function runTest(name, fn) {
    console.log(`\n[TEST] ${name}`);
    try {
        await fn();
        results.push({ name, passed: true });
        console.log(`  PASS`);
    } catch (err) {
        results.push({ name, passed: false, reason: err.message });
        console.log(`  FAIL: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. WAD fetch failure — intercept at network layer so both page and SW
//    requests are blocked; graceful = error shown + menu/landing restored.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('1-wad-fetch-failure', async () => {
    const tab = await openTab();
    try {
        // Wait for the lobby menu first (so /api/wads can complete before we block)
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');

        // Block WAD file requests at the network layer AFTER the manifest has
        // loaded.  Pattern */wads/* matches /wads/doom.wad but NOT /api/wads.
        await tab.cdp('Network.enable', {});
        await tab.cdp('Network.setBlockedURLs', { urls: ['*/wads/*'] });

        // Click SP → first game (WAD fetch will now be blocked)
        await tab.ev(`(() => {
            const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
            if (sp) sp.click();
        })()`);
        await sleep(600);
        await tab.ev(`(() => {
            const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]')
                   || document.querySelector('#dmenu .row[data-label*="DOOM"]');
            if (g) g.click();
        })()`);

        // Wait up to 15 s for the error to surface
        let statusText = '';
        let landingVisible = null;
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            statusText = (await tab.ev(`document.getElementById('status')?.textContent`)) ?? '';
            if (statusText.length > 0) {
                landingVisible = await tab.ev(`!document.getElementById('landing').hidden`);
                break;
            }
        }

        // Graceful: readable error AND menu/landing restored (not blank canvas)
        assert(statusText.length > 0, 'no error message shown after WAD fetch failure');
        assert(
            landingVisible === true,
            'landing/menu hidden after WAD failure — user stuck on blank canvas',
        );
        // No fatal uncaught exceptions (wad-fetch errors are expected)
        const fatal = tab.errors.filter(e =>
            !/wad fetch failed|Failed to fetch|ERR_BLOCKED/i.test(e),
        );
        assert(fatal.length === 0, `unexpected exceptions: ${fatal.join('; ')}`);

        // Retry: booted flag must be reset so SINGLE PLAYER re-invokes bootDoom.
        // Clear the status, click through again — since WAD is still blocked the
        // error must reappear, proving the menu is live and not stuck.
        await tab.ev(`document.getElementById('status').textContent = ''`);
        await tab.ev(`(() => {
            const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
            if (sp) sp.click();
        })()`);
        await sleep(400);
        await tab.ev(`(() => {
            const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]')
                   || document.querySelector('#dmenu .row[data-label*="DOOM"]');
            if (g) g.click();
        })()`);
        let retryStatus = '';
        for (let i = 0; i < 20; i++) {
            await sleep(500);
            retryStatus = (await tab.ev(`document.getElementById('status')?.textContent`)) ?? '';
            if (retryStatus.length > 0) break;
        }
        assert(
            retryStatus.length > 0,
            'retry: SINGLE PLAYER after WAD failure did not re-invoke bootDoom — booted flag not reset',
        );
    } finally {
        tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. SW update mid-session — synthetic controllerchange event; graceful =
//    client shows a "reload to update" notification without crashing.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('2-sw-update-mid-session', async () => {
    const tab = await openTab();
    try {
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');

        // Synthesise the event that fires when a new service worker takes control
        await tab.ev(`navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))`);
        await sleep(300);

        const notifyVisible = await tab.ev(
            `(() => { const el = document.getElementById('sw-update'); return el ? !el.hidden : false; })()`,
        );
        assert(
            notifyVisible === true,
            '#sw-update element missing or hidden — no reload-to-update affordance shown',
        );
        assert(tab.errors.length === 0, `exceptions after controllerchange: ${tab.errors.join('; ')}`);
    } finally {
        tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Tab hide / resume — visibilitychange events; graceful = no exceptions,
//    game still renders, audio context handled.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('3-tab-hide-resume', async () => {
    const tab = await openTab();
    try {
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');
        if (!await bootIntoGame(tab)) throw new Error('game did not boot');
        await sleep(500);

        // Arm audio via simulated user gesture
        await tab.cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
        await tab.cdp('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
        await sleep(200);

        // Dispatch visibilitychange → hidden
        await tab.ev(`
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        `);
        await sleep(1000);

        // Dispatch visibilitychange → visible
        await tab.ev(`
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        `);
        await sleep(400);

        assert(tab.errors.length === 0, `exceptions during hide/resume: ${tab.errors.join('; ')}`);
        const canvasVisible = await tab.ev(`!document.getElementById('screen').hidden`);
        assert(canvasVisible, 'game canvas hidden after tab resume');
    } finally {
        tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Gamepad hotplug — connect/disconnect events; graceful = no crash,
//    keyboard still works, padPrev reset on disconnect so edge fires on
//    reconnect.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('4-gamepad-hotplug', async () => {
    const tab = await openTab();
    try {
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');
        if (!await bootIntoGame(tab)) throw new Error('game did not boot');
        await sleep(600);

        // Intercept _web_input_event to count ESCAPE keydown events (EV_KEYDOWN=0, DK.ESCAPE=27)
        await tab.ev(`
            const d = window.webdoom?.doom;
            if (d?._web_input_event) {
                const orig = d._web_input_event.bind(d);
                window.__escapeCount = 0;
                d._web_input_event = function(t, a, b, c) {
                    if (t === 0 && a === 27) window.__escapeCount++;
                    return orig(t, a, b, c);
                };
            }
        `);

        // Override navigator.getGamepads with call counter to verify it works.
        await tab.ev(`
            window.__gpCallCount = 0;
            window.__fakeGp = {
                buttons: Array.from({ length: 17 }, (_, i) => ({
                    pressed: i === 9, touched: false, value: i === 9 ? 1 : 0,
                })),
                axes: [0, 0, 0, 0],
                id: 'fake-pad', connected: true, index: 0, timestamp: 1,
                mapping: 'standard', hapticActuators: [], vibrationActuator: null,
            };
            Object.defineProperty(Navigator.prototype, 'getGamepads', {
                configurable: true, writable: true,
                value() { window.__gpCallCount++; return [window.__fakeGp, null, null, null]; },
            });
        `);
        await tab.ev(`window.dispatchEvent(new Event('gamepadconnected'))`);
        await sleep(400); // rAF frames → pollGamepad → button 9 → ESCAPE

        const gpCallCount = await tab.ev(`window.__gpCallCount ?? 0`);
        const gpWorking = gpCallCount > 0;
        // The override MUST have taken effect — if not, the padPrev reset test
        // would silently skip via the fallback path and give a false green.
        assert(gpWorking === true, `getGamepads override did not take effect (calls: ${gpCallCount}) — padPrev reset cannot be verified`);

        const escapeAfterConnect = await tab.ev(`window.__escapeCount ?? 0`);

        // Override and interception both confirmed working — test padPrev reset.

        // Disconnect: null gamepad, dispatch event → fix resets padPrev → 0
        await tab.ev(`
            Object.defineProperty(Navigator.prototype, 'getGamepads', {
                configurable: true, writable: true,
                value() { window.__gpCallCount++; return [null, null, null, null]; },
            });
        `);
        await tab.ev(`window.dispatchEvent(new Event('gamepaddisconnected'))`);
        await sleep(200);
        const escapeAtDisconnect = await tab.ev(`window.__escapeCount ?? 0`);

        // Reconnect with button 9 still held — edge must re-fire (padPrev was 0)
        await tab.ev(`
            Object.defineProperty(Navigator.prototype, 'getGamepads', {
                configurable: true, writable: true,
                value() { window.__gpCallCount++; return [window.__fakeGp, null, null, null]; },
            });
        `);
        await tab.ev(`window.dispatchEvent(new Event('gamepadconnected'))`);
        await sleep(400);
        const escapeAfterReconnect = await tab.ev(`window.__escapeCount ?? 0`);

        assert(
            escapeAfterReconnect > escapeAtDisconnect,
            'ESCAPE did not re-fire after reconnect — padPrev not reset on gamepaddisconnected',
        );

        // Keyboard must survive the gamepad traffic
        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);

        // Verify keyboard still works via CDP injection
        await tab.cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(100);
        await tab.cdp('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(200);
        assert(tab.errors.length === 0, `exceptions after keyboard test: ${tab.errors.join('; ')}`);
    } finally {
        tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Storage-quota errors — localStorage.setItem throws QuotaExceededError;
//    graceful = saveSettings swallows the error, app keeps running.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('5-storage-quota', async () => {
    const tab = await openTab();
    try {
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');

        // Patch localStorage.setItem to throw for webdoom keys
        await tab.ev(`
            Storage.prototype.__origSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key) {
                if (typeof key === 'string' && key.startsWith('webdoom'))
                    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                return Storage.prototype.__origSetItem.apply(this, arguments);
            };
        `);

        // Call saveSettings via dynamic import — must NOT propagate the exception
        const threw = await tab.ev(`
            (async () => {
                try {
                    const { saveSettings, defaultSettings } = await import('/js/input.js');
                    saveSettings(defaultSettings());
                    return false;
                } catch {
                    return true;
                }
            })()
        `);
        assert(!threw, 'saveSettings propagated QuotaExceededError — caller would white-screen');

        // Sub-case: getItem throws (private/disabled storage) — loadSettings must
        // return defaultSettings() without propagating, not crash the app on boot.
        await tab.ev(`
            Storage.prototype.__origGetItem = Storage.prototype.getItem;
            Storage.prototype.getItem = function(key) {
                if (typeof key === 'string' && key.startsWith('webdoom'))
                    throw new DOMException('SecurityError', 'Storage access denied');
                return Storage.prototype.__origGetItem.apply(this, arguments);
            };
        `);
        const loadThrew = await tab.ev(`
            (async () => {
                try {
                    const { loadSettings } = await import('/js/input.js');
                    const s = loadSettings();
                    // Must return a settings object with expected shape
                    return typeof s !== 'object' || typeof s.mouseSens !== 'number';
                } catch {
                    return true;
                }
            })()
        `);
        assert(!loadThrew, 'loadSettings propagated getItem error — boot would white-screen in private mode');
        // Restore getItem so later assertions aren't affected
        await tab.ev(`Storage.prototype.getItem = Storage.prototype.__origGetItem`);

        // No uncaught exceptions from the error path
        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);

        // Menu still visible — page hasn't crashed
        const menuVisible = await tab.ev(`!!document.querySelector('#dmenu .row')`);
        assert(menuVisible, 'menu disappeared after storage quota error');
    } finally {
        tab.close();
    }
});

// ── Results ───────────────────────────────────────────────────────────────────
console.log('\n── resilience results ──────────────────────────────────────');
let allPassed = true;
for (const r of results) {
    if (r.passed) {
        console.log(`  PASS  ${r.name}`);
    } else {
        console.log(`  FAIL  ${r.name}: ${r.reason}`);
        allPassed = false;
    }
}

if (allPassed) {
    console.log('PASS — all 5 resilience paths graceful');
    cleanup(0);
} else {
    console.log('FAIL — one or more resilience paths not graceful');
    cleanup(1);
}
