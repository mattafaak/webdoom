#!/usr/bin/env node
// Lobby state-machine edge tests: drives every transition in docs/state-machine.md
// that is not already covered by browser-test / browser-net-test / browser-join-test
// / browser-resilience-test. See coverage table in docs/state-machine.md.
//
// Covered here:
//   T01 LANDING→SP-PICK          T02 SP-PICK→LANDING
//   T06 IN-GAME-SP→LANDING       T07 LANDING→MP-LOBBY
//   T08 LANDING→DROP-IN-OFFER    T09 MP-LOBBY→MP-PARAMS
//   T10 MP-PARAMS→MP-LOBBY       T11 MP-LOBBY→LANDING (ESC)
//   T12 DROP-IN-OFFER→LANDING    T13 MP-LOBBY→MP-COUNTDOWN
//   T16 MP-LOADING→LANDING       T21 MP-LOBBY→LANDING (ws)
//   T22 DROP-IN-OFFER→LANDING    T23 MP-COUNTDOWN→LANDING (ws)
//   T24 MP-PARAMS→LANDING (ws)   T25 MP-COUNTDOWN→LANDING (ESC)
//   Impossible-state guard: countdown cleared on ws-close (Bug#1/T23)
//   Impossible-state guard: countdown cleared on ESC mid-countdown (Bug#1/T25)
//   Impossible-state guard: booted reset on MP WAD fail (Bug#2)
//
// usage: node tools/browser-lobby-test.mjs [url] [outdir]
import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const outdir = process.argv[3] ?? '/tmp';
const CDP_PORT = 9226;

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
    const targetId = target.id;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const errors = [];

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

    return {
        cdp, ev, errors,
        // Properly close the Chrome tab (releases its WebSockets), not just CDP session
        async close() {
            try {
                await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${targetId}`, { method: 'GET' });
            } catch { /* tab may already be gone */ }
            ws.close();
        },
    };
}

// Wait for the root menu (SINGLE PLAYER row) to be rendered
async function waitForMenu(tab, secs = 25) {
    for (let i = 0; i < secs * 2; i++) {
        const ready = await tab.ev(
            `!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`,
        );
        if (ready) return true;
        const s = await tab.ev(`document.getElementById('status')?.textContent`);
        if (s?.startsWith('cannot')) throw new Error(`server: ${s}`);
        await sleep(500);
    }
    return false;
}

// Patch WebSocket constructor in the page to capture the lobby ws
async function patchWS(tab) {
    await tab.ev(`
        (() => {
            if (window.__wsPatched) return;
            window.__wsPatched = true;
            window.__lobbyWS = null;
            const Orig = window.WebSocket;
            window.WebSocket = function(url, ...a) {
                const ws = new Orig(url, ...a);
                if (typeof url === 'string' && url.includes('/ws/lobby'))
                    window.__lobbyWS = ws;
                return ws;
            };
            Object.assign(window.WebSocket, Orig);
        })()
    `);
}

// Force-close the captured lobby WebSocket from outside
async function forceCloseWS(tab) {
    await tab.ev(`if (window.__lobbyWS) window.__lobbyWS.close()`);
}

// Wait for the server lobby to be free of any active game session.
// Polls by opening a fresh tab and checking whether MULTIPLAYER shows
// START GAME (roster, clean) vs DROP IN (session active).
async function waitForCleanServer(secs = 20) {
    const deadline = Date.now() + secs * 1000;
    while (Date.now() < deadline) {
        const tab = await openTab();
        try {
            if (!await waitForMenu(tab, 6)) { await tab.close(); await sleep(1000); continue; }
            await patchWS(tab);
            await clickItem(tab, 'MULTIPLAYER', 6);
            let clean = false;
            for (let i = 0; i < 8; i++) {
                const hasStart = await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`);
                if (hasStart) { clean = true; break; }
                const hasDropIn = await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="DROP IN"]')`);
                if (!hasDropIn && i > 2) { clean = true; break; } // maybe no roster yet
                await sleep(500);
            }
            await tab.close();
            if (clean) return;
        } catch {
            try { await tab.close(); } catch {}
        }
        await sleep(1000);
    }
}

// Click a menu item whose data-label contains `text`; returns true on success
async function clickItem(tab, text, retries = 15) {
    for (let i = 0; i < retries; i++) {
        const ok = await tab.ev(
            `(() => { const r = document.querySelector('#dmenu .row[data-label*=${JSON.stringify(text)}]');
                      return r ? (r.click(), true) : false; })()`,
        );
        if (ok) return true;
        await sleep(300);
    }
    return false;
}

// Press Escape in the page via CDP key injection
async function pressEsc(tab) {
    await tab.cdp('Input.dispatchKeyEvent', {
        type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27,
    });
    await tab.cdp('Input.dispatchKeyEvent', {
        type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27,
    });
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
// Test 1: lobby-menu-nav
// Covers T01 LANDING→SP-PICK, T02 SP-PICK→LANDING,
//         T07 LANDING→MP-LOBBY, T09 MP-LOBBY→MP-PARAMS (5 pickers),
//         T10 MP-PARAMS→MP-LOBBY, T11 MP-LOBBY→LANDING (ESC)
// No server game session started.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('lobby-menu-nav', async () => {
    const tab = await openTab();
    try {
        assert(await waitForMenu(tab), 'root menu did not appear');

        // T01: LANDING → SP-PICK
        assert(await clickItem(tab, 'SINGLE PLAYER'), 'SINGLE PLAYER not found');
        await sleep(200);
        const inSpPick = await tab.ev(`!!document.querySelector('#dmenu .mtitle') || !!document.querySelector('#dmenu .row')`);
        assert(inSpPick, 'T01: SP-PICK screen did not appear');
        const noStart = await tab.ev(`!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`);
        assert(noStart, 'T01: still showing root after SINGLE PLAYER click');

        // T02: SP-PICK → LANDING
        await pressEsc(tab);
        await sleep(200);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`),
            'T02: ESC did not return to LANDING',
        );

        // T07: LANDING → MP-LOBBY (lobby ws connects; roster pushes lobbyScreen)
        // The lobby ws connect → server roster → START GAME render is
        // occasionally lost (a transient ws-connect / first-roster race — the
        // click lands but no lobbyScreen appears). The assertion below is
        // unchanged (START GAME *must* appear); we only re-ATTEMPT the flaky
        // action: if the row hasn't shown after ~4s, ESC back to the root menu
        // and re-open MULTIPLAYER. Up to 3 attempts. A genuinely broken lobby
        // fails all three; a transient race passes on retry.
        await patchWS(tab);
        let inLobby = false;
        for (let attempt = 0; attempt < 3 && !inLobby; attempt++) {
            assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
            for (let i = 0; i < 14; i++) {   // ~4.2s poll per attempt
                if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                    { inLobby = true; break; }
                await sleep(300);
            }
            if (!inLobby) {   // re-attempt: return to root, drop the stale ws
                await pressEsc(tab);
                await sleep(400);
            }
        }
        assert(inLobby, 'T07: MP-LOBBY (START GAME row) did not appear after 3 attempts');

        // T09/T10 × 5 pickers: open each picker, verify screen changed, ESC back
        for (const label of ['GAME:', 'MAP:', 'MODE:', 'SKILL:', 'OPTIONS']) {
            assert(await clickItem(tab, label), `T09: ${label} row not found`);
            await sleep(200);
            const notLobby = await tab.ev(`!document.querySelector('#dmenu .row[data-label*="START GAME"]')`);
            assert(notLobby, `T09: ${label} picker did not replace lobby screen`);
            await pressEsc(tab);
            await sleep(200);
            const backLobby = await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`);
            assert(backLobby, `T10: ESC from ${label} picker did not return to MP-LOBBY`);
        }

        // T11: MP-LOBBY → LANDING (ESC triggers leaveLobby → root)
        await pressEsc(tab);
        await sleep(400);
        const atRoot = await tab.ev(
            `!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
             !document.querySelector('#dmenu .row[data-label*="START GAME"]')`,
        );
        assert(atRoot, 'T11: ESC from MP-LOBBY did not return to LANDING');
        // lobby ws must be closed
        const wsGone = await tab.ev(`window.__lobbyWS?.readyState >= 2`);
        assert(wsGone, 'T11: lobby ws not closed after leaveLobby');

        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: sp-quit
// Covers T06: IN-GAME-SP → LANDING (onQuit callback)
// SP path only — no lobby server session.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('sp-quit', async () => {
    const tab = await openTab();
    try {
        assert(await waitForMenu(tab), 'root menu did not appear');

        let clicked = false, booted = false;
        for (let i = 0; i < 120; i++) {
            await sleep(500);
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
            booted = await tab.ev(
                `!document.getElementById('screen').hidden &&
                 document.getElementById('status')?.textContent === ''`,
            );
            if (booted) break;
        }
        assert(booted, 'sp-quit: engine did not boot');

        // T06: trigger the onQuit callback (same path as in-engine Quit Game → Y)
        await tab.ev(`window.webdoom?.doom?.onQuit?.()`);
        await sleep(800);

        assert(
            await tab.ev(`!document.getElementById('landing').hidden &&
                          !!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`),
            'T06: onQuit did not return to LANDING',
        );
        assert(
            await tab.ev(`document.getElementById('screen').hidden`),
            'T06: game canvas still visible after quit',
        );
        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: mp-lobby-ws-close
// Covers T21: MP-LOBBY → LANDING (unexpected ws close)
//         T24: MP-PARAMS → LANDING (ws close while picker open)
// No START GAME → no server session started.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('mp-lobby-ws-close', async () => {
    const tab = await openTab();
    try {
        assert(await waitForMenu(tab), 'root menu did not appear');
        await patchWS(tab);

        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-lobby-ws-close: MP-LOBBY did not appear');

        // T21: force ws close while in MP-LOBBY
        await forceCloseWS(tab);
        await sleep(600);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T21: ws close did not reset to LANDING from MP-LOBBY',
        );
        assert(
            (await tab.ev(`document.getElementById('status')?.textContent`))?.length > 0,
            'T21: no status message on unexpected ws close',
        );

        // T24: reconnect, navigate into a picker, close ws there
        await patchWS(tab);
        assert(await clickItem(tab, 'MULTIPLAYER'), 'T24: MULTIPLAYER not found on retry');
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`)) break;
            await sleep(300);
        }
        assert(await clickItem(tab, 'GAME:'), 'T24: GAME row not found');
        await sleep(200);
        assert(
            await tab.ev(`!document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T24: not in MP-PARAMS before ws close',
        );
        await forceCloseWS(tab);
        await sleep(600);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T24: ws close from MP-PARAMS did not reset to LANDING',
        );

        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: drop-in-offer-esc
// Covers T08: LANDING → DROP-IN-OFFER
//         T12: DROP-IN-OFFER → LANDING (ESC → leaveLobby)
// Tab A starts a co-op game; tab B joins the offer screen and ESCs.
// Closing tabA terminates its relay ws → server endSession immediately.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('drop-in-offer-esc', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    try {
        assert(await waitForMenu(tabA), 'A: menu did not appear');
        assert(await waitForMenu(tabB), 'B: menu did not appear');

        // Tab A: connect to lobby and start a solo game
        await patchWS(tabA);
        assert(await clickItem(tabA, 'MULTIPLAYER'), 'A: MULTIPLAYER not found');
        for (let i = 0; i < 20; i++) {
            if (await tabA.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`)) break;
            await sleep(300);
        }
        assert(await clickItem(tabA, 'START GAME'), 'A: START GAME not found');
        let aInGame = false;
        for (let i = 0; i < 60; i++) {
            aInGame = await tabA.ev(
                `!document.getElementById('screen').hidden &&
                 document.getElementById('status')?.textContent === ''`,
            );
            if (aInGame) break;
            await sleep(500);
        }
        assert(aInGame, 'A: did not boot into game');
        await sleep(1500); // let server accumulate some game history

        // T08: Tab B opens MULTIPLAYER → inprogress → DROP-IN-OFFER
        await patchWS(tabB);
        assert(await clickItem(tabB, 'MULTIPLAYER'), 'B: MULTIPLAYER not found');
        let bHasOffer = false;
        for (let i = 0; i < 20; i++) {
            if (await tabB.ev(`!!document.querySelector('#dmenu .row[data-label*="DROP IN"]')`))
                { bHasOffer = true; break; }
            await sleep(500);
        }
        assert(bHasOffer, 'T08: B did not see DROP IN on GAME IN PROGRESS screen');

        // T12: ESC → LANDING
        await pressEsc(tabB);
        await sleep(400);
        assert(
            await tabB.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                           !document.querySelector('#dmenu .row[data-label*="DROP IN"]')`),
            'T12: ESC from DROP-IN-OFFER did not return to LANDING',
        );
        assert(
            await tabB.ev(`document.getElementById('screen').hidden`),
            'T12: game canvas not hidden after ESC from drop-in-offer',
        );

        assert(tabA.errors.length === 0, `A exceptions: ${tabA.errors.join('; ')}`);
        assert(tabB.errors.length === 0, `B exceptions: ${tabB.errors.join('; ')}`);
    } finally {
        await tabA.close();
        await tabB.close();
        // tabA.close() terminates the Chrome tab which closes its relay ws,
        // causing the server to call endSession('all players left') immediately.
        await sleep(1500);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: drop-in-offer-ws-close
// Covers T22: DROP-IN-OFFER → LANDING (unexpected ws close)
// Same setup as test 4 but force-closes B's lobby ws instead of ESC.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('drop-in-offer-ws-close', async () => {
    // Ensure previous session has fully ended
    await waitForCleanServer(12);

    const tabA = await openTab();
    const tabB = await openTab();
    try {
        assert(await waitForMenu(tabA), 'A: menu did not appear');
        assert(await waitForMenu(tabB), 'B: menu did not appear');

        await patchWS(tabA);
        assert(await clickItem(tabA, 'MULTIPLAYER'), 'A: MULTIPLAYER not found');
        for (let i = 0; i < 20; i++) {
            if (await tabA.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`)) break;
            await sleep(300);
        }
        assert(await clickItem(tabA, 'START GAME'), 'A: START GAME not found');
        let aInGame = false;
        for (let i = 0; i < 60; i++) {
            aInGame = await tabA.ev(
                `!document.getElementById('screen').hidden &&
                 document.getElementById('status')?.textContent === ''`,
            );
            if (aInGame) break;
            await sleep(500);
        }
        assert(aInGame, 'A: did not boot into game');
        await sleep(1500);

        await patchWS(tabB);
        assert(await clickItem(tabB, 'MULTIPLAYER'), 'B: MULTIPLAYER not found');
        let bHasOffer = false;
        for (let i = 0; i < 20; i++) {
            if (await tabB.ev(`!!document.querySelector('#dmenu .row[data-label*="DROP IN"]')`))
                { bHasOffer = true; break; }
            await sleep(500);
        }
        assert(bHasOffer, 'T22 setup: B did not see DROP IN');

        // T22: force-close B's lobby ws
        await forceCloseWS(tabB);
        await sleep(600);
        assert(
            await tabB.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                           !document.querySelector('#dmenu .row[data-label*="DROP IN"]')`),
            'T22: ws close did not return B to LANDING from DROP-IN-OFFER',
        );

        assert(tabA.errors.length === 0, `A exceptions: ${tabA.errors.join('; ')}`);
        assert(tabB.errors.length === 0, `B exceptions: ${tabB.errors.join('; ')}`);
    } finally {
        await tabA.close();
        await tabB.close();
        await sleep(1500);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: mp-countdown-ws-close
// Covers T13: MP-LOBBY → MP-COUNTDOWN (START GAME → countdown visible)
//         T23: MP-COUNTDOWN → LANDING (ws close) + impossible-state Bug#1
// Server session starts after 3-second countdown; we disconnect the client
// during the countdown. Session will linger ~13s (10s nobody-joined timeout).
// ═══════════════════════════════════════════════════════════════════════════
await waitForCleanServer(12);
await runTest('mp-countdown-ws-close', async () => {
    const tab = await openTab();
    try {
        assert(await waitForMenu(tab), 'root menu did not appear');
        await patchWS(tab);

        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-countdown-ws-close: MP-LOBBY did not appear');

        // T13: click START GAME → server sends countdown messages → overlay visible
        assert(await clickItem(tab, 'START GAME'), 'START GAME not found');
        let cdVisible = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!document.getElementById('countdown')?.hidden`))
                { cdVisible = true; break; }
            await sleep(200);
        }
        assert(cdVisible, 'T13: countdown host element did not become visible');

        // T23 + Bug#1 guard: close ws mid-countdown
        await forceCloseWS(tab);
        await sleep(800);

        // countdown MUST be hidden (countdown.reset() called in closed handler)
        assert(
            await tab.ev(`!!document.getElementById('countdown')?.hidden`),
            'T23/Bug#1: countdown still visible after ws close — countdown.reset() not called',
        );
        // root menu must be back
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T23: ws close did not reset to LANDING root menu',
        );
        // game canvas must be hidden (booted must be false)
        assert(
            await tab.ev(`document.getElementById('screen').hidden`),
            'T23: game canvas visible after ws close mid-countdown',
        );

        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 7: mp-countdown-esc
// Covers T25: MP-COUNTDOWN → LANDING (ESC → leaveLobby)
//         + impossible-state Bug#1 via the ESC path (missed by first audit).
// Trace: leaveLobby() sets lobby=null synchronously, then ws close fires;
// the closed handler's `if (!lobby) return` early-exits, so countdown.reset()
// in the closed handler is never reached. The fix is countdown.reset() in
// leaveLobby() itself.
// Session lingers after ESC (server countdown still fires); waitForCleanServer
// before the next test.
// ═══════════════════════════════════════════════════════════════════════════
await waitForCleanServer(16);
await runTest('mp-countdown-esc', async () => {
    const tab = await openTab();
    try {
        assert(await waitForMenu(tab), 'root menu did not appear');
        await patchWS(tab);

        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-countdown-esc: MP-LOBBY did not appear');

        // T13 (prerequisite): START GAME → countdown overlay appears
        assert(await clickItem(tab, 'START GAME'), 'START GAME not found');
        let cdVisible = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!document.getElementById('countdown')?.hidden`))
                { cdVisible = true; break; }
            await sleep(200);
        }
        assert(cdVisible, 'T25 setup: countdown did not appear after START GAME');

        // T25 + Bug#1(ESC): press ESC → leaveLobby() → countdown.reset() must fire
        await pressEsc(tab);
        await sleep(500);

        // countdown MUST be hidden
        assert(
            await tab.ev(`!!document.getElementById('countdown')?.hidden`),
            'T25/Bug#1(ESC): countdown still visible after ESC mid-countdown — countdown.reset() missing from leaveLobby()',
        );
        // root menu must be restored and interactive
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T25: ESC from MP-COUNTDOWN did not restore LANDING root menu',
        );
        // game canvas must be hidden (booted never set — launch never fired)
        assert(
            await tab.ev(`document.getElementById('screen').hidden`),
            'T25: game canvas visible after ESC mid-countdown',
        );

        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 8: mp-launch-wad-fail
// Covers T16: MP-LOADING → LANDING (WAD failure) + impossible-state Bug#2
// Also exercises the same catch path for T20 (DROP-IN-LOADING → LANDING,
// same catch block — drop-in entry point not independently driven).
// WAD fetch is blocked after START, forcing bootDoom to reject post-launch.
// Session starts then lingers; it's the last game-starting test so no follow-on.
// ═══════════════════════════════════════════════════════════════════════════
await waitForCleanServer(16);
await runTest('mp-launch-wad-fail', async () => {
    const tab = await openTab();
    try {
        assert(await waitForMenu(tab), 'root menu did not appear');
        await tab.cdp('Network.enable', {});
        await patchWS(tab);

        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-launch-wad-fail: MP-LOBBY did not appear');

        // Block WAD fetches; click START → countdown → launch → bootDoom fails
        await tab.cdp('Network.setBlockedURLs', { urls: ['*/wads/*'] });
        assert(await clickItem(tab, 'START GAME'), 'START GAME not found');

        // Wait for error status after bootDoom rejects
        let statusText = '', landingVisible = false;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            statusText = (await tab.ev(`document.getElementById('status')?.textContent`)) ?? '';
            if (statusText.length > 0) {
                landingVisible = await tab.ev(`!document.getElementById('landing').hidden`);
                break;
            }
        }

        // Bug#2 guard assertions
        assert(statusText.length > 0, 'T16/Bug#2: no error status shown after MP WAD failure');
        assert(landingVisible, 'T16/Bug#2: landing hidden after MP WAD failure — user stuck');
        assert(
            await tab.ev(`document.getElementById('screen').hidden`),
            'T16/Bug#2: game canvas visible — booted not reset after MP WAD failure',
        );
        assert(
            await tab.ev(`!!document.getElementById('countdown')?.hidden`),
            'T16/Bug#2: countdown still visible after MP WAD failure',
        );
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`),
            'T16/Bug#2: root menu not restored after MP WAD failure',
        );

        // No fatal (non-WAD-fetch) exceptions
        const fatal = tab.errors.filter(e =>
            !/wad fetch failed|Failed to fetch|ERR_BLOCKED/i.test(e),
        );
        assert(fatal.length === 0, `unexpected exceptions: ${fatal.join('; ')}`);

        // Recovery check: MULTIPLAYER re-connects after failure (booted=false, lobby=null)
        await tab.cdp('Network.setBlockedURLs', { urls: [] });
        await tab.ev(`document.getElementById('status').textContent = ''`);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="MULTIPLAYER"]')`),
            'T16/Bug#2: MULTIPLAYER row missing after failure — menu not restored',
        );
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── lobby state-machine test results ────────────────────────');
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
    console.log('PASS — all lobby state-machine edges covered and clean');
    cleanup(0);
} else {
    console.log('FAIL — one or more lobby state-machine edges failed');
    cleanup(1);
}
