#!/usr/bin/env node
// Browser resilience tests: one check per failure path.
// usage: node tools/browser-resilience-test.mjs [url]
//
// State-machine edge coverage (docs/state-machine.md):
//   T05 SP-LOADING → LANDING  (bootDoom rejects: WAD fetch / engine fail)
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary } from './lib/report.mjs';
import { pngStats } from './png-stats.mjs';

const url = process.argv[2] ?? (await startServer()).url;
const chrome = await launchChrome();

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function runTest(name, fn) {
    console.log(`\n[TEST] ${name}`);
    try { await fn(); check(name, true); }
    catch (err) { check(name, false, err.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. WAD fetch failure — intercept at network layer so both page and SW
//    requests are blocked; graceful = error shown + menu/landing restored.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('1-wad-fetch-failure', async () => {
    const tab = await chrome.tab(url);
    try {
        // Wait for the lobby menu first (so /api/wads can complete before we block)
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');

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
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');

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
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');
        if (!await tab.bootSP(60)) throw new Error('game did not boot');
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
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');
        if (!await tab.bootSP(60)) throw new Error('game did not boot');
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
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');

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
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');

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
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');

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
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');

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
//    measured.  No pixels are lost, but a decoder that flags a good font
//    warns on every boot.
//    Both arms, because "no warning" is also what a decoder that stopped
//    checking produces.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('9-ui-lumps-decode-clean', async () => {
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');
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

    const tab2 = await chrome.tab(url);
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

// ═══════════════════════════════════════════════════════════════════════════
// 10. AN OVERSIZED FILE IN THE BROWSER'S SAVE STORE.
//     persist.js hands every stored file to the engine before it boots.  A
//     20 MB .doomrc (nothing webdoom writes; anything with the origin's
//     storage can) made every boot abort until the store was cleared by hand.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('10-oversized-stored-config', async () => {
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');
        await tab.ev(`(async () => {
            const d = await new Promise((res, rej) => { const r = indexedDB.open('webdoom', 1);
                r.onupgradeneeded = () => r.result.createObjectStore('files');
                r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            await new Promise(res => { const t = d.transaction('files', 'readwrite');
                t.objectStore('files').put(new Uint8Array(20 * 1024 * 1024).fill(32), 'config:.doomrc');
                t.oncomplete = res; });
            d.close(); })()`);
        await tab.cdp('Page.reload');
        await sleep(1000);
        if (!await tab.waitForMenu()) throw new Error('menu did not appear after reload');
        const ok = await tab.bootSP(60).catch(e => { throw new Error(String(e.message ?? e)); });
        assert(ok, 'the game did not boot with an oversized config in the store');
    } finally { tab.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 11-12. A LOST WEBGL CONTEXT.
//     A GPU reset, a driver update or the browser reclaiming memory takes the
//     canvas's context away.  The game must run on through it, draw again
//     once the context is restored, and a boot onto a context that is still
//     lost must not throw.  WEBGL_lose_context does both halves on demand.
//     A lost canvas goes on SHOWING its last frame, so "drawn" alone cannot
//     tell a restored renderer from a dead one: while the context is lost the
//     engine's menu is opened (Escape), and after the restore the canvas must
//     be drawn AND differ from that stale frame.
// ═══════════════════════════════════════════════════════════════════════════
const canvasShot = async tab => {
    const r = await tab.ev(`(() => { const b = document.getElementById('screen').getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    if (!r || r.width < 10 || r.height < 10) throw new Error(`the canvas has no area to capture (${JSON.stringify(r)})`);
    const { result } = await tab.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
    return { data: result.data, ...pngStats(Buffer.from(result.data, 'base64')) };
};
const gametic = tab => tab.ev(`window.webdoom?.doom?._web_gametic?.() ?? -1`);
// kept on the page, because the context can only hand out the extension while
// it is alive, and the restore needs the same object that lost it
const loseContext = tab => tab.ev(`(() => {
    const ext = document.getElementById('screen').getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    window.__lc = ext; ext.loseContext(); return true; })()`);
const contextLost = tab => tab.ev(`document.getElementById('screen').getContext('webgl2')?.isContextLost() ?? null`);
const DRAWN = 5;    // percent of the canvas not its dominant colour

// Restore, then require a frame that is drawn and is not the stale one.
async function restoredAndDrawn(tab, stale) {
    await tab.ev(`window.__lc.restoreContext()`);
    await sleep(1000);
    const after = await canvasShot(tab);
    console.log(`  after the restore: ${after.variedPct}% of the canvas drawn, ${after.colours} colours, `
              + `${after.data === stale.data ? 'IDENTICAL to' : 'differs from'} the frame shown while lost; `
              + `context lost: ${await contextLost(tab)}`);
    assert(after.variedPct >= DRAWN, `the canvas is undrawn after the restore (${after.variedPct}%)`);
    assert(after.data !== stale.data, 'the canvas still shows the frame from before the loss: nothing drew after the restore');
}

await runTest('11-webgl-context-lost-mid-game', async () => {
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');
        if (!await tab.bootSP(60)) throw new Error('game did not boot');
        await sleep(1500);
        const before = await canvasShot(tab);
        console.log(`  before the loss: ${before.variedPct}% of the canvas drawn, ${before.colours} colours`);
        assert(before.variedPct >= DRAWN, `CONTROL: a running game reads as drawn (${before.variedPct}% < ${DRAWN}%)`);

        if (!await loseContext(tab)) throw new Error('WEBGL_lose_context is unavailable: nothing to test with');
        await sleep(300);
        assert(await contextLost(tab) === true, 'loseContext() did not lose the context');
        const stale = await canvasShot(tab);
        const t0 = await gametic(tab);
        await tab.esc();                    // the engine's menu, drawn only once the context is back
        await sleep(1000);
        const t1 = await gametic(tab);
        const stillStale = await canvasShot(tab);
        console.log(`  while lost: gametic ${t0} -> ${t1}; the canvas `
                  + `${stillStale.data === stale.data ? 'kept' : 'changed from'} its last frame across Escape`);
        assert(t1 > t0 + 10, `the game stopped while the context was lost (gametic ${t0} -> ${t1})`);
        assert(stillStale.data === stale.data, 'CONTROL: the canvas changed while its context was lost');

        await restoredAndDrawn(tab, stale);
        const t2 = await gametic(tab);
        assert(t2 > t1, `the game stopped after the restore (gametic ${t1} -> ${t2})`);
        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally { tab.close(); }
});

await runTest('12-boot-onto-a-lost-webgl-context', async () => {
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');
        if (!await tab.bootSP(60)) throw new Error('game did not boot');
        await sleep(500);
        if (!await loseContext(tab)) throw new Error('WEBGL_lose_context is unavailable: nothing to test with');
        await sleep(300);
        assert(await contextLost(tab) === true, 'loseContext() did not lose the context');
        await tab.ev(`window.webdoom?.doom?.onQuit?.()`);
        if (!await tab.waitForMenu()) throw new Error('the launcher did not come back after the quit');

        // the context is still lost: this boot must come up and run, not throw
        const booted = await tab.bootSP(60).catch(e => { throw new Error(`the second boot failed: ${e.message}`); });
        assert(booted, 'the second boot never started a game');
        assert(await contextLost(tab) === true, 'CONTROL: the second boot ran on a context that was not lost');
        const t0 = await gametic(tab);
        await tab.esc();
        await sleep(1000);
        const t1 = await gametic(tab);
        console.log(`  booted onto a lost context: gametic ${t0} -> ${t1} in 1 s`);
        assert(t1 > t0 + 10, `the second boot is not running (gametic ${t0} -> ${t1})`);
        await restoredAndDrawn(tab, await canvasShot(tab));
        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally { tab.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 13-14. AN INDEXEDDB CONNECTION NOBODY CLOSES.
//     An open connection blocks every later version change of its database,
//     in this tab and any other.  Two ways one used to stay open: an open
//     reported blocked that succeeded afterwards, and a persisted read that
//     threw before the connection was closed; and a connection that is open
//     on purpose did not give way when another open asked for a version
//     change.  Each probe enters through the shipped modules
//     (import('/js/idb.js'), the boot's loadPersisted), counts the connections
//     still open by wrapping open/close, and asks for a version change.  The
//     one on the real 'webdoom' database is aborted at upgradeneeded, so the
//     store stays at version 1.
// ═══════════════════════════════════════════════════════════════════════════
// installed in the page by each probe: connections opened from here on, and
// not yet closed
const TALLY = `(() => {
    if (window.__idbLive) return window.__idbLive;
    const live = window.__idbLive = new Set();
    const open = IDBFactory.prototype.open, close = IDBDatabase.prototype.close;
    IDBFactory.prototype.open = function (...a) {
        const q = open.apply(this, a);
        q.addEventListener('success', () => live.add(q.result));
        return q;
    };
    IDBDatabase.prototype.close = function () { live.delete(this); return close.call(this); };
    return live;
})()`;
// how a raw open of a newer version is decided; an upgrade is aborted.
// nameExpr is a page-side expression.
const VERSION_CHANGE = (nameExpr, v) => `new Promise(res => {
    const q = indexedDB.open(${nameExpr}, ${v});
    const timer = setTimeout(() => res('timeout'), 3000);
    q.onblocked = () => { clearTimeout(timer); res('blocked'); };
    q.onupgradeneeded = () => { clearTimeout(timer); q.transaction.abort(); res('not blocked'); };
    q.onsuccess = () => q.result.close();
    q.onerror = e => e.preventDefault();
})`;

await runTest('13-idb-connections-give-way', async () => {
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');
        const r = await tab.ev(`(async () => {
            const live = ${TALLY};
            const { openDB } = await import('/js/idb.js');
            const name = 'webdoom-probe-' + Math.random().toString(36).slice(2);
            const verdict = p => Promise.race([
                p.then(db => db, e => /blocked/.test(e?.message) ? 'blocked' : 'error: ' + e?.message),
                new Promise(r => setTimeout(() => r('timeout'), 3000))]);
            // a v1 connection with no versionchange handler: it holds on
            const holder = await new Promise((res, rej) => {
                const q = indexedDB.open(name, 1);
                q.onupgradeneeded = () => q.result.createObjectStore('s');
                q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
            const v2 = await verdict(openDB(name, 2, ['s']));
            holder.close();
            await new Promise(r => setTimeout(r, 500));     // the blocked open completes now
            const leaked = live.size;
            // a connection its caller is still using must give way
            const held = await verdict(openDB(name, 3, ['s']));
            const v4 = typeof held === 'string' ? 'not tried' : await ${VERSION_CHANGE('name', 4)};
            for (const d of live) d.close();
            indexedDB.deleteDatabase(name);
            return { v2: typeof v2 === 'string' ? v2 : 'opened', leaked,
                     held: typeof held === 'string' ? held : 'opened', v4 };
        })()`);
        console.log(`  v2 open beside a v1 holder: ${r?.v2}; connections left open once it closed: ${r?.leaked}; `
                  + `v3 open: ${r?.held}; v4 open beside that v3 connection: ${r?.v4}`);
        assert(r?.v2 === 'blocked', `CONTROL: the v2 open beside a v1 holder was not blocked (${r?.v2})`);
        assert(r?.leaked === 0, `${r?.leaked} connection(s) still open: the blocked v2 open succeeded later and `
                              + 'nothing closed what it returned');
        assert(r?.held === 'opened', `the v3 open was refused (${r?.held})`);
        assert(r?.v4 === 'not blocked', `a version change beside an open connection was ${r?.v4}: `
                                      + 'the connection did not close when asked');
    } finally { tab.close(); }
});

await runTest('14-idb-failed-persisted-read-closes', async () => {
    const tab = await chrome.tab(url);
    try {
        if (!await tab.waitForMenu()) throw new Error('menu did not appear');
        const r = await tab.ev(`(async () => {
            const live = ${TALLY};
            const { loadPersisted } = await import('/js/persist.js');
            const get = IDBObjectStore.prototype.get;
            let fired = 0;
            IDBObjectStore.prototype.get = function () {
                IDBObjectStore.prototype.get = get; fired++; throw new Error('synthetic read failure'); };
            try { await loadPersisted('doom.wad'); } finally { IDBObjectStore.prototype.get = get; }
            const leaked = live.size;
            const v2 = await ${VERSION_CHANGE(`'webdoom'`, 2)};
            return { fired, leaked, v2 };
        })()`);
        console.log(`  a persisted read threw ${r?.fired} time(s); connections left open: ${r?.leaked}; `
                  + `a version-2 open of 'webdoom' afterwards: ${r?.v2}`);
        assert(r?.fired === 1, `CONTROL: the injected read failure fired ${r?.fired} times, not once`);
        assert(r?.leaked === 0, `the boot's failed read left ${r?.leaked} connection(s) open`);
        assert(r?.v2 === 'not blocked', `the version-2 open was ${r?.v2}: the boot's connection blocks it`);
    } finally { tab.close(); }
});

// ── Results ───────────────────────────────────────────────────────────────────
console.log('\n── resilience results ──────────────────────────────────────');
summary('every resilience path graceful', { min: 14 });
process.exit();
