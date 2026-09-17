#!/usr/bin/env node
// Browser resilience tests: 5 failure-path subtests.
// usage: node tools/browser-resilience-test.mjs [url] [outdir]
//
// State-machine edge coverage (docs/state-machine.md):
//   T05 SP-LOADING → LANDING  (bootDoom rejects: WAD fetch / engine fail)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const chrome = await launchChrome();
const cleanup = code => { chrome.kill(); process.exit(code); };
const openTab = () => chrome.tab(url);

// Wait for lobby menu to be rendered
// Same contract as tools/lib/cdp.mjs's tab.waitForMenu: true, false on
// timeout, throw on an error status.  This file's callers already check it.
const waitForMenu = (tab, secs = 25) => tab.waitForMenu(secs);

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

// ═══════════════════════════════════════════════════════════════════════════
// 6. A WAD THIS CLIENT DOES NOT HAVE.
//    lobby.js's stackFor() returns [] for a WAD absent from the manifest, and
//    bootDoom then read wads[0].file -- a TypeError from inside the boot, AFTER
//    the landing page had been hidden and the canvas shown.  The only ownsWad
//    check was on the demo path; MP launch and spectate had none, and the
//    server accepted any wad name without checking its own library (H6).
//    Graceful = a named refusal, with the launcher still on screen.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('6-wad-this-client-lacks', async () => {
    const tab = await openTab();
    try {
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');

        const r = await tab.ev(`(async () => {
            const m = await import('/js/main.js');
            try { await m.bootDoom({ wads: [] }); return { threw: false }; }
            catch (e) { return { threw: true, name: e?.constructor?.name ?? '?', msg: String(e?.message ?? e) }; }
        })()`);
        assert(r?.threw, 'bootDoom resolved for a WAD stack this client does not have');
        assert(r.name !== 'TypeError',
            `refusal was a ${r.name}, not a stated reason: ${r.msg}`);
        assert(/WAD/i.test(r.msg), `refusal did not name the problem: ${r.msg}`);

        // The launcher must still be there -- the pre-fix path hid it first.
        const landingUp = await tab.ev(`document.getElementById('landing')?.hidden === false`);
        const canvasDown = await tab.ev(`document.getElementById('screen')?.hidden === true`);
        assert(landingUp, 'the landing page was hidden by a boot that never started');
        assert(canvasDown, 'the game canvas was shown by a boot that never started');

        // CONTROL: a NON-empty stack gets past this guard and fails further
        // in, on the fetch.  Without it, a bootDoom that refused everything
        // would satisfy the arm above.
        const ctl = await tab.ev(`(async () => {
            const m = await import('/js/main.js');
            try { await m.bootDoom({ wads: [{ file: 'no-such-file.wad', sha: 'deadbeef' }] }); return 'resolved'; }
            catch (e) { return String(e?.message ?? e); }
        })()`);
        assert(!/this browser has no copy/i.test(String(ctl)),
            `the guard fired on a non-empty stack too — it refuses everything: ${ctl}`);
    } finally { tab.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. THE SERVER ANSWERS, AND HAS NO IWAD.
//    /api/ui-assets 404s with PLAIN TEXT when wads/lib holds no IWAD -- an
//    ordinary, documented state.  doomfont.js called .json() with no res.ok
//    check, the SyntaxError landed in lobby.js's one catch, and the operator
//    was told "cannot reach server" about a server that was up and answering.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('7-server-has-no-iwad', async () => {
    const tab = await openTab();
    try {
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');

        // Answer /api/ui-assets exactly as the server does with no IWAD.
        tab.on('Fetch.requestPaused', p => {
            tab.cdp('Fetch.fulfillRequest', {
                requestId: p.requestId,
                responseCode: 404,
                responseHeaders: [{ name: 'content-type', value: 'text/plain; charset=utf-8' }],
                body: Buffer.from('no IWAD available').toString('base64'),
            });
        });
        await tab.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/ui-assets*' }] });
        // The service worker is network-first with a cache fallback for the
        // shell, and CDP's Fetch domain on a PAGE target does not see requests
        // the worker makes -- so without this the reload was served the real
        // payload and the probe measured nothing (it reported exactly that:
        // "no message at all").
        await tab.cdp('Network.enable', {});
        await tab.cdp('Network.setBypassServiceWorker', { bypass: true });
        await tab.cdp('Page.reload');

        let statusText = '';
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            statusText = (await tab.ev(`document.getElementById('status')?.textContent`)) ?? '';
            if (statusText.length > 0) break;
        }
        assert(statusText.length > 0, 'no message at all when the server has no IWAD');
        assert(/IWAD|ui-assets/i.test(statusText),
            `the reason was not named — the operator is told "${statusText}" about a server that answered`);
        assert(!/^cannot reach server$/i.test(statusText),
            'still reporting an unreachable server for one that answered 404');
        // THIS ONE IS LOAD-BEARING.  Without it the arm above passed against
        // the unfixed tree: .json() on a plain-text 404 throws
        //   Unexpected token 'n', "no IWAD a"... is not valid JSON
        // and the SERVER'S OWN BODY TEXT inside the parser's message satisfied
        // a search for "IWAD".  A message that happens to contain the right
        // word is not a message that says the right thing.
        assert(!/JSON|Unexpected token/i.test(statusText),
            `the message is a parser error, not a reason: "${statusText}"`);
    } finally { tab.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. A MENU SCREEN WITH NO ITEMS.
//    (sel + n - 1) % n is NaN when n === 0, sel stays NaN, and every later
//    render reads items[NaN] -- a menu with no cursor and no way to choose.
//    Reachable: mapPick() builds its list from entry(params.wad)?.maps ?? [],
//    so a lobby whose wad this client's manifest does not list opens WHICH
//    EPISODE? with nothing on it.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('8-empty-menu-screen', async () => {
    const tab = await openTab();
    try {
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');

        const r = await tab.ev(`(async () => {
            const [{ loadDoomFont }, { createMenu }] =
                await Promise.all([import('/js/doomfont.js'), import('/js/menu.js')]);
            const font = await loadDoomFont();
            const root = document.createElement('div');
            root.id = 'probe-menu';
            document.body.appendChild(root);
            const menu = createMenu(font, root, {});
            menu.reset({ title: 'EMPTY', items: [] });
            for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
                window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
            root.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }));
            // Now give it a real screen: a NaN cursor survives refresh(), whose
            // reset is \`if (sel >= items.length) sel = 0\` -- and NaN >= 2 is false.
            menu.refresh({ title: 'TWO', items: [{ label: 'A' }, { label: 'B' }] });
            return {
                selected: root.querySelectorAll('.row.sel').length,
                rows: root.querySelectorAll('.row').length,
            };
        })()`);
        assert(r?.rows >= 2, `the probe menu rendered ${r?.rows ?? 0} rows — nothing was measured`);
        assert(r.selected === 1,
            `${r.selected} of ${r.rows} rows selected after an empty screen — the cursor is NaN`);
    } finally { tab.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. THE DECODER MUST NOT CALL THE SHIPPED IWAD MALFORMED.
//    doomfont's column walk demanded TWO readable bytes before reading the
//    one-byte 0xff terminator, so a column whose terminator is the last byte
//    of the lump was flagged truncated -- 24 of doom.wad's 63 STCFN glyphs,
//    measured.  No pixels were lost, and nothing read the flag, so it was
//    wrong on every boot for the life of the project; round 6's "degrade
//    loudly" change surfaced it on the first run.
//    Both arms, because "no warning" is also what a decoder that stopped
//    checking produces.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('9-ui-lumps-decode-clean', async () => {
    const tab = await openTab();
    try {
        if (!await waitForMenu(tab)) throw new Error('menu did not appear');
        const bad = tab.warnings.filter(w => /truncated/i.test(w));
        assert(bad.length === 0,
            `${bad.length} truncation warning(s) decoding the server's own IWAD: ${bad[0] ?? ''}`);
    } finally { tab.close(); }

    // ARM B: a genuinely truncated lump must still be reported.  The payload is
    // the REAL one with a single lump chopped, so the only difference between
    // the arms is the data.
    const real = await (await fetch(new URL('/api/ui-assets', url))).json();
    // It has to be a lump the launcher CERTAINLY decodes.  STCFN glyphs are
    // decoded lazily through a per-character cache, so chopping '!' produced
    // no warning and the arm read as a failure of the decoder rather than of
    // the choice of victim.  M_DOOM is the logo: createMenu decodes it at
    // construction, every boot.
    const victim = ['M_DOOM', 'M_SKULL1', 'M_SKULL2']
        .find(k => typeof real.lumps[k] === 'string');
    assert(victim, '/api/ui-assets carried none of the always-decoded lumps — arm B measured nothing');
    const raw = Buffer.from(real.lumps[victim], 'base64');
    real.lumps[victim] = raw.subarray(0, Math.max(9, raw.length >> 1)).toString('base64');
    const body = Buffer.from(JSON.stringify(real)).toString('base64');

    const tab2 = await openTab();
    try {
        tab2.on('Fetch.requestPaused', p => {
            tab2.cdp('Fetch.fulfillRequest', {
                requestId: p.requestId,
                responseCode: 200,
                responseHeaders: [{ name: 'content-type', value: 'application/json' }],
                body,
            });
        });
        await tab2.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/ui-assets*' }] });
        await tab2.cdp('Network.enable', {});
        await tab2.cdp('Network.setBypassServiceWorker', { bypass: true });
        await tab2.cdp('Page.reload');
        let fired = false;
        for (let i = 0; i < 40 && !fired; i++) {
            await sleep(500);
            fired = tab2.warnings.some(w => /truncated/i.test(w));
        }
        assert(fired, `CONTROL: a chopped ${victim} produced no truncation warning — `
                    + 'the check above is observing silence, not correctness');
    } finally { tab2.close(); }
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
    console.log(`PASS — all ${results.length} resilience paths graceful`);
    cleanup(0);
} else {
    console.log('FAIL — one or more resilience paths not graceful');
    cleanup(1);
}
